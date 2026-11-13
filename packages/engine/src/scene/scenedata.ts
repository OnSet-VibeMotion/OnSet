//
// 本文件生成镜头局部数据文件 am-scene.js，并据此拼装提示词里的时间合同段。
//
// 渲染器过去要自己从完整字幕里减去镜头的全局起点，再按帧率换算——每个镜头
// 各算一遍，取整口径各不相同。现在局部帧号由 am 统一算好，写成
// window.AM_SCENE 交给 composition 直接读，提示词里的表格与它同源。
import fs from 'node:fs';
import path from 'node:path';
import { frameOf } from '../beat/grid';
import { atomicWrite } from '../fsutil';
import { marshalIndent, sortedKeys } from '../gojson';
import { goRound } from '../gofmt';
import * as reads from '../reads';
import * as srt from '../srt';
import { contained, sceneCanvas, frameSource, delimiterMatchAll, readFrameFrontmatter, type Scene } from './scene';
import { handoffGuide, handoffIsZero, loadPhraseTimelineIn, lookIsZero, lookToJSON, type Handoff, type Look, type Timing } from './timing';

/** 写进镜头目录的局部数据文件名。 */
export const SceneDataFile = 'am-scene.js';

/** am-scene.js 的结构版本。字段名由运行时库按名读取，不得改名。 */
export const SceneDataSchema = 1;

/**
 * window.AM_SCENE 的内容。帧号除 start_frame 外都是镜头局部帧：
 * 0 是本镜头第一帧。区间左闭右开。
 */
export interface SceneData {
  schema: number;
  scene_id: string;
  fps: number;
  frames: number;
  width_px: number;
  height_px: number;
  duration_seconds: number;
  start_frame: number | null;
  safe_area: Record<string, unknown>;
  subtitles: unknown;
  cues: LocalCue[];
  phrases: LocalPhrase[];
  /** 全片配色，分镜计划没写 look 时为 null（JSON 里省略）。 */
  look: Look | null;
}

/** 落在本镜头内的一条字幕，已裁到 [0, frames)。 */
export interface LocalCue {
  index: number;
  text: string;
  start_frame: number;
  end_frame_exclusive: number;
}

/**
 * 落在本镜头内的一条短语，已裁到 [0, frames)。
 * min_readable_frames 按 reads 的阅读速度判据算出。
 */
export interface LocalPhrase {
  phrase_id: string;
  text: string;
  start_frame: number;
  end_frame_exclusive: number;
  min_readable_frames: number;
}

/**
 * 算出镜头的局部数据。没有 timing 块的镜头不知道自己在全片里
 * 的位置，cues 与 phrases 为空数组、start_frame 为 null。
 */
export function buildSceneData(s: Scene): SceneData {
  const canvas = sceneCanvas(s);
  const data: SceneData = {
    schema: SceneDataSchema,
    scene_id: s.id,
    fps: canvas.fps,
    frames: goRound(s.duration_seconds * canvas.fps),
    width_px: canvas.widthPx,
    height_px: canvas.heightPx,
    duration_seconds: s.duration_seconds,
    start_frame: null,
    safe_area: {},
    subtitles: null,
    cues: [],
    phrases: [],
    look: null,
  };
  const source = frameSource(s);
  if (source) {
    // frame.md 里的这两块原样搬运。用 any 接收，写错类型也不会让整份 frontmatter 解析失败。
    const extras = readFrameFrontmatter(source.directory, source.file);
    const area = extras.safe_area;
    if (area !== null && typeof area === 'object' && !Array.isArray(area)) data.safe_area = area as Record<string, unknown>;
    data.subtitles = extras.subtitles ?? null;
  }
  const t = s.timing;
  if (t === null) return data;
  const start = t.start_frame;
  data.start_frame = start;
  if (!lookIsZero(t.look)) data.look = { ...t.look };
  const transcript = contained(s.directory, s.transcript, 'transcript');
  let cues: srt.Cue[];
  try {
    cues = srt.readCues(transcript);
  } catch (err) {
    throw new Error(`transcript ${s.transcript}：${(err as Error).message}`, { cause: err });
  }
  for (const c of cues) {
    const clipped = clipLocal(frameOf(c.start_seconds, canvas.fps), frameOf(c.end_seconds, canvas.fps), start, data.frames);
    if (!clipped) continue;
    data.cues.push({ index: c.index, text: c.text, start_frame: clipped[0], end_frame_exclusive: clipped[1] });
  }
  if (t.phrases !== '') {
    const timeline = loadPhraseTimelineIn(s.directory, t.phrases, canvas.fps);
    for (const p of timeline.phrases ?? []) {
      const clipped = clipLocal(p.start_frame, p.end_frame_exclusive, start, data.frames);
      if (!clipped) continue;
      data.phrases.push({
        phrase_id: p.phrase_id,
        text: p.source_text,
        start_frame: clipped[0],
        end_frame_exclusive: clipped[1],
        min_readable_frames: reads.requiredFrames(reads.units(p.source_text), canvas.fps, reads.Defaults),
      });
    }
  }
  return data;
}

