import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as align from '@onset/engine/align';
import * as voicecheck from '@onset/engine/voicecheck';
import * as mediaprobe from '@onset/engine/mediaprobe';
import { readCues } from '@onset/engine/srt';
import { sceneCanvas, newScene } from '@onset/engine/scene';
import { windowsPython, envMap } from '@onset/engine/envutil';
import { formatFixed } from '@onset/engine/gofmt';
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

/** 自动分段阈值与单段上限（秒）：超过阈值且存在匹配 TTS 段落报告时自动切段对齐并合并时间轴，避免 MLX 长音频越限或编排手写切分脚本。 */
export const AutoChunkThresholdSeconds = 180;
export const AutoChunkMaxSeconds = 150;

export interface AutoChunk {
  index: number;
  start: number;
  end: number;
  text: string;
}

interface TTSSegmentRecord {
  text?: unknown;
  start_seconds?: unknown;
  duration_seconds?: unknown;
  pause_after_ms?: unknown;
}

interface TTSReportRecord {
  duration_seconds?: unknown;
  segments?: unknown;
}

const spokenSignature = (value: string) => value.replace(/[\p{P}\s]+/gu, '');
const roundMs = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * 查找与当前音频和终稿严格匹配的 TTS 段落报告（<stem>.tts/report.json，或同目录任意 *.tts/report.json 且其 audio.wav 的 SHA-256 与当前音频一致）。
 * 只有当总时长和朗读字符序列完全匹配时才启用自动切段，避免拿旧 take 的报告错切。
 */
export function planTTSAutoChunks(
  audio: string,
  audioSHA: string,
  scriptAlignText: string,
  actualDuration: number,
  provider: 'funasr' | 'mlx',
  maxChunkSeconds: number,
  thresholdSeconds = AutoChunkThresholdSeconds,
): { reportFile: string; reportSHA: string; chunks: AutoChunk[] } | null {
  if (maxChunkSeconds <= 0 || actualDuration <= thresholdSeconds) return null;
  const dir = path.dirname(audio);
  const stem = audio.slice(0, audio.length - path.extname(audio).length);
  const candidates: string[] = [];
  const tryCandidate = (reportPath: string, wavPath: string) => {
    try {
      if (!fs.lstatSync(reportPath).isFile() || !fs.lstatSync(wavPath).isFile()) return;
      if (sha(wavPath) === audioSHA) candidates.push(reportPath);
    } catch {
      // 跳过不存在、符号链接或不可读的候选。
    }
  };
  const primaryDir = stem + '.tts';
  const primary = path.join(primaryDir, 'report.json');
  tryCandidate(primary, path.join(primaryDir, 'audio.wav'));
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.tts')) continue;
      const reportPath = path.join(dir, entry.name, 'report.json');
      if (reportPath === primary) continue;
      tryCandidate(reportPath, path.join(dir, entry.name, 'audio.wav'));
    }
  } catch {
    // 忽略目录枚举异常。
  }
  const wantSpoken = spokenSignature(scriptAlignText);
  if (!wantSpoken) return null;
  for (const reportFile of candidates) {
    let report: TTSReportRecord;
    try {
      if (fs.lstatSync(reportFile).isSymbolicLink()) continue;
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as TTSReportRecord;
    } catch {
      continue;
    }
    if (typeof report.duration_seconds !== 'number' || Math.abs(report.duration_seconds - actualDuration) > 0.25) continue;
    if (!Array.isArray(report.segments) || report.segments.length < 2) continue;
    const segs: Array<{ text: string; start: number; end: number; pauseSec: number }> = [];
    let valid = true;
    let prevEnd = 0;
    for (const raw of report.segments as TTSSegmentRecord[]) {
      if (typeof raw?.text !== 'string' || typeof raw.start_seconds !== 'number' || typeof raw.duration_seconds !== 'number') {
        valid = false;
        break;
      }
      if (!Number.isFinite(raw.start_seconds) || !Number.isFinite(raw.duration_seconds) || raw.start_seconds < prevEnd - 0.02 || raw.duration_seconds <= 0) {
        valid = false;
        break;
      }
      const end = raw.start_seconds + raw.duration_seconds;
      if (end > actualDuration + 0.25) {
        valid = false;
        break;
      }
      const pauseSec = typeof raw.pause_after_ms === 'number' && raw.pause_after_ms > 0 ? raw.pause_after_ms / 1000 : 0;
      const cleanText = align.stripVocalEvents(raw.text).trim();
      segs.push({ text: cleanText, start: raw.start_seconds, end: Math.min(end, actualDuration), pauseSec });
      prevEnd = end;
    }
    if (!valid || segs.length < 2) continue;
    if (spokenSignature(segs.map((s) => s.text).join('\n')) !== wantSpoken) continue;

    // 贪心合段：把相邻 TTS 段落拼成不超过 maxChunkSeconds 的切块，切点严格落在段落静音边界。
    const chunks: AutoChunk[] = [];
    let groupStart = segs[0]!.start;
    let groupEnd = segs[0]!.end;
    let groupTexts: string[] = [segs[0]!.text];
    let lastPause = segs[0]!.pauseSec;
    const flush = (nextStart: number | null) => {
      const paddedEnd = Math.min(
        actualDuration,
        nextStart !== null ? Math.min(groupEnd + lastPause / 2, nextStart) : actualDuration,
      );
      const joined = groupTexts.join('\n');
      const chunkText = provider === 'funasr' ? normalizeWindowsAlignmentText(joined) : joined;
      chunks.push({ index: chunks.length, start: roundMs(groupStart), end: roundMs(Math.max(paddedEnd, groupEnd)), text: chunkText });
    };
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i]!;
      if (seg.end - groupStart > maxChunkSeconds && groupTexts.length > 0) {
        flush(seg.start);
        groupStart = seg.start;
        groupEnd = seg.end;
        groupTexts = [seg.text];
        lastPause = seg.pauseSec;
      } else {
        groupEnd = seg.end;
        groupTexts.push(seg.text);
        lastPause = seg.pauseSec;
      }
    }
    flush(null);
    if (chunks.length >= 2) {
      return { reportFile, reportSHA: sha(reportFile), chunks };
    }
  }
  return null;
}

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

