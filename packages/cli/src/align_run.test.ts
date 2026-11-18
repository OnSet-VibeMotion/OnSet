import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it,vi} from 'vitest';
import * as procgroup from '@onset/engine/procgroup';
import { QwenForcedAligner } from '@onset/engine/config';
import {alignRunOperation,normalizeWindowsAlignmentText,localAlignmentModel,windowsAlignOperation} from './align_run';
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