/**
 * 把全局区间 [from, to) 换成相对 offset 的局部区间并裁到 [0, frames)。
 * 与本镜头不重叠（含裁完为空）时返回 null。
 */
function clipLocal(from: number, to: number, offset: number, frames: number): [number, number] | null {
  from = Math.max(from - offset, 0);
  to = Math.min(to - offset, frames);
  return from < to ? [from, to] : null;
}

/** Go 的 map[string]any 按键排序输出；YAML 里嵌套的映射同理。 */
function goMapValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(goMapValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = goMapValue(item);
    return sortedKeys(out);
  }
  return value;
}

/** 按 Go 的字段顺序与 omitempty 构造 SceneData 的 JSON 值。 */
export function sceneDataToJSON(data: SceneData): unknown {
  return {
    schema: data.schema,
    scene_id: data.scene_id,
    fps: data.fps,
    frames: data.frames,
    width_px: data.width_px,
    height_px: data.height_px,
    duration_seconds: data.duration_seconds,
    start_frame: data.start_frame,
    safe_area: goMapValue(data.safe_area),
    subtitles: goMapValue(data.subtitles),
    cues: data.cues.map((c) => ({ index: c.index, text: c.text, start_frame: c.start_frame, end_frame_exclusive: c.end_frame_exclusive })),
    phrases: data.phrases.map((p) => ({
      phrase_id: p.phrase_id,
      text: p.text,
      start_frame: p.start_frame,
      end_frame_exclusive: p.end_frame_exclusive,
      min_readable_frames: p.min_readable_frames,
    })),
    look: data.look ? lookToJSON(data.look) : undefined,
  };
}

/**
 * am-scene.js 的完整内容。map 的键按字节序排序，同样的输入总是得到同样的字节。
 */
export function encodeSceneData(data: SceneData): string {
  let body: string;
  try {
    body = marshalIndent(sceneDataToJSON(data));
  } catch (err) {
    throw new Error(`镜头局部数据无法编码为 JSON：${(err as Error).message}`, { cause: err });
  }
  return '// 由 am 生成，勿手改。\n' + 'window.AM_SCENE = ' + body + ';\n';
}

/** 原子写出 <镜头目录>/am-scene.js。内容不变时不重写。 */
export function writeSceneData(s: Scene): void {
  const body = Buffer.from(encodeSceneData(buildSceneData(s)), 'utf8');
  const file = path.join(s.directory, SceneDataFile);
  try {
    if (fs.readFileSync(file).equals(body)) return;
  } catch {
    // 不存在就写。
  }
  atomicWrite(file, body, 0o644);
}

/** 提示词里每张表最多列出的行数，其余让渲染器去读 am-scene.js。 */
const timingTableLimit = 40;

/** 表格里单条文字最多保留的字符数。 */
const timingTextLimit = 40;

/** Go 的 strings.Fields 后以单个空格连接：按 Unicode 空白切分。 */
function joinFields(text: string): string {
  return text.split(goSpaceRun).filter((f) => f !== '').join(' ');
}

