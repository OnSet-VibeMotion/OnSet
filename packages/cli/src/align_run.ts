import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as align from '@onset/engine/align';
import * as voicecheck from '@onset/engine/voicecheck';
import * as mediaprobe from '@onset/engine/mediaprobe';
import { readCues } from '@onset/engine/srt';
import { sceneCanvas, newScene } from '@onset/engine/scene';
import { windowsPython, envMap } from '@onset/engine/envutil';
import { marshalIndent } from '@onset/engine/gojson';
import { start } from '@onset/engine/procgroup';
import { FunASRTimestampModel, load as loadConfig, QwenForcedAligner } from '@onset/engine/config';
import { modelDir, type ModelSpec } from '@onset/engine/toolinstall';
import { findOptional } from '@onset/engine/toolpath';
import { bool, str, num, projectRoot } from './ops/common';
import type { Op } from './ops/op';
import {loadWindowsAlignmentSegments,verifyWindowsAlignmentSegments,windowsSegmentPython} from './windows_alignment_segments';

const pythonSource = `import json,sys,time,pkgutil,os
from pathlib import Path
started=time.monotonic()
# FunASR 1.4.x 默认递归导入训练、服务器和所有模型。时间戳任务只注册本地模型所需组件。
# 限定这一次包初始化的目录枚举；标准 Python 导入、实际模型与校验均保留，退出即恢复枚举器。
modules=['funasr.frontends.wav_frontend','funasr.tokenizer.char_tokenizer','funasr.models.sanm.encoder','funasr.models.bicif_paraformer.cif_predictor','funasr.models.specaug.specaug','funasr.models.monotonic_aligner.model','funasr.auto.auto_model']
original=pkgutil.walk_packages
def timestamp_modules(path=None,prefix='',onerror=None):
 if prefix=='funasr.':
  for name in modules:yield pkgutil.ModuleInfo(None,name,False)
 else:yield from original(path,prefix,onerror)
os.environ['FUNASR_STRICT_IMPORT']='1'
pkgutil.walk_packages=timestamp_modules
try:from funasr import AutoModel
finally:pkgutil.walk_packages=original
print('onset_import_seconds='+str(time.monotonic()-started),flush=True)
model=AutoModel(model=sys.argv[1],disable_update=True,device='cpu')
result=model.generate(input=(sys.argv[2],Path(sys.argv[3]).read_text(encoding='utf-8')),data_type=('sound','text'))
with open(sys.argv[4],'x',encoding='utf-8') as output:
 json.dump(result,output,ensure_ascii=False)
print('onset_python_seconds='+str(time.monotonic()-started),flush=True)
`;
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (file: string, value: unknown) => fs.writeFileSync(file, marshalIndent(value) + '\n');

export function normalizeWindowsAlignmentText(text: string): string {
  const normalized = text.replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim();
  const spoken = (value: string) => value.replace(/[\p{P}\s]/gu, '');
  if (!normalized || spoken(normalized) !== spoken(text)) throw Error('对齐文本的朗读字符发生变化');
  return normalized;
}

function inputPath(root: string, relative: string): string {
  const file = path.resolve(root, relative), real = fs.realpathSync(file), rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|[\\/])\.(?:env|git|codex)(?:[.\\/]|$)/i.test(rel)) throw Error('对齐输入必须是项目内的非凭据文件');
  if (!fs.statSync(real).isFile()) throw Error('对齐输入必须是普通文件');
  return real;
}

export function localAlignmentModel(env: Record<string, string>, spec: ModelSpec = FunASRTimestampModel): string {
  for (const model of [env.ALIGN_MODEL, modelDir(spec, env)]) {
    if (model && path.isAbsolute(model) && spec.files.every(({ path: name }) => {
      try {return fs.statSync(path.join(model,name)).isFile();} catch {return false;}
    })) return fs.realpathSync(model);
  }
  throw Error('本地对齐模型不完整，请在工具准备页修复；本操作不会下载或访问个人缓存');
}

