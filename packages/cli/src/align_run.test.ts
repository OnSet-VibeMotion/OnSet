import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it,vi} from 'vitest';
import * as procgroup from '@onset/engine/procgroup';
import { QwenForcedAligner } from '@onset/engine/config';
import {alignRunOperation,normalizeWindowsAlignmentText,localAlignmentModel,planTTSAutoChunks,windowsAlignOperation} from './align_run';
import {tempDir,setenv,writeFrameFor,hasFfmpeg,Buffer,makeClip} from './testutil';

it('normalizes punctuation without changing spoken letters, numbers or Chinese characters',()=>{
 expect(normalizeWindowsAlignmentText('M G 动画：2026 年，清晰！\n第二段。')).toBe('M G 动画 2026 年 清晰 第二段');
 expect(()=>normalizeWindowsAlignmentText('……！')).toThrow(/朗读/);
 expect(()=>localAlignmentModel({ALIGN_MODEL:'iic/speech_timestamp_prediction-v1-16k-offline',XDG_DATA_HOME:tempDir()})).toThrow(/本地/);
});

it.skipIf(!hasFfmpeg)('validates once, reuses sealed results, rejects changed candidates and preserves existing outputs',async()=>{
 const root=tempDir(),runtime=tempDir(),model=tempDir();
 fs.mkdirSync(path.join(root,'production/audio'),{recursive:true});
 fs.writeFileSync(path.join(root,'onset.conf'),'ALIGN_PROVIDER=funasr\n');writeFrameFor(root,'size=320x240');
 fs.writeFileSync(path.join(root,'production/script-final.md'),'你好。');
 const source=path.join(root,'production/audio/voice.wav');
 makeClip(source,'sine=frequency=440:sample_rate=16000:duration=0.8','-af','apad=pad_dur=0.2');
 const bin=path.join(runtime,'bin'),windows=process.platform==='win32';
 const python=windows?path.join(runtime,'tools/venv/funasr/Scripts/python.exe'):path.join(bin,'funasr-python');
 fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'fixture',{mode:0o755});
 if(windows){
   const init=path.resolve(path.dirname(python),'../Lib/site-packages/funasr/__init__.py');
   fs.mkdirSync(path.dirname(init),{recursive:true});fs.writeFileSync(init,'fixture');
 }
 for(const name of ['am.mvn','config.yaml','configuration.json','model.pt','seg_dict','tokens.json'])fs.writeFileSync(path.join(model,name),'fixture');
 setenv('ONSET_BIN_DIR',bin);setenv('ALIGN_MODEL',model);setenv('XDG_DATA_HOME',runtime);
 const actualStart=procgroup.start;let modelRuns=0;let fail=false;let wrongTimes=false;
 const mock=vi.spyOn(procgroup,'start').mockImplementation(async(file,args,options,...rest)=>{
   if(file!==python)return actualStart(file,args,options,...rest);
   modelRuns++;
   if(fail)throw Error('fixture: model failed');
   fs.writeFileSync(args[4],JSON.stringify([{text:'你 好',timestamp:wrongTimes?[[500,700],[700,800]]:[[0,400],[400,800]]}]));
   return {wait:async()=>{}} as Awaited<ReturnType<typeof procgroup.start>>;
 });
 const out=new Buffer(),ctx={out,err:out,signal:new AbortController().signal,unsafe:false};
 const op=alignRunOperation();
 const input={project_root:root,timeout_seconds:10};const original=fs.readFileSync(source);
 try{
   const first=(await op.run(input,ctx))?.data as any;expect(first.reused).toBe(false);expect(modelRuns).toBe(1);
   expect(JSON.parse(fs.readFileSync(first.paths.audio_check,'utf8')).ok).toBe(true);
   const second=(await op.run(input,ctx))?.data as any;expect(second.reused).toBe(true);expect(modelRuns).toBe(1);
   if(windows)expect(((await windowsAlignOperation().run(input,ctx))?.data as any).reused).toBe(true);
   const approval=path.join(root,'production/storyboard-approval-v02.json');fs.writeFileSync(approval,'{}');
   await expect(op.run({...input,publish:true},ctx)).rejects.toThrow(/确认的分镜/);
   expect(fs.existsSync(path.join(root,'transcription-production.srt'))).toBe(false);fs.unlinkSync(approval);
   const published=(await op.run({...input,publish:true},ctx))?.data as any;expect(published.published).toBe(true);expect(modelRuns).toBe(1);
   expect(fs.existsSync(path.join(root,'transcription-production.srt'))).toBe(false);
   expect(JSON.parse(fs.readFileSync(path.join(root,'production/audio/voice-check.json'),'utf8')).ok).toBe(true);
   expect(((await op.run(input,ctx))?.data as any).reused).toBe(true);expect(modelRuns).toBe(1);
   const canonical=path.join(root,'production/audio/voice.srt');const saved=fs.readFileSync(canonical);
   await expect(op.run({...input,publish:true},ctx)).rejects.toThrow(/已有规范输出/);
   expect(fs.readFileSync(canonical)).toEqual(saved);expect(fs.readFileSync(source)).toEqual(original);
   fs.writeFileSync(first.paths.srt,'tampered');
   await expect(op.run(input,ctx)).rejects.toThrow(/发生变化/);expect(modelRuns).toBe(1);
   fs.writeFileSync(path.join(root,'production/script-final.md'),'你好！再见。');fail=true;
   await expect(op.run(input,ctx)).rejects.toThrow(/model failed/);expect(modelRuns).toBe(2);
   await expect(op.run(input,ctx)).rejects.toThrow(/停止重复试错/);expect(modelRuns).toBe(2);
   const cacheRoot=path.join(root,'production/audio/alignment-runs');
   const failed=fs.readdirSync(cacheRoot).map(name=>path.join(cacheRoot,name)).find(dir=>fs.existsSync(path.join(dir,'failure.json')))!;
   const exited=spawnSync(process.execPath,['-e',''],{windowsHide:true});
   expect(exited.status).toBe(0);
   fs.writeFileSync(path.join(failed,'running.lock'),JSON.stringify({pid:exited.pid}));
   await expect(op.run({...input,retry:true},ctx)).rejects.toThrow(/model failed/);expect(modelRuns).toBe(3);
   fs.writeFileSync(path.join(root,'production/script-final.md'),'你好？');fail=false;wrongTimes=true;
   await expect(op.run(input,ctx)).rejects.toThrow(/audio_check/);expect(modelRuns).toBe(4);
   expect(fs.readFileSync(canonical)).toEqual(saved);
   expect(fs.readFileSync(source)).toEqual(original);
 }finally{mock.mockRestore();}
});