// unicode.IsSpace：ASCII 空白、U+0085、U+00A0，以及 Unicode White_Space 的其余字符。
const goSpaceRun = new RegExp(
  '[' +
    [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]
      .map((c) => String.fromCodePoint(c))
      .join('') +
    ']+',
);

/**
 * 把字幕或短语原文压成表格里的一格：去掉换行、阶段消息与定界标记，
 * 过长截断。原文来自字幕文件，不能让它在提示词里伪装成指令或阶段消息。
 */
function promptText(text: string): string {
  text = text.replaceAll('[[USER_MESSAGE]]', '');
  text = text.replace(delimiterMatchAll, '');
  text = joinFields(text);
  text = text.replaceAll('｜', '|');
  const runes = [...text];
  if (runes.length > timingTextLimit) text = runes.slice(0, timingTextLimit).join('') + '…';
  return text;
}

/**
 * 拼装时间合同段；没有 timing 块时返回空字符串，老镜头的提示词
 * 与引入这块之前逐字节相同。
 */
export function timingSection(s: Scene): string {
  const t = s.timing;
  if (t === null) return '';
  const data = buildSceneData(s);
  let b = '\n时间合同（强制，由 am 计算）：\n';
  b += `- 本镜头覆盖全片第 ${t.start_frame} 帧到第 ${t.end_frame_exclusive} 帧（不含），共 ${data.frames} 帧。下面所有帧号都是本镜头局部帧：0 = 本镜头第一帧，已减去全片偏移，不要再自行换算。\n`;
  if (data.phrases.length > 0) {
    b += '- 短语（编号｜原文｜局部起止帧，左闭右开｜最少可读帧数）：\n';
    for (let i = 0; i < data.phrases.length; i++) {
      const p = data.phrases[i];
      if (i === timingTableLimit) {
        b += `  其余 ${data.phrases.length - i} 条见 ${SceneDataFile}\n`;
        break;
      }
      b += `  ${p.phrase_id}｜${promptText(p.text)}｜${p.start_frame}–${p.end_frame_exclusive}｜${p.min_readable_frames}\n`;
    }
  }
  if (data.cues.length > 0) {
    b += '- 字幕（序号｜原文｜局部起止帧，左闭右开）：\n';
    for (let i = 0; i < data.cues.length; i++) {
      const c = data.cues[i];
      if (i === timingTableLimit) {
        b += `  其余 ${data.cues.length - i} 条见 ${SceneDataFile}\n`;
        break;
      }
      b += `  ${c.index}｜${promptText(c.text)}｜${c.start_frame}–${c.end_frame_exclusive}\n`;
    }
  } else {
    b += '- 本镜头范围内没有字幕，画面不得出现任何字幕文字。\n';
  }
  if (data.phrases.length > 0) {
    b +=
      '- 每个可读元素（文字、数字、标签）不得早于它对应短语的起始帧出现，可读停留不少于该短语的最少可读帧数；上表之外的短语属于其他镜头，不得出现在本镜头画面里。\n';
  } else {
    b += '- 每个可读元素（文字、数字、标签）不得早于它对应字幕的起始帧出现；上表之外的字幕属于其他镜头，其内容不得出现在本镜头画面里。\n';
  }
  b +=
    `- 本镜头目录里的 ${SceneDataFile} 以 window.AM_SCENE 提供同一份数据（帧率、帧数、画布、安全区、字幕样式、字幕与短语的局部帧）。` +
    `在 composition 里用 <script src="${SceneDataFile}"></script> 加载，帧号从中读取，不要把帧号写死在代码里；该文件由 am 生成，不要修改。\n`;
  b += lookSection(t.look);
  b += handoffSection(t, data);
  return b;
}

/** 全片配色段。没有 look 时为空，镜头照旧自主选色。 */
function lookSection(look: Look): string {
  if (lookIsZero(look)) return '';
  let b = '\n全片配色（强制，全片共用，window.AM_SCENE.look 是同一份）：\n';
  b += `- 底色 ${look.background}：画面大面积背景只用它；正文与主要文字 ${look.ink}；强调 ${look.accent}`;
  if (look.accent_2 !== '') b += `，第二强调 ${look.accent_2}`;
  if (look.surface !== '') b += `；卡片、面板等承载面 ${look.surface}`;
  b += '。\n- 允许在这几种颜色之间调透明度、明暗做层次，不得另起一套主色或换底色；跨章节时观众靠底色与配色认出这还是同一条视频。\n';
  return b;
}

