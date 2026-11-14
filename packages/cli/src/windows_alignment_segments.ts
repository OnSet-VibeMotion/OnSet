import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface WindowsAlignmentSegment {
  audio: string;
  sha256: string;
  text: string;
  start_sample: number;
  end_sample_exclusive: number;
}

export interface WindowsAlignmentSegments {
  schema: 1;
  audio_sha256: string;
  script_sha256: string;
  sample_rate: number;
  segments: WindowsAlignmentSegment[];
}

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Exact source chunks are evidence; acoustic guesses or sentence-duration estimates are not. */
export function loadWindowsAlignmentSegments(
  file: string, audio: string, script: string, spokenText: string,
  resolveInput: (relative: string) => string,
): WindowsAlignmentSegments {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schema !== 1 || data.audio_sha256 !== sha(audio) || data.script_sha256 !== sha(script)) throw Error('分段清单未绑定当前配音和终稿');
  if (!Number.isInteger(data.sample_rate) || data.sample_rate < 8000 || data.sample_rate > 192000 || !Array.isArray(data.segments) || !data.segments.length || data.segments.length > 1000) throw Error('分段清单的采样率或分段数量不合法');
  let previous = 0;
  const segments: WindowsAlignmentSegment[] = data.segments.map((row: WindowsAlignmentSegment) => {
    if (!row || typeof row.audio !== 'string' || path.isAbsolute(row.audio) || typeof row.text !== 'string' || !row.text.trim() || !Number.isSafeInteger(row.start_sample) || !Number.isSafeInteger(row.end_sample_exclusive) || row.start_sample < previous || row.end_sample_exclusive <= row.start_sample) throw Error('分段清单的文本、路径或采样边界不合法');
    const source = resolveInput(row.audio);
    if (!/^[0-9a-f]{64}$/.test(row.sha256) || row.sha256 !== sha(source)) throw Error('分段音频摘要与清单不符');
    previous = row.end_sample_exclusive;
    return {...row, audio: source, text: row.text.replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim()};
  });
  const spoken = (value: string) => value.replace(/[\p{P}\s]/gu, '').toLowerCase();
  if (spoken(segments.map(row => row.text).join('')) !== spoken(spokenText)) throw Error('分段文本未完整覆盖当前终稿的朗读字符');
  return {...data, segments};
}

export function verifyWindowsAlignmentSegments(data: WindowsAlignmentSegments): void {
  if (data.segments.some(row => sha(row.audio) !== row.sha256)) throw Error('对齐过程中分段音频发生变化，候选不能发布');
}

/** Runs after the one model initialization. Full PCM composition must verify before inference. */
export const windowsSegmentPython = `import wave,hashlib
request=json.loads(Path(sys.argv[5]).read_text(encoding='utf-8'))
with wave.open(sys.argv[2],'rb') as full:
 params=full.getparams();samples=full.readframes(full.getnframes())
 assert params.sampwidth==2 and params.framerate==request['sample_rate'], 'assembly requires source PCM16 sample rate'
width=params.sampwidth*params.nchannels
cursor=0;verified=[]
for index,segment in enumerate(request['segments']):
 source=Path(segment['audio'])
 assert hashlib.sha256(source.read_bytes()).hexdigest()==segment['sha256'], 'source chunk hash changed'
 with wave.open(str(source),'rb') as chunk:
  cp=chunk.getparams();data=chunk.readframes(chunk.getnframes())
  assert (cp.nchannels,cp.sampwidth,cp.framerate)==(params.nchannels,params.sampwidth,params.framerate), 'source chunk format mismatch'
 start=segment['start_sample'];end=segment['end_sample_exclusive']
 assert start>=cursor and end-start==len(data)//width and end*width<=len(samples), 'source chunk bounds mismatch'
 assert samples[cursor*width:start*width]==b'\\x00'*(start-cursor)*width, 'assembly gap contains nonzero audio'
 assert samples[start*width:end*width]==data, 'assembly does not contain exact source PCM'
 verified.append((index,segment))
 cursor=end
assert samples[cursor*width:]==b'\\x00'*(len(samples)-cursor*width), 'unaccounted trailing speech'
combined=[]
for index,segment in verified:
 result=model.generate(input=(segment['audio'],segment['text']),data_type=('sound','text'))
 (Path(sys.argv[4]).parent/('segment-'+str(index)+'.json')).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
 for row in result:
  words=row['text'].split();stamps=row['timestamp']
  assert len(words)==len(stamps), 'chunk token and timestamp count mismatch'
  for word,(start,end) in zip(words,stamps):
   assert 0<=start<=end<=((segment['end_sample_exclusive']-segment['start_sample'])/params.framerate)*1000+50, 'chunk timestamp outside source'
   offset=segment['start_sample']/params.framerate
   combined.append({'text':word,'start':offset+start/1000,'end':offset+end/1000})
with open(sys.argv[4],'x',encoding='utf-8') as output:json.dump(combined,output,ensure_ascii=False)
print('onset_python_seconds='+str(time.monotonic()-started),flush=True)
`;
