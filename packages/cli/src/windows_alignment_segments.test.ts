import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {expect,it} from 'vitest';
import {loadWindowsAlignmentSegments,verifyWindowsAlignmentSegments} from './windows_alignment_segments';
import {tempDir} from './testutil';

const sha=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(){
  const root=tempDir(),audio=path.join(root,'voice.wav'),script=path.join(root,'script.md'),chunk=path.join(root,'part.wav'),file=path.join(root,'segments.json');
  fs.writeFileSync(audio,'full PCM fixture');fs.writeFileSync(script,'BoHack。你好。');fs.writeFileSync(chunk,'source PCM fixture');
  const data={schema:1,audio_sha256:sha(audio),script_sha256:sha(script),sample_rate:24000,segments:[{audio:'part.wav',sha256:sha(chunk),text:'Bohack。你好。',start_sample:0,end_sample_exclusive:24000}]};
  const write=()=>fs.writeFileSync(file,JSON.stringify(data));
  const load=()=>loadWindowsAlignmentSegments(file,audio,script,'BoHack 你好',relative=>{
    const source=path.resolve(root,relative),rel=path.relative(root,source);
    if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('outside project');
    return source;
  });
  write();return {root,audio,script,chunk,file,data,write,load};
}

it('binds original chunks to confirmed inputs and normalizes only punctuation for model text',()=>{
  const f=fixture(),segments=f.load();
  expect(segments.segments[0].text).toBe('Bohack 你好');
  expect(segments.segments[0].audio).toBe(f.chunk);
  expect(()=>verifyWindowsAlignmentSegments(segments)).not.toThrow();
  fs.writeFileSync(f.chunk,'changed source');
  expect(()=>verifyWindowsAlignmentSegments(segments)).toThrow(/发生变化/);
  expect(f.load).toThrow(/摘要/);
});

it('rejects changed audio, changed script, missing text and invented overlapping offsets',()=>{
  const f=fixture();
  f.data.audio_sha256='0'.repeat(64);f.write();expect(f.load).toThrow(/绑定/);
  f.data.audio_sha256=sha(f.audio);f.data.script_sha256='0'.repeat(64);f.write();expect(f.load).toThrow(/绑定/);
  f.data.script_sha256=sha(f.script);f.data.segments[0].text='你好';f.write();expect(f.load).toThrow(/完整覆盖/);
  f.data.segments[0].text='Bohack。你好。';f.data.segments.push({...f.data.segments[0],start_sample:12000,end_sample_exclusive:36000});f.write();expect(f.load).toThrow(/采样边界/);
});

it('rejects external paths, fractional samples and unsupported sample rates before model startup',()=>{
  const f=fixture();
  f.data.segments[0].audio='../outside.wav';f.write();expect(f.load).toThrow(/outside/);
  f.data.segments[0].audio='part.wav';f.data.segments[0].start_sample=0.5;f.write();expect(f.load).toThrow(/采样边界/);
  f.data.segments[0].start_sample=0;f.data.sample_rate=0;f.write();expect(f.load).toThrow(/采样率/);
});