/** 交接动作至少要有的帧数（30fps 下约 0.3 秒），少于它时提示词改为允许与字幕重叠。 */
const handoffMinTail = 9;

/**
 * 镜头交接段。相邻两个镜头分别渲染、互相看不到，
 * 交界能否接上只取决于两侧是否照同一份约定画出同一帧，所以这里把约定原样给两边，
 * 再把交接动作可用的空档帧算好，不让渲染器拿可读区间去做转场。
 */
export function handoffSection(t: Pick<Timing, 'enter' | 'exit'>, data: Pick<SceneData, 'frames' | 'cues'>): string {
  if (handoffIsZero(t.enter) && handoffIsZero(t.exit)) return '';
  let head = data.frames;
  let tail = data.frames;
  if (data.cues.length > 0) {
    head = data.frames;
    tail = 0;
    for (const c of data.cues) {
      head = Math.min(head, c.start_frame);
      tail = Math.max(tail, c.end_frame_exclusive);
    }
    tail = data.frames - tail;
  }
  let b = '\n镜头交接（强制，由分镜计划约定；相邻镜头分别渲染、互相看不到，两侧拿到的是同一份约定）：\n';
  const side = (label: string, h: Handoff, peerRole: string) => {
    const scope = h.cross_chapter ? '章节交界' : '章节内';
    b += `- ${label}：${peerRole} ${h.peer}（${scope}），手法 ${h.device}——${handoffGuide(h.device)}。\n`;
    b += `  交界帧：${bridgeText(h.bridge)}\n`;
  };
  if (!handoffIsZero(t.enter)) {
    side('入场', t.enter, '承接');
    b += '  本镜头第 0 帧必须就是这一帧，从它接着上一镜头的动作继续，不得重新从静止起势或另起一个开场画面。';
    if (data.cues.length === 0) b += '本镜头没有字幕，接续动作的长短按画面需要决定。\n';
    else if (head >= handoffMinTail) b += `接续动作放在第一条字幕出现之前（局部第 0 帧到第 ${head} 帧，共 ${head} 帧）。\n`;
    else b += `第一条字幕前只有 ${head} 帧，接续动作可以与开头字幕重叠，但不得遮挡字幕，可读元素照常不早于对应字幕或短语出现。\n`;
  }
  if (!handoffIsZero(t.exit)) {
    side('出场', t.exit, '交给');
    b += `  本镜头最后一帧（局部第 ${data.frames - 1} 帧）必须就是这一帧；这条覆盖「镜头结尾停在可读的终态」——有出场交接的镜头结尾停在交界帧。`;
    if (data.cues.length === 0) b += '本镜头没有字幕，出场动作的长短按画面需要决定。\n';
    else if (tail >= handoffMinTail) {
      b += `出场动作放在最后一条字幕结束之后（局部第 ${data.frames - tail} 帧到第 ${data.frames - 1} 帧，共 ${tail} 帧），之前所有可读元素保持可读。\n`;
    } else b += `最后一条字幕之后只有 ${tail} 帧，出场动作可以与结尾字幕重叠，但可读元素在最少可读帧数内不得被遮挡或移出。\n`;
  }
  b +=
    '- 运动跨过交界要连续：出场动作以加速（ease-in）进入交界帧，入场动作从交界帧以减速（ease-out）离开，两侧方向、速度一致；不得在交界帧两侧各停一次，那会让观众看到一次顿挫。\n';
  b += '- 交界帧以外的构图、版式和动效仍由你决定。整片复查会逐帧比对交界前后两帧，画面差异过大判为不合格、需要重渲染。\n';
  return b;
}

/** 清理计划里写的交界帧描述：它来自分镜计划，同样不能伪装成阶段消息或定界块。 */
function bridgeText(text: string): string {
  text = text.replaceAll('[[USER_MESSAGE]]', '');
  text = text.replace(delimiterMatchAll, '');
  return joinFields(text);
}
