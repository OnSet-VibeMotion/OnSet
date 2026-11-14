import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it,vi} from 'vitest';
import * as procgroup from '@onset/engine/procgroup';
import {normalizeWindowsAlignmentText,localAlignmentModel,windowsAlignOperation} from './windows_align';
import {tempDir,setenv,writeFrameFor,hasFfmpeg,Buffer,makeClip} from './testutil';

it('normalizes punctuation without changing spoken letters, numbers or Chinese characters',()=>{
 expect(normalizeWindowsAlignmentText('M G 动画：2026 年，清晰！\n第二段。')).toBe('M G 动画 2026 年 清晰 第二段');
 expect(()=>normalizeWindowsAlignmentText('……！')).toThrow(/朗读/);
 expect(()=>localAlignmentModel({ALIGN_MODEL:'iic/speech_timestamp_prediction-v1-16k-offline',XDG_DATA_HOME:tempDir()})).toThrow(/本地/);
});

it.skipIf(process.platform!=='win32'||!hasFfmpeg)('validates once, reuses sealed results, rejects changed candidates and preserves existing outputs',async()=>{
 const root=tempDir(),runtime=tempDir(),model=tempDir();
 fs.mkdirSync(path.join(root,'production/audio'),{recursive:true});
 fs.writeFileSync(path.join(root,'onset.conf'),'');writeFrameFor(root,'size=320x240');
 fs.writeFileSync(path.join(root,'production/script-final.md'),'你好。');
 const source=path.join(root,'production/audio/voice.wav');
 makeClip(source,'sine=frequency=440:sample_rate=16000:duration=0.8','-af','apad=pad_dur=0.2');
 const bin=path.join(runtime,'bin'),python=path.join(runtime,'tools/venv/funasr/Scripts/python.exe');
 fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'fixture');
 const init=path.resolve(path.dirname(python),'../Lib/site-packages/funasr/__init__.py');fs.mkdirSync(path.dirname(init),{recursive:true});fs.writeFileSync(init,'fixture');
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
 const out=new Buffer(),ctx={out,err:out,signal:new AbortController().signal,unsafe:false},op=windowsAlignOperation();
 const input={project_root:root,timeout_seconds:10};const original=fs.readFileSync(source);
 try{
   const first=(await op.run(input,ctx))?.data as any;expect(first.reused).toBe(false);expect(modelRuns).toBe(1);
   expect(JSON.parse(fs.readFileSync(first.paths.audio_check,'utf8')).ok).toBe(true);
   const second=(await op.run(input,ctx))?.data as any;expect(second.reused).toBe(true);expect(modelRuns).toBe(1);
   const approval=path.join(root,'production/storyboard-approval-v02.json');fs.writeFileSync(approval,'{}');
   await expect(op.run({...input,publish:true},ctx)).rejects.toThrow(/确认的分镜/);
   expect(fs.existsSync(path.join(root,'transcription-production.srt'))).toBe(false);fs.unlinkSync(approval);
   const published=(await op.run({...input,publish:true},ctx))?.data as any;expect(published.published).toBe(true);expect(modelRuns).toBe(1);
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