it.skipIf(process.platform==='win32'||!hasFfmpeg)('runs the configured local MLX provider and maps its JSON without a project script', async () => {
  const root = tempDir(), bin = tempDir(), model = tempDir();
  const audio = path.join(root, 'production/audio/voice.wav');
  fs.mkdirSync(path.dirname(audio), { recursive: true });
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ALIGN_PROVIDER=mlx\n');
  writeFrameFor(root, 'size=320x240');
  fs.writeFileSync(path.join(root, 'production/script-final.md'), '你好。');
  makeClip(audio, 'sine=frequency=440:sample_rate=16000:duration=0.8', '-af', 'apad=pad_dur=0.2');
  const command = path.join(bin, 'mlx_audio.stt.generate');
  fs.writeFileSync(command, 'fixture', { mode: 0o755 });
  for (const file of QwenForcedAligner.files) fs.writeFileSync(path.join(model, file.path), 'fixture');
  setenv('ONSET_BIN_DIR', bin);
  setenv('ALIGN_MODEL', model);
  const actualStart = procgroup.start;
  const mock = vi.spyOn(procgroup, 'start').mockImplementation(async (file, args, options, ...rest) => {
    if (file !== command) return actualStart(file, args, options, ...rest);
    expect(args).toEqual(['--model', model, '--audio', expect.stringMatching(/voice-16k\.wav$/), '--text', expect.stringContaining('你好'), '--language', 'Chinese', '--output-path', expect.any(String), '--format', 'json']);
    expect(options?.env?.HF_HUB_OFFLINE).toBe('1');
    fs.writeFileSync(args[args.indexOf('--output-path') + 1] + '.json', JSON.stringify([
      { text: '你', start: 0, end: 0.4 },
      { text: '好', start: 0.4, end: 0.8 },
    ]));
    return { wait: async () => {} } as Awaited<ReturnType<typeof procgroup.start>>;
  });
  try {
    const out = new Buffer();
    const result = await alignRunOperation().run(
      { project_root: root, publish: true },
      { out, err: out, signal: new AbortController().signal, unsafe: false },
    );
    expect(result?.data).toMatchObject({ published: true, match_rate: 1 });
    expect(fs.readFileSync(path.join(root, 'production/audio/voice.srt'), 'utf8')).toContain('你好');
  } finally {
    mock.mockRestore();
  }
});