长配音（>180 秒）且存在与音频、终稿一致的 voice_synthesize() 段落报告（*.tts/report.json）时，本操作会自动按段落静音边界切段（默认每段 ≤150 秒）逐段对齐、平移合并时间轴并做整片独立校验，无需手工编写 Python 切分或拼接脚本。非内置配音的超长录音若需手切，仍可用 align_build() 按偏移合并。`,
    params: {
      project_root: projectRoot,
      audio: { type: 'string', default: 'production/audio/voice.wav', description: '确认的配音，项目内相对路径' },
      script: { type: 'string', default: 'production/script-final.md', description: '确认的终稿' },
      ...(!legacyWindows ? { evidence: { type: 'string' as const, description: '现成的字级时间戳 JSON，例如 ElevenLabs 或第三方对齐器的产物' } } : {}),
      segments_manifest: { type: 'string', description: 'FunASR 可用的原始 PCM16 TTS 分段清单。顶层包含 schema=1、audio_sha256、script_sha256、sample_rate、segments；每段给出 audio、sha256、text、start_sample、end_sample_exclusive。逐样本校验拼接后，按原采样边界合并结果。' },
      max_chunk_seconds: { type: 'number', default: AutoChunkMaxSeconds, description: `长配音自动切段的单段目标上限（秒，默认 ${AutoChunkMaxSeconds}；0 关闭自动切段）` },
      retry: { type: 'boolean', description: '修复原因后显式重试失败输入' },
      publish: { type: 'boolean', description: '首次生成时写入规范路径，已有文件保持原样' },
      timeout_seconds: { type: 'number', default: 180, description: '单次模型调用超时（10–600 秒）' },
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
      const maxChunkRaw = p.max_chunk_seconds === undefined ? AutoChunkMaxSeconds : num(p.max_chunk_seconds);
      if (!Number.isFinite(maxChunkRaw) || (maxChunkRaw !== 0 && (maxChunkRaw < 1 || maxChunkRaw > 600))) {
        throw Error('max_chunk_seconds 必须是 0 或 1..600 秒之间');
      }
      const thresholdEnv = Number(env.ONSET_ALIGN_AUTO_CHUNK_THRESHOLD_SECONDS ?? '');
      const autoChunkThreshold = Number.isFinite(thresholdEnv) && thresholdEnv > 0 ? thresholdEnv : AutoChunkThresholdSeconds;
      const audioSHA = sha(audio);
      const chainProbe = runner && !segments && maxChunkRaw > 0 ? mediaprobe.newToolchain(env).probe(audio) : null;
      const autoPlan = runner && !segments && chainProbe && Number.isFinite(chainProbe.duration_seconds)
        ? planTTSAutoChunks(audio, audioSHA, script.alignText(), chainProbe.duration_seconds, provider as 'funasr' | 'mlx', maxChunkRaw, autoChunkThreshold)
        : null;
      // 保留 Windows FunASR 的缓存键，旧版已经校验过的候选可直接取用。
      const modelFiles = provider === 'funasr'
        ? ['model.pt','config.yaml','tokens.json','am.mvn','seg_dict','configuration.json']
        : modelSpec.files.map(file => file.path);
      const inputs={audio:audioSHA,script:sha(scriptFile),fps,model,modelFiles:runner ? modelFiles.map(name=>{const s=fs.statSync(path.join(model,name));return [name,s.size,s.mtimeMs];}) : [],python:runner?.command,runner:runner?.fingerprint,pipeline:1};
      if (script.speakers.size) Object.assign(inputs, { dialogue: true });
      const existingTimeline=path.join(root,'production/phrase-timeline.json'),adjust=path.join(root,'production/phrase-adjust.json');
      if(fs.existsSync(existingTimeline))inputPath(root,path.relative(root,existingTimeline));
      if(fs.existsSync(adjust))inputPath(root,path.relative(root,adjust));
      const review=(align.loadExistingTimeline(existingTimeline)?.phrases??[]).filter(phrase=>phrase.reviewed||(phrase.visible_event_ids??[]).length).map(phrase=>({id:phrase.phrase_id,reviewed:phrase.reviewed,events:phrase.visible_event_ids}));
      Object.assign(inputs,{existingReview:review,adjust:fs.existsSync(adjust)?sha(adjust):null,checks:voicecheck.Defaults});
      if (provider === 'evidence') Object.assign(inputs, { pipeline: 6, evidenceSHA });
      else if (provider === 'mlx') Object.assign(inputs, { pipeline: 5, provider, ...(autoPlan ? { autoChunks: { reportSHA: autoPlan.reportSHA, chunks: autoPlan.chunks.length, maxChunkSeconds: maxChunkRaw } } : {}) });
      else Object.assign(inputs, { pipeline: segments ? 4 : 3, pythonSource: crypto.createHash('sha256').update(source).digest('hex'), ...(segments ? { segmentsManifest: segmentsManifestSHA, segments } : {}), ...(autoPlan ? { autoChunks: { reportSHA: autoPlan.reportSHA, chunks: autoPlan.chunks.length, maxChunkSeconds: maxChunkRaw } } : {}) });
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
          ctx.out.write(
            evidence
              ? '对齐：使用已有字级时间戳并做独立校验\n'
              : segments
              ? '对齐：核对原始分段拼接后逐段对齐\n'
              : autoPlan
              ? `对齐：长配音自动按 TTS 段落切为 ${autoPlan.chunks.length} 段执行 ${provider} 本地模型对齐，完成后合并并独立校验\n`
              : `对齐：${provider} 本地模型，完成后独立校验\n`,
          );
          const wav=path.join(attempt,'voice-16k.wav'),textFile=path.join(attempt,'normalized.txt'),scriptPath=path.join(attempt,'align.py'),raw=path.join(attempt,'align.json');
          const chain=mediaprobe.newToolchain(env);
          const requests=path.join(attempt,'segments.json');
          if (evidence) {
            fs.copyFileSync(evidence, raw, fs.constants.COPYFILE_EXCL);
            if (sha(raw) !== evidenceSHA) throw Error('字级证据在读取时发生变化');
          }
          if (runner) {
            await chain.decodeAnalysisWAV(audio,wav,16000,ctx.signal);
            if (autoPlan) {
              if (provider === 'funasr') fs.writeFileSync(scriptPath, source);
              phase = 'model';
              const merged: Array<{ text: string; start: number; end: number }> = [];
              const log = fs.openSync(path.join(attempt, 'python.log'), 'wx');
              try {
                for (const chunk of autoPlan.chunks) {
                  ctx.signal.throwIfAborted();
                  const tag = String(chunk.index + 1).padStart(3, '0');
                  const chunkWav = path.join(attempt, `chunk-${tag}.wav`);
                  const chunkOut = path.join(attempt, `chunk-${tag}.json`);
                  await chain.transcode(
                    chunkWav,
                    ['-ss', formatFixed(chunk.start, 6), '-t', formatFixed(chunk.end - chunk.start, 6), '-i', wav, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'],
                    ctx.signal,
                  );
                  let args: string[];
                  if (provider === 'mlx') {
                    args = ['--model', model, '--audio', chunkWav, '--text', chunk.text, '--language', 'Chinese', '--output-path', chunkOut.slice(0, -5), '--format', 'json'];
                  } else {
                    const chunkTextFile = path.join(attempt, `chunk-${tag}.txt`);
                    fs.writeFileSync(chunkTextFile, chunk.text + '\n');
                    args = [scriptPath, model, chunkWav, chunkTextFile, chunkOut];
                  }
                  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.ceil(seconds * 1000))]);
                  const child = await start(runner.command, args, {
                    cwd: root,
                    env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1' },
                    stdio: ['ignore', log, log],
                    signal,
                  });
                  await child.wait();
                  for (const item of align.loadEvidence(chunkOut)) {
                    merged.push({
                      text: item.text,
                      start: roundMs(item.start + chunk.start),
                      end: roundMs(item.end + chunk.start),
                    });
                  }
                }
              } finally {
                fs.closeSync(log);
              }
              json(raw, merged);
            } else {
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
          cached={digest,inputs,attempt,seconds:(performance.now()-started)/1000,summary:{tokens:result.report.tokens,cues:result.cues.length,total_frames:result.report.total_frames,match_rate:result.report.match_rate,...(autoPlan?{chunks:autoPlan.chunks.length}:{})},paths:{align:raw,srt,phrases,report,audio_check:checkFile},hashes:Object.fromEntries([raw,srt,phrases,report,checkFile,...(segments?[requests,...segments.segments.map((_,index)=>path.join(attempt,'segment-'+index+'.json'))]:[])].map(file=>[file,sha(file)]))};
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
