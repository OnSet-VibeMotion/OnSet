// 移植自 internal/beat/grid.go。
import fs from 'node:fs';
import { formatFixed, goRound } from '../gofmt';
import { sliceOf, type StructType } from './jsondecode';
import { GridFile, DraftFile, localPath, loadConfig, readJSON, writeJSON } from './store';
import { loadTrack, type Track } from './track';

/**
 * Grid 是一首音乐的节拍网格：每一拍的时刻，以及其中哪些是小节第一拍（重拍）。
 *
 * 重拍必须是普通拍的子集：拍内分工（第几拍做什么）要靠「这一拍在小节里排第几」，
 * 重拍不落在某个普通拍上就数不出来。
 *
 * beats / downbeats 为 null 对应 Go 的 nil 切片（写出为 null）。
 */
export interface Grid {
  schema: number;
  audio_sha256: string;
  duration_seconds: number;
  source: string;
  reviewed: boolean;
  beats: number[] | null;
  downbeats: number[] | null;
}

export const gridType: StructType = {
  kind: 'struct',
  goName: 'beat.Grid',
  name: 'Grid',
  fields: [
    ['schema', 'int'],
    ['audio_sha256', 'string'],
    ['duration_seconds', 'float'],
    ['source', 'string'],
    ['reviewed', 'bool'],
    ['beats', sliceOf('float')],
    ['downbeats', sliceOf('float')],
  ],
};

/** 按 Go 的字段顺序构造写盘用的 JSON 值。 */
export function gridToJSON(g: Grid): unknown {
  return {
    schema: g.schema,
    audio_sha256: g.audio_sha256,
    duration_seconds: g.duration_seconds,
    source: g.source,
    reviewed: g.reviewed,
    beats: g.beats,
    downbeats: g.downbeats,
  };
}

/** 补齐 Grid 的零值字段。 */
export function newGrid(fields: Partial<Grid> = {}): Grid {
  return { schema: 0, audio_sha256: '', duration_seconds: 0, source: '', reviewed: false, beats: null, downbeats: null, ...fields };
}

/**
 * downbeatMatch 是重拍对齐到普通拍的容差。分析模型的时间分辨率是 20 ms，
 * 手改网格时浮点尾数会有毫秒级出入，再大就是真的没落在拍上。
 */
const downbeatMatch = 0.002;

/** Problems 返回网格的全部不合格项。 */
export function gridProblems(g: Grid): string[] {
  const problems: string[] = [];
  if (g.schema !== 1 || !finite(g.duration_seconds) || g.duration_seconds <= 0) problems.push('网格版本或时长无效');
  problems.push(...increasing('beats', g.beats ?? [], g.duration_seconds));
  problems.push(...increasing('downbeats', g.downbeats ?? [], g.duration_seconds));
  const downbeats = g.downbeats ?? [];
  if (downbeats.length < 2) problems.push('重拍少于两个，无法按小节切分');
  for (const d of downbeats) {
    if (nearestBeat(g.beats ?? [], d) < 0) problems.push(`重拍 ${formatFixed(d, 3)} 秒没有落在任何普通拍上`);
  }
  return problems;
}

function increasing(field: string, values: number[], duration: number): string[] {
  let last = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!finite(v) || v < 0 || v >= duration || v <= last) return [`${field} 第 ${i + 1} 项（${formatFixed(v, 3)}）倒序、重复或越界`];
    last = v;
  }
  return [];
}