it.skipIf(!hasFfmpeg)('builds from trusted word timestamps without requiring an installed aligner', async () => {
  const root = tempDir();
  const audio = path.join(root, 'production/audio/voice.wav');
  fs.mkdirSync(path.dirname(audio), { recursive: true });
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ALIGN_PROVIDER=funasr\n');
  writeFrameFor(root, 'size=320x240');
  fs.writeFileSync(path.join(root, 'production/script-final.md'), '你好。');
  makeClip(audio, 'sine=frequency=440:sample_rate=16000:duration=0.8', '-af', 'apad=pad_dur=0.2');
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify([{ text: '你', start: 0, end: 0.4 }, { text: '好', start: 0.4, end: 0.8 }]));
  const out = new Buffer();
  const context = { out, err: out, signal: new AbortController().signal, unsafe: false };
  const input = { project_root: root, evidence: 'evidence.json' };
  expect((await alignRunOperation().run({ ...input, publish: true }, context))?.data).toMatchObject({ published: true, match_rate: 1 });
  expect((await alignRunOperation().run(input, context))?.data).toMatchObject({ reused: true });
});

it.skipIf(process.platform === 'win32' || !hasFfmpeg)('auto-chunks long MLX audio using matching TTS report (including copied WAV matched by SHA-256) and merges shifted timestamps', async () => {
  const root = tempDir(), bin = tempDir(), model = tempDir();
  const audioDir = path.join(root, 'production/audio');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ALIGN_PROVIDER=mlx\n');
  writeFrameFor(root, 'size=320x240');
  fs.writeFileSync(path.join(root, 'production/script-final.md'), '你好。\n\n再见。\n');

  // 构造 2.0 秒音频（两段各 0.7s 发声，中间 0.6s 静音），并放在 voice-v05.tts/ 下再复制为 voice.wav 测试 SHA-256 匹配。
  const sourceDir = path.join(audioDir, 'voice-v05.tts');
  fs.mkdirSync(sourceDir, { recursive: true });
  const seg1 = path.join(sourceDir, '001.wav');
  const sil = path.join(sourceDir, 'sil.wav');
  const seg2 = path.join(sourceDir, '002.wav');
  makeClip(seg1, 'sine=frequency=440:sample_rate=16000:duration=0.7');
  makeClip(sil, 'anullsrc=r=16000:cl=mono:d=0.6');
  makeClip(seg2, 'sine=frequency=520:sample_rate=16000:duration=0.7');
  const concatList = path.join(sourceDir, 'list.txt');
  fs.writeFileSync(concatList, `file '${seg1}'\nfile '${sil}'\nfile '${seg2}'\n`);
  const ttsWav = path.join(sourceDir, 'audio.wav');
  const voiceWav = path.join(audioDir, 'voice.wav');
  const concatRes = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c:a', 'pcm_s16le', ttsWav]);
  expect(concatRes.status).toBe(0);
  fs.copyFileSync(ttsWav, voiceWav);
  fs.writeFileSync(path.join(sourceDir, 'report.json'), JSON.stringify({
    schema: 1,
    duration_seconds: 2.0,
    segments: [
      { audio: '001.wav', text: '你好。', start_seconds: 0, duration_seconds: 0.7, pause_after_ms: 600 },
      { audio: '002.wav', text: '再见。', start_seconds: 1.3, duration_seconds: 0.7 },
    ],
  }));

  const command = path.join(bin, 'mlx_audio.stt.generate');
  fs.writeFileSync(command, 'fixture', { mode: 0o755 });
  for (const file of QwenForcedAligner.files) fs.writeFileSync(path.join(model, file.path), 'fixture');
  setenv('ONSET_BIN_DIR', bin);
  setenv('ALIGN_MODEL', model);
  setenv('ONSET_ALIGN_AUTO_CHUNK_THRESHOLD_SECONDS', '1');

  const actualStart = procgroup.start;
  const seenTexts: string[] = [];
  const mock = vi.spyOn(procgroup, 'start').mockImplementation(async (file, args, options, ...rest) => {
    if (file !== command) return actualStart(file, args, options, ...rest);
    const chunkText = args[args.indexOf('--text') + 1]!;
    seenTexts.push(chunkText);
    const outPath = args[args.indexOf('--output-path') + 1]! + '.json';
    const chars = chunkText.includes('你好') ? ['你', '好'] : ['再', '见'];
    fs.writeFileSync(outPath, JSON.stringify([
      { text: chars[0], start: 0.0, end: 0.35 },
      { text: chars[1], start: 0.35, end: 0.7 },
    ]));
    return { wait: async () => {} } as Awaited<ReturnType<typeof procgroup.start>>;
  });
  try {
    const out = new Buffer();
    const result = await alignRunOperation().run(
      { project_root: root, max_chunk_seconds: 1, publish: true },
      { out, err: out, signal: new AbortController().signal, unsafe: false },
    );
    expect(seenTexts).toEqual(['你好。', '再见。']);
    expect(result?.data).toMatchObject({ published: true, match_rate: 1, chunks: 2 });
    const mergedAlign = JSON.parse(fs.readFileSync(path.join(root, 'production/audio/align.json'), 'utf8')) as Array<{ text: string; start: number; end: number }>;
    expect(mergedAlign).toEqual([
      { text: '你', start: 0, end: 0.35 },
      { text: '好', start: 0.35, end: 0.7 },
      { text: '再', start: 1.3, end: 1.65 },
      { text: '见', start: 1.65, end: 2.0 },
    ]);
    const srt = fs.readFileSync(path.join(root, 'production/audio/voice.srt'), 'utf8');
    expect(srt).toContain('你好。');
    expect(srt).toContain('再见。');
    expect(srt).toContain('00:00:01,300 --> 00:00:02,000');
  } finally {
    mock.mockRestore();
  }
});