function alignmentRunner(provider: 'funasr' | 'mlx', env: Record<string, string>) {
  if (provider === 'mlx') {
    const command = findOptional('mlx_audio.stt.generate', env);
    if (!command) throw Error('缺少已准备的 MLX 对齐工具，请在工具准备页修复');
    return { command, fingerprint: sha(command) };
  }
  if (process.platform !== 'win32') {
    const command = findOptional('funasr-python', env);
    if (!command) throw Error('缺少已准备的 FunASR Python 环境，请在工具准备页修复');
    return { command, fingerprint: sha(command) };
  }
  const command = windowsPython(env);
  const init = path.resolve(path.dirname(command), '../Lib/site-packages/funasr/__init__.py');
  if (!command || !fs.existsSync(init)) throw Error('缺少已准备的 FunASR Python 环境，请在工具准备页修复');
  return { command, fingerprint: sha(init) };
}

/** 一次模型调用、一次映射、一次独立能量校验；所有新产物留在带输入指纹的候选目录。 */
export function alignRunOperation(legacyWindows = false): Op {
  return {
    name: legacyWindows ? 'windows_align' : 'align_run',
    cli: legacyWindows ? ['windows', 'align'] : ['align', 'run'],
    summary:'用本地模型生成并校验字幕和短语时间轴',
    examples: legacyWindows ? ['windows_align()', 'windows_align({"publish":true})'] : ['align_run()', 'align_run({"publish":true})'],
    description: `读取确认的配音与终稿，按项目配置使用已安装的 MLX 或 FunASR。已有可信字级结果时用 evidence，直接映射并独立校验。按输入摘要复用已验证候选。失败返回诊断，同一输入默认不重试。首次生成可用 publish=true 写入规范路径；已有规范输出或已确认分镜时生成候选。

长配音的 MLX 单次对齐遇到长度限制时，可按实际静音和朗读文本切段。用工具准备页安装的 mlx_audio.stt.generate 对段音频执行本地对齐，传 --model 本地模型目录、--audio 16kHz 单声道 WAV、--text 对应朗读文本、--language Chinese、--output-path 不带扩展名的路径及 --format json。在 align_build() 里按段给出 JSON 与实测偏移，再独立校验整条配音。`,
    params: {
      project_root: projectRoot,
      audio: { type: 'string', default: 'production/audio/voice.wav', description: '确认的配音，项目内相对路径' },
      script: { type: 'string', default: 'production/script-final.md', description: '确认的终稿' },
      ...(!legacyWindows ? { evidence: { type: 'string' as const, description: '现成的字级时间戳 JSON，例如 ElevenLabs 或第三方对齐器的产物' } } : {}),
      segments_manifest: { type: 'string', description: 'FunASR 可用的原始 PCM16 TTS 分段清单。顶层包含 schema=1、audio_sha256、script_sha256、sample_rate、segments；每段给出 audio、sha256、text、start_sample、end_sample_exclusive。逐样本校验拼接后，按原采样边界合并结果。' },
      retry: { type: 'boolean', description: '修复原因后显式重试失败输入' },
      publish: { type: 'boolean', description: '首次生成时写入规范路径，已有文件保持原样' },
      timeout_seconds: { type: 'number', default: 180, description: '模型超时（10–600 秒）' },
    },
    run:async(p,ctx)=>{
      const operationStarted=performance.now();
      if (legacyWindows && process.platform !== 'win32') throw Error('此操作仅用于 Windows');
      const root=fs.realpathSync(str(p.project_root)),env=envMap();
      const audio=inputPath(root,str(p.audio)||'production/audio/voice.wav'),scriptFile=inputPath(root,str(p.script)||'production/script-final.md');
      const evidence = str(p.evidence) ? inputPath(root, str(p.evidence)) : null;
      const evidenceSHA = evidence ? sha(evidence) : null;
      const provider = evidence ? 'evidence' : legacyWindows ? 'funasr' : loadConfig(root, env).alignProvider;
      if (provider !== 'mlx' && provider !== 'funasr' && provider !== 'evidence') throw Error('请调用项目配置的第三方对齐工具，再把字级结果传给 align_run() 的 evidence');
      const modelSpec = provider === 'mlx' ? QwenForcedAligner : FunASRTimestampModel;
      const model = provider === 'evidence' ? '' : localAlignmentModel(env, modelSpec);
      const runner = provider === 'evidence' ? null : alignmentRunner(provider, env);
      const fps=sceneCanvas(newScene({directory:root})).fps;
      const script=align.loadProjectScript(root,scriptFile),text=provider === 'funasr' ? normalizeWindowsAlignmentText(script.alignText()) : script.alignText();
      if (!text.trim()) throw Error('终稿没有任何朗读内容');
      const segmentFile=str(p.segments_manifest)?inputPath(root,str(p.segments_manifest)):null;
      if (segmentFile && provider !== 'funasr') throw Error('原始 TTS 分段清单仅用于 FunASR 模型对齐');
      const segments=segmentFile?loadWindowsAlignmentSegments(segmentFile,audio,scriptFile,text,relative=>inputPath(root,relative)):null;
      const segmentsManifestSHA = segmentFile ? sha(segmentFile) : null;
      const source=segments?pythonSource.slice(0,pythonSource.indexOf('result=model.generate('))+windowsSegmentPython:pythonSource;
      const seconds=num(p.timeout_seconds)||180;
      if(!Number.isFinite(seconds)||seconds<10||seconds>600)throw Error('timeout_seconds 必须在 10..600 秒之间');
      // 保留 Windows FunASR 的缓存键，旧版已经校验过的候选可直接取用。
      const modelFiles = provider === 'funasr'
        ? ['model.pt','config.yaml','tokens.json','am.mvn','seg_dict','configuration.json']
        : modelSpec.files.map(file => file.path);
      const inputs={audio:sha(audio),script:sha(scriptFile),fps,model,modelFiles:runner ? modelFiles.map(name=>{const s=fs.statSync(path.join(model,name));return [name,s.size,s.mtimeMs];}) : [],python:runner?.command,runner:runner?.fingerprint,pipeline:1};
      if (script.speakers.size) Object.assign(inputs, { dialogue: true });
      const existingTimeline=path.join(root,'production/phrase-timeline.json'),adjust=path.join(root,'production/phrase-adjust.json');
      if(fs.existsSync(existingTimeline))inputPath(root,path.relative(root,existingTimeline));
      if(fs.existsSync(adjust))inputPath(root,path.relative(root,adjust));
      const review=(align.loadExistingTimeline(existingTimeline)?.phrases??[]).filter(phrase=>phrase.reviewed||(phrase.visible_event_ids??[]).length).map(phrase=>({id:phrase.phrase_id,reviewed:phrase.reviewed,events:phrase.visible_event_ids}));
      Object.assign(inputs,{existingReview:review,adjust:fs.existsSync(adjust)?sha(adjust):null,checks:voicecheck.Defaults});
      if (provider === 'evidence') Object.assign(inputs, { pipeline: 6, evidenceSHA });
      else if (provider === 'mlx') Object.assign(inputs, { pipeline: 5, provider });
      else Object.assign(inputs, { pipeline: segments ? 4 : 3, pythonSource: crypto.createHash('sha256').update(source).digest('hex'), ...(segments ? { segmentsManifest: segmentsManifestSHA, segments } : {}) });
      const digest=crypto.createHash('sha256').update(marshalIndent(inputs)).digest('hex');
      const base=path.join(root,'production/audio/alignment-runs',digest);
      // 不允许已有目录链接把输出引向项目外。
      for(let dir=path.dirname(base);dir!==root;dir=path.dirname(dir)) if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('候选目录不能经过链接');
      if(fs.existsSync(base)&&fs.lstatSync(base).isSymbolicLink())throw Error('候选目录不能是链接');
      fs.mkdirSync(base,{recursive:true});
      const manifest=path.join(base,'verified.json'),failure=path.join(base,'failure.json');
      let cached: Record<string,any>|null=null;
      if(fs.existsSync(manifest)){
        const data=JSON.parse(fs.readFileSync(manifest,'utf8'));
        const keys=['align','srt','phrases','report','audio_check'];
        if(data.digest===digest&&data.paths&&data.hashes&&keys.every(key=>typeof data.paths[key]==='string'&&Object.hasOwn(data.hashes,data.paths[key]))&&Object.entries(data.hashes as Record<string,string>).every(([file,hash])=>!path.isAbsolute(file)&&sha(inputPath(base,file))===hash)) {
          cached={...data,attempt:path.dirname(inputPath(base,data.paths.align)),paths:Object.fromEntries(keys.map(key=>[key,inputPath(base,data.paths[key])])),hashes:Object.fromEntries(Object.entries(data.hashes).map(([file,hash])=>[inputPath(base,file),hash]))};
        }
        else throw Error('已验证候选产物发生变化，保留现场；请检查输入与候选目录');
      }
      const reused=cached!==null;
      if(!cached&&fs.existsSync(failure)&&!bool(p.retry))throw Error('同一输入此前失败，已停止重复试错。诊断：'+failure+'；修复原因后才用 retry=true');
      if(!cached){
        const lock=path.join(base,'running.lock');let fd:number;
        try{fd=fs.openSync(lock,'wx');}catch(error){
          if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
          let stale=false;
          if(bool(p.retry))try{const owner=JSON.parse(fs.readFileSync(lock,'utf8'));if(Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){stale=(e as NodeJS.ErrnoException).code==='ESRCH';}}}catch{/* 不清理归属不明的锁。 */}
          if(!stale)throw Error('同一输入已有任务或待诊断的锁，请等待原任务，勿重复提交：'+base);
          fs.unlinkSync(lock);fd=fs.openSync(lock,'wx');
        }
        let attempt = '';
        const started=performance.now();let phase='prepare';
        try{
          fs.writeFileSync(fd,marshalIndent({pid:process.pid,started_at:new Date().toISOString()}));
          attempt = fs.mkdtempSync(path.join(base, 'attempt-'));
          ctx.out.write(evidence ? '对齐：使用已有字级时间戳并做独立校验\n' : segments ? '对齐：核对原始分段拼接后逐段对齐\n' : `对齐：${provider} 本地模型，完成后独立校验\n`);
          const wav=path.join(attempt,'voice-16k.wav'),textFile=path.join(attempt,'normalized.txt'),scriptPath=path.join(attempt,'align.py'),raw=path.join(attempt,'align.json');
          const chain=mediaprobe.newToolchain(env);
          const requests=path.join(attempt,'segments.json');
          if (evidence) {
            fs.copyFileSync(evidence, raw, fs.constants.COPYFILE_EXCL);
            if (sha(raw) !== evidenceSHA) throw Error('字级证据在读取时发生变化');
          }
          if (runner) {
            await chain.decodeAnalysisWAV(audio,wav,16000,ctx.signal);
            if(segments)json(requests,segments);
            let args: string[];
            if (provider === 'mlx') {
              args = ['--model', model, '--audio', wav, '--text', text, '--language', 'Chinese', '--output-path', raw.slice(0, -5), '--format', 'json'];
            } else {
              fs.writeFileSync(textFile,text+'\n');fs.writeFileSync(scriptPath,source);
              args = [scriptPath,model,segments?audio:wav,textFile,raw,...(segments?[requests]:[])];
            }
            phase='model';
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.ceil(seconds * 1000))]);
            const log=fs.openSync(path.join(attempt,'python.log'),'wx');
            try{const child=await start(runner.command,args,{cwd:root,env:{...env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'1'},stdio:['ignore',log,log],signal});await child.wait();}
            finally{fs.closeSync(log);}
          }
          phase='build';const result=align.build(script,align.loadEvidence(raw),{fps,existing:align.loadExistingTimeline(existingTimeline),adjust:fs.existsSync(adjust)?align.loadAdjust(adjust):null});
          const srt=path.join(attempt,'voice.srt'),phrases=path.join(attempt,'phrase-timeline.json'),report=path.join(attempt,'align-report.json'),checkFile=path.join(attempt,'audio-check.json');
          align.writeSRT(srt,result.cues);align.writeJSON(phrases,align.timelineToJSON(result.timeline));align.writeJSON(report,align.reportToJSON(result.report));
          if(!result.report.ok)throw Error('朗读单元映射失败：'+report);
          if(segments&&(result.report.match_rate!==1||result.report.interpolated_tokens!==0))throw Error('真实分段必须与终稿完整匹配且没有插值：'+report);
          phase='audio_check';const options=voicecheck.Defaults,levels=chain.loudness(audio,options.window),[speech,threshold]=voicecheck.speech(levels,options);
          const check=voicecheck.check(readCues(srt),speech,threshold,options);voicecheck.writeReportJSON(check,checkFile);
          if(!check.ok)throw Error('独立音频校验未通过：'+(check.problems??[]).join('；')+'；诊断：'+checkFile);
          if(sha(audio)!==inputs.audio||sha(scriptFile)!==inputs.script||segmentFile&&sha(segmentFile)!==segmentsManifestSHA||evidence&&sha(evidence)!==evidenceSHA)throw Error('对齐过程中输入发生变化，候选不能发布');
          if(segments)verifyWindowsAlignmentSegments(segments);
          cached={digest,inputs,attempt,seconds:(performance.now()-started)/1000,summary:{tokens:result.report.tokens,cues:result.cues.length,total_frames:result.report.total_frames,match_rate:result.report.match_rate},paths:{align:raw,srt,phrases,report,audio_check:checkFile},hashes:Object.fromEntries([raw,srt,phrases,report,checkFile,...(segments?[requests,...segments.segments.map((_,index)=>path.join(attempt,'segment-'+index+'.json'))]:[])].map(file=>[file,sha(file)]))};
          json(manifest,{...cached,attempt:path.relative(base,attempt),paths:Object.fromEntries(Object.entries(cached.paths as Record<string,string>).map(([key,file])=>[key,path.relative(base,file)])),hashes:Object.fromEntries(Object.entries(cached.hashes as Record<string,string>).map(([file,hash])=>[path.relative(base,file),hash]))});ctx.out.write(`对齐及校验完成：${cached.seconds.toFixed(2)} 秒，候选位于 ${attempt}\n`);
        }catch(error){json(failure,{phase,attempt,seconds:(performance.now()-started)/1000,error:(error as Error).message});throw Error(`对齐失败（${phase}），保留原配音和字幕，不自动重跑。诊断：${failure}；${(error as Error).message}`);}
        finally{fs.closeSync(fd);fs.unlinkSync(lock);}
      }else ctx.out.write('输入与候选摘要一致，复用已通过独立校验的结果，不再启动模型\n');
      if(sha(audio)!==inputs.audio||sha(scriptFile)!==inputs.script||evidence&&sha(evidence)!==evidenceSHA)throw Error('输入已变化，候选不能用于当前制作');
      if(segments){if(sha(segmentFile!)!==segmentsManifestSHA)throw Error('分段清单已变化，候选不能用于当前制作');verifyWindowsAlignmentSegments(segments);}
      ctx.signal.throwIfAborted();
      let published=false;
      if(bool(p.publish)){
        const production=path.join(root,'production');
        if(fs.readdirSync(production).some(name=>/(?:storyboard|scene|shot)[-_]approval.*\.json$/i.test(name)))throw Error('已有确认的分镜或镜头，保留规范输入，仅返回候选');
        const approvals=path.join(root,'production/approvals'),scenes=path.join(root,'scenes');
        if(fs.existsSync(approvals)&&fs.readdirSync(approvals).some(name=>/storyboard|scene|shot/i.test(name))||fs.existsSync(scenes)&&fs.readdirSync(scenes).some(id=>fs.existsSync(path.join(scenes,id,'.onset-render.json'))))throw Error('已有确认的分镜或镜头，保留规范输入，仅返回候选');
        const targets: Array<[string,string]>=[[cached!.paths.align,'production/audio/align.json'],[cached!.paths.srt,'production/audio/voice.srt'],[cached!.paths.phrases,'production/phrase-timeline.json'],[cached!.paths.report,'production/audio/align-report.json']];
        if (legacyWindows) targets.push([cached!.paths.srt, 'transcription-production.srt']);
        else targets.push([cached!.paths.audio_check, 'production/audio/voice-check.json']);
        if(fs.existsSync(path.join(root,'transcription-production.srt')) || targets.some(([,rel])=>fs.existsSync(path.join(root,rel))))throw Error('已有规范输出，保留原文件，仅返回已验证候选：'+manifest);
        const created:string[]=[];
        try{for(const [source,relative]of targets){const target=path.join(root,relative);fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);created.push(target);}published=true;}
        catch(error){for(const file of created)fs.unlinkSync(file);throw error;}
      }
      return {data:{verified:true,...cached!.summary,paths:cached!.paths,elapsed_seconds:(performance.now()-operationStarted)/1000,generation_seconds:cached!.seconds,reused,published,manifest}};
    }
  };
}

export function windowsAlignOperation(): Op {
  return alignRunOperation(true);
}
