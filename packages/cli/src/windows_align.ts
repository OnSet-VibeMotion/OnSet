import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as align from '@onset/engine/align';
import * as voicecheck from '@onset/engine/voicecheck';
import * as mediaprobe from '@onset/engine/mediaprobe';
import { readCues } from '@onset/engine/srt';
import { sceneCanvas, newScene } from '@onset/engine/scene';
import { dataDir, windowsPython, envMap } from '@onset/engine/envutil';
import { marshalIndent } from '@onset/engine/gojson';
import { start } from '@onset/engine/procgroup';
import { bool, str, num, projectRoot } from './ops/common';
import type { Op } from './ops/op';

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

export function localAlignmentModel(env: Record<string, string>): string {
  for (const model of [env.ALIGN_MODEL, path.join(dataDir(env), 'models/iic__speech_timestamp_prediction-v1-16k-offline')]) {
    if (model && path.isAbsolute(model) && ['am.mvn','config.yaml','configuration.json','model.pt','seg_dict','tokens.json'].every(name => {
      try {return fs.statSync(path.join(model,name)).isFile();} catch {return false;}
    })) return fs.realpathSync(model);
  }
  throw Error('本地对齐模型不完整，请在工具准备页修复；本操作不会下载或访问个人缓存');
}

/** 一次模型调用、一次映射、一次独立能量校验；所有新产物留在带输入指纹的候选目录。 */
export function windowsAlignOperation(): Op {
  return {
    name:'windows_align',cli:['windows','align'],summary:'使用本地模型一次生成并校验 Windows 字幕时间轴',
    description:'规范标点但保留原稿朗读字符，使用已安装模型和 FunASR，不下载、不检查更新。一次生成、映射与独立 audio_check；按输入摘要复用已验证结果。失败保留日志并停止，同一失败输入默认不重试。所有结果写入独立候选目录，不覆盖配音、原稿、分镜、已有字幕或镜头。新项目可 publish=true，仅当规范输出全部不存在且没有已确认分镜/成片时发布。',
    params:{project_root:projectRoot,audio:{type:'string',default:'production/audio/voice.wav',description:'已确认的配音，项目内相对路径'},script:{type:'string',default:'production/script-final.md',description:'已确认的终稿'},retry:{type:'boolean',description:'诊断并修复原因后显式重试失败输入；不重复已验证的成功结果'},publish:{type:'boolean',description:'只向不存在的规范输出发布；已有文件及已确认的分镜/镜头始终保留'},timeout_seconds:{type:'number',default:180,description:'Python 对齐超时，10..600 秒；超时结束本操作的进程树'}},
    run:async(p,ctx)=>{
      const operationStarted=performance.now();
      if (process.platform !== 'win32') throw Error('此操作仅用于 Windows');
      const root=fs.realpathSync(str(p.project_root)),env=envMap();
      const audio=inputPath(root,str(p.audio)||'production/audio/voice.wav'),scriptFile=inputPath(root,str(p.script)||'production/script-final.md');
      const model=localAlignmentModel(env),python=windowsPython(env);
      if (!python || !fs.existsSync(path.resolve(path.dirname(python),'../Lib/site-packages/funasr/__init__.py'))) throw Error('缺少已准备的 FunASR Python 环境，请在工具准备页修复');
      const fps=sceneCanvas(newScene({directory:root})).fps;
      const script=align.loadScript(scriptFile),text=normalizeWindowsAlignmentText(script.alignText());
      const seconds=num(p.timeout_seconds)||180;
      if(seconds<10||seconds>600)throw Error('timeout_seconds 必须在 10..600 秒之间');
      const inputs={audio:sha(audio),script:sha(scriptFile),fps,model,modelFiles:['model.pt','config.yaml','tokens.json','am.mvn','seg_dict','configuration.json'].map(name=>{const s=fs.statSync(path.join(model,name));return [name,s.size,s.mtimeMs];}),python,runner:sha(path.resolve(path.dirname(python),'../Lib/site-packages/funasr/__init__.py')),pipeline:1};
      const existingTimeline=path.join(root,'production/phrase-timeline.json'),adjust=path.join(root,'production/phrase-adjust.json');
      if(fs.existsSync(existingTimeline))inputPath(root,path.relative(root,existingTimeline));
      if(fs.existsSync(adjust))inputPath(root,path.relative(root,adjust));
      const review=(align.loadExistingTimeline(existingTimeline)?.phrases??[]).filter(phrase=>phrase.reviewed||(phrase.visible_event_ids??[]).length).map(phrase=>({id:phrase.phrase_id,reviewed:phrase.reviewed,events:phrase.visible_event_ids}));
      Object.assign(inputs,{existingReview:review,adjust:fs.existsSync(adjust)?sha(adjust):null,checks:voicecheck.Defaults});
      Object.assign(inputs,{pipeline:3,pythonSource:crypto.createHash('sha256').update(pythonSource).digest('hex')});
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
        const attempt=path.join(base,'attempt-'+Date.now());
        const started=performance.now();let phase='prepare';
        try{
          fs.writeFileSync(fd,marshalIndent({pid:process.pid,started_at:new Date().toISOString()}));fs.mkdirSync(attempt);
          ctx.out.write('Windows 对齐：本地模型；规范标点；单次对齐与独立校验\n');
          const wav=path.join(attempt,'voice-16k.wav'),textFile=path.join(attempt,'normalized.txt'),runner=path.join(attempt,'align.py'),raw=path.join(attempt,'align.json');
          fs.writeFileSync(textFile,text+'\n');fs.writeFileSync(runner,pythonSource);
          const chain=mediaprobe.newToolchain(env);await chain.decodeAnalysisWAV(audio,wav,16000,ctx.signal);
          phase='model';const controller=new AbortController();const abort=()=>controller.abort();ctx.signal.addEventListener('abort',abort,{once:true});if(ctx.signal.aborted)abort();
          const timer=setTimeout(abort,seconds*1000),log=fs.openSync(path.join(attempt,'python.log'),'wx');
          try{const child=await start(python,[runner,model,wav,textFile,raw],{cwd:root,env:{...env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'1'},stdio:['ignore',log,log],signal:controller.signal});await child.wait();}
          finally{clearTimeout(timer);ctx.signal.removeEventListener('abort',abort);fs.closeSync(log);}
          phase='build';const result=align.build(script,align.loadEvidence(raw),{fps,existing:align.loadExistingTimeline(existingTimeline),adjust:fs.existsSync(adjust)?align.loadAdjust(adjust):null});
          const srt=path.join(attempt,'voice.srt'),phrases=path.join(attempt,'phrase-timeline.json'),report=path.join(attempt,'align-report.json'),checkFile=path.join(attempt,'audio-check.json');
          align.writeSRT(srt,result.cues);align.writeJSON(phrases,align.timelineToJSON(result.timeline));align.writeJSON(report,align.reportToJSON(result.report));
          if(!result.report.ok)throw Error('朗读单元映射失败：'+report);
          phase='audio_check';const options=voicecheck.Defaults,levels=chain.loudness(audio,options.window),[speech,threshold]=voicecheck.speech(levels,options);
          const check=voicecheck.check(readCues(srt),speech,threshold,options);voicecheck.writeReportJSON(check,checkFile);
          if(!check.ok)throw Error('独立音频校验未通过：'+(check.problems??[]).join('；')+'；诊断：'+checkFile);
          if(sha(audio)!==inputs.audio||sha(scriptFile)!==inputs.script)throw Error('对齐过程中输入发生变化，候选不能发布');
          cached={digest,inputs,attempt,seconds:(performance.now()-started)/1000,summary:{tokens:result.report.tokens,cues:result.cues.length,total_frames:result.report.total_frames,match_rate:result.report.match_rate},paths:{align:raw,srt,phrases,report,audio_check:checkFile},hashes:Object.fromEntries([raw,srt,phrases,report,checkFile].map(file=>[file,sha(file)]))};
          json(manifest,{...cached,attempt:path.relative(base,attempt),paths:Object.fromEntries(Object.entries(cached.paths as Record<string,string>).map(([key,file])=>[key,path.relative(base,file)])),hashes:Object.fromEntries(Object.entries(cached.hashes as Record<string,string>).map(([file,hash])=>[path.relative(base,file),hash]))});ctx.out.write(`Windows 对齐及校验完成：${cached.seconds.toFixed(2)} 秒，候选位于 ${attempt}\n`);
        }catch(error){json(failure,{phase,attempt,seconds:(performance.now()-started)/1000,error:(error as Error).message});throw Error(`Windows 对齐失败（${phase}），保留原配音和字幕，不自动重跑。诊断：${failure}；${(error as Error).message}`);}
        finally{fs.closeSync(fd);fs.unlinkSync(lock);}
      }else ctx.out.write('输入与候选摘要一致，复用已通过独立校验的结果，不再启动模型\n');
      if(sha(audio)!==inputs.audio||sha(scriptFile)!==inputs.script)throw Error('输入已变化，候选不能用于当前制作');
      let published=false;
      if(bool(p.publish)){
        const production=path.join(root,'production');
        if(fs.readdirSync(production).some(name=>/(?:storyboard|scene|shot)[-_]approval.*\.json$/i.test(name)))throw Error('已有确认的分镜或镜头，保留规范输入，仅返回候选');
        const approvals=path.join(root,'production/approvals'),scenes=path.join(root,'scenes');
        if(fs.existsSync(approvals)&&fs.readdirSync(approvals).some(name=>/storyboard|scene|shot/i.test(name))||fs.existsSync(scenes)&&fs.readdirSync(scenes).some(id=>fs.existsSync(path.join(scenes,id,'.onset-render.json'))))throw Error('已有确认的分镜或镜头，保留规范输入，仅返回候选');
        const targets: Array<[string,string]>=[[cached!.paths.align,'production/audio/align.json'],[cached!.paths.srt,'production/audio/voice.srt'],[cached!.paths.srt,'transcription-production.srt'],[cached!.paths.phrases,'production/phrase-timeline.json'],[cached!.paths.report,'production/audio/align-report.json']];
        if(targets.some(([,rel])=>fs.existsSync(path.join(root,rel))))throw Error('已有规范输出，保留原文件，仅返回已验证候选：'+manifest);
        const created:string[]=[];
        try{for(const [source,relative]of targets){const target=path.join(root,relative);fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);created.push(target);}published=true;}
        catch(error){for(const file of created)fs.unlinkSync(file);throw error;}
      }
      return {data:{verified:true,...cached!.summary,paths:cached!.paths,elapsed_seconds:(performance.now()-operationStarted)/1000,generation_seconds:cached!.seconds,reused,published,manifest}};
    }
  };
}