it('planTTSAutoChunks requires SHA-256 match on primary <stem>.tts/audio.wav and strips vocal events when matching', () => {
  const dir = tempDir();
  const audio = path.join(dir, 'voice.wav');
  fs.writeFileSync(audio, 'current-audio-bytes');
  const ttsDir = path.join(dir, 'voice.tts');
  fs.mkdirSync(ttsDir, { recursive: true });
  const report = {
    schema: 1,
    duration_seconds: 220,
    segments: [
      { audio: '001.wav', text: '第一段。[笑]', start_seconds: 0, duration_seconds: 100, pause_after_ms: 650 },
      { audio: '002.wav', text: '第二段。(sigh)', start_seconds: 100.65, duration_seconds: 119.35 },
    ],
  };
  fs.writeFileSync(path.join(ttsDir, 'report.json'), JSON.stringify(report));
  // 缺少或 SHA-256 不匹配的同名 voice.tts/audio.wav 必须被跳过，防止错用旧 take 切点。
  fs.writeFileSync(path.join(ttsDir, 'audio.wav'), 'stale-audio-bytes');
  const currentSHA = 'wrong';
  expect(planTTSAutoChunks(audio, currentSHA, '第一段。\n第二段。', 220, 'mlx', 150, 180)).toBeNull();

  // audio.wav 与当前音频一致时，即使报告含 [笑] / (sigh) 声音事件也能正常匹配并切段。
  fs.writeFileSync(path.join(ttsDir, 'audio.wav'), 'current-audio-bytes');
  const realSHA = require('node:crypto').createHash('sha256').update('current-audio-bytes').digest('hex') as string;
  const planned = planTTSAutoChunks(audio, realSHA, '第一段。\n第二段。', 220, 'mlx', 150, 180);
  expect(planned).not.toBeNull();
  expect(planned!.chunks).toHaveLength(2);
  expect(planned!.chunks[0]!.text).toBe('第一段。');
  expect(planned!.chunks[1]!.text).toBe('第二段。');
});