/** sort.SearchFloat64s：第一个不小于 x 的下标。 */
function searchFloat64s(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 返回 at 所落的普通拍下标，没落在任何拍上时返回 -1。 */
export function nearestBeat(beats: number[], at: number): number {
  const i = searchFloat64s(beats, at - downbeatMatch);
  if (i < beats.length && Math.abs(beats[i] - at) <= downbeatMatch) return i;
  return -1;
}

/** normalize 把重拍对齐到它所落的那个普通拍的精确值，之后两者可按相等比较。 */
export function normalizeGrid(g: Grid): Grid {
  const beats = g.beats ?? [];
  const downbeats = (g.downbeats ?? []).map((d) => {
    const i = nearestBeat(beats, d);
    return i >= 0 ? beats[i] : d;
  });
  return { ...g, downbeats };
}

/** Bar 是一个小节：从一个重拍到下一个重拍（最后一小节到音乐结束）。 */
export interface Bar {
  number: number;
  start_seconds: number;
  end_seconds: number;
  beats: number;
}

/**
 * Bars 按重拍切出全部小节，编号从 1 开始。第一个重拍之前的弱起不算小节，
 * 切镜头时并进第一个镜头。
 */
export function gridBars(g: Grid): Bar[] {
  const downbeats = g.downbeats ?? [];
  return downbeats.map((start, i) => {
    const end = i + 1 < downbeats.length ? downbeats[i + 1] : g.duration_seconds;
    let count = 0;
    for (const b of g.beats ?? []) if (b >= start - downbeatMatch && b < end - downbeatMatch) count++;
    return { number: i + 1, start_seconds: start, end_seconds: end, beats: count };
  });
}

/** Summary 是给人看的网格概况，用来在试听之前先发现明显的错误。 */
export interface Summary {
  bars: number;
  bpm: number;
  /** 每小节拍数 → 小节数（Go 的 map[int]int）。 */
  meters: Map<number, number>;
  pickupSeconds: number;
}

/** Summarize 统计速度、拍号分布与弱起。最后一小节常被音乐结尾截断，不计入拍号。 */
export function summarize(g: Grid): Summary {
  const s: Summary = { bars: 0, bpm: 0, meters: new Map(), pickupSeconds: 0 };
  const bars = gridBars(g);
  s.bars = bars.length;
  bars.forEach((bar, i) => {
    if (i < bars.length - 1) s.meters.set(bar.beats, (s.meters.get(bar.beats) ?? 0) + 1);
  });
  const downbeats = g.downbeats ?? [];
  if (downbeats.length > 0) s.pickupSeconds = downbeats[0];
  const beats = g.beats ?? [];
  if (beats.length > 1) {
    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
    intervals.sort((a, b) => a - b);
    s.bpm = 60 / intervals[Math.floor(intervals.length / 2)];
  }
  return s;
}

/** String 渲染成一行中文概况。 */
export function summaryString(s: Summary): string {
  const meters = [...s.meters.keys()].sort((a, b) => a - b);
  const parts = meters.map((m) => `${m} 拍 × ${s.meters.get(m)}`);
  return `${s.bars} 小节，约 ${formatFixed(s.bpm, 1)} BPM，拍号分布 [${parts.join('，')}]，弱起 ${formatFixed(s.pickupSeconds, 3)} 秒`;
}

/**
 * Regrid 按固定拍号重排重拍：从第 anchor 拍（从 0 数）起每 meter 拍一个重拍。
 *
 * 分析模型最常见的错误是重拍整体错位（把第 3 拍当成小节开头）或拍号判错，
 * 普通拍本身通常是对的。手改 JSON 里几十个时间戳既慢又容易错，这个操作
 * 只换「哪些拍是重拍」，普通拍原样保留。结果是未确认的草稿。
 */
export function regrid(g: Grid, meter: number, anchor: number): Grid {
  if (meter < 1 || meter > 16) throw new Error(`拍号必须在 1..16 之间，收到 ${meter}`);
  const beats = g.beats ?? [];
  if (anchor < 0 || anchor >= meter || anchor >= beats.length) {
    throw new Error(`起始拍必须在 0..${meter - 1} 之间且不超过总拍数，收到 ${anchor}`);
  }
  const downbeats: number[] = [];
  for (let i = anchor; i < beats.length; i += meter) downbeats.push(beats[i]);
  const source = (g.source.endsWith(' +regrid') ? g.source.slice(0, -' +regrid'.length) : g.source) + ' +regrid';
  return { ...g, reviewed: false, downbeats: downbeats.length > 0 ? downbeats : null, source };
}

/** checkTrack 确认网格属于当前导入的音乐。 */
export function checkTrack(g: Grid, track: Track): void {
  if (g.audio_sha256 !== track.audio_sha256 || Math.abs(g.duration_seconds - track.duration_seconds) > 1e-6) {
    throw new Error('节拍网格属于另一首音乐或另一个版本，请重新 beat_analyze()');
  }
}

/** ReadDraft 读取任意路径的网格文件（通常是手改过的草稿），不要求已确认。 */
export function readDraft(file: string): Grid {
  return readJSON<Grid>(file, gridType);
}

/** SaveDraft 写出未确认的网格草稿。不合格的草稿照样写出，便于人工修正。返回草稿路径。 */
export function saveDraft(root: string, g: Grid): string {
  const file = localPath(root, DraftFile);
  writeJSON(file, gridToJSON({ ...g, reviewed: false }));
  return file;
}

/** Confirm 把人工核对过的网格写成正式网格。只有这一步能把 reviewed 置为 true。 */
export function confirm(root: string, g: Grid): Grid {
  const track = loadTrack(root);
  checkTrack(g, track);
  const problems = gridProblems(g);
  if (problems.length > 0) throw new Error(`网格不合格：${problems.join('；')}`);
  const confirmed = { ...normalizeGrid(g), reviewed: true };
  writeJSON(localPath(root, GridFile), gridToJSON(confirmed));
  return confirmed;
}

/**
 * LoadGrid 读取已确认的正式网格，并核对它仍属于当前音乐。
 *
 * reviewed 只是一个字段：它防的是「拿草稿直接切镜头」这种疏忽，不防有人
 * 故意手改 grid.json。确认之后的任何改动都会改变文件摘要，已写好的镜头 cue
 * 随之失效，必须重跑 am beat cues。
 */
export function loadGrid(root: string): Grid {
  loadConfig(root);
  const track = loadTrack(root);
  const file = localPath(root, GridFile);
  if (!fs.existsSync(file)) throw new Error('还没有已确认的节拍网格：先 beat_analyze()，试听后 beat_confirm()');
  const g = readJSON<Grid>(file, gridType);
  if (!g.reviewed) throw new Error(`${GridFile} 未经人工确认，请用 beat_confirm() 导入`);
  checkTrack(g, track);
  const problems = gridProblems(g);
  if (problems.length > 0) throw new Error(`网格不合格：${problems.join('；')}`);
  return g;
}

/** FrameOf 是全片唯一的「秒 → 帧」换算。切点、拍点帧号都走它。 */
export function frameOf(seconds: number, fps: number): number {
  // + 0 把 -0 变成 0：Go 的 int 没有负零，写进 JSON 时不能出现 -0。
  return goRound(seconds * fps) + 0;
}

/** TotalFrames 是覆盖整首音乐所需的帧数：最后不足一帧也要占一帧，与成片封装一致。 */
export function totalFrames(duration: number, fps: number): number {
  return Math.ceil(duration * fps - 1e-9) + 0;
}

export function finite(f: number): boolean {
  return Number.isFinite(f);
}
