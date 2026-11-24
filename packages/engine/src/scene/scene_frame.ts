import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import * as flow from '../flow';
import { goPathError } from '../gofmt';
import { type Schema as YamlSchema, unmarshal as yamlUnmarshal } from '../goyaml/decode';
import { contained, findProjectRoot, isRegularFile, projectMarker } from './scene_paths';

/** 镜头的画布规格。 */
export interface Canvas {
  widthPx: number;
  heightPx: number;
  fps: number;
}

/** 写进渲染提示词的人类可读写法。 */
export function canvasLabel(c: Canvas): string {
  return `${c.widthPx}x${c.heightPx}、${c.fps}fps`;
}

/** frame.md 里镜头层要读的那几项。 */
interface FrameTokens {
  canvas: { widthPx: number; heightPx: number; fps: number };
  audio: { finalLUFS: number | null; lufsTolerance: number | null; truePeakMax: number | null };
}

const canvasSchema: YamlSchema = {
  kind: 'struct',
  type: 'struct { WidthPx int "yaml:\\"width_px\\""; HeightPx int "yaml:\\"height_px\\""; FPS int "yaml:\\"fps\\"" }',
  fields: [
    ['width_px', 'widthPx', { kind: 'int' }],
    ['height_px', 'heightPx', { kind: 'int' }],
    ['fps', 'fps', { kind: 'int' }],
  ],
  zero: () => ({ widthPx: 0, heightPx: 0, fps: 0 }),
};

const audioSchema: YamlSchema = {
  kind: 'struct',
  type: 'struct { FinalLUFS *float64 "yaml:\\"final_integrated_lufs\\""; LUFSTolerance *float64 "yaml:\\"final_lufs_tolerance\\""; TruePeakMax *float64 "yaml:\\"true_peak_max_dbtp\\"" }',
  fields: [
    ['final_integrated_lufs', 'finalLUFS', { kind: 'ptrFloat' }],
    ['final_lufs_tolerance', 'lufsTolerance', { kind: 'ptrFloat' }],
    ['true_peak_max_dbtp', 'truePeakMax', { kind: 'ptrFloat' }],
  ],
  zero: () => ({ finalLUFS: null, lufsTolerance: null, truePeakMax: null }),
};

const frameTokensSchema: YamlSchema & { kind: 'struct' } = {
  kind: 'struct',
  type: 'scene.frameTokens',
  fields: [
    ['canvas', 'canvas', canvasSchema],
    ['audio', 'audio', audioSchema],
  ],
  zero: () => ({
    canvas: { widthPx: 0, heightPx: 0, fps: 0 },
    audio: { finalLUFS: null, lufsTolerance: null, truePeakMax: null },
  }),
};

/** 读出 frame.md 的 frontmatter 原文（--- 与 --- 之间）。 */
function frameFrontmatter(directory: string, file: string): string {
  const full = contained(directory, file, 'frame.md');
  let body: string;
  try {
    body = fs.readFileSync(full, 'utf8');
  } catch (err) {
    throw new Error(`读取画幅文件失败：${goPathError('open', full, err)}`, { cause: err });
  }
  const parts = splitN(body, '---', 3);
  if (parts.length !== 3) throw new Error(`画幅文件 ${file} 缺少 YAML frontmatter，无法确定画幅`);
  return parts[1];
}

/** Go 的 strings.SplitN(s, sep, n)。 */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (out.length < n - 1) {
    const index = rest.indexOf(sep);
    if (index < 0) break;
    out.push(rest.slice(0, index));
    rest = rest.slice(index + sep.length);
  }
  out.push(rest);
  return out;
}

/**
 * 解析 frame.md 的 frontmatter。
 *
 * 这里刻意不依赖 preset：镜头目录可以脱离项目独立运行（onset scene run <目录>），
 * 能拿到的只有文件里写的数字。
 */
function readFrameTokens(directory: string, file: string): FrameTokens {
  const text = frameFrontmatter(directory, file);
  try {
    return yamlUnmarshal<FrameTokens>(text, frameTokensSchema);
  } catch (err) {
    throw new Error(`画幅文件 ${file} 的 frontmatter 解析失败：${(err as Error).message}`, { cause: err });
  }
}

/** frame.md frontmatter 的任意值（yaml.v3 解码进 any 的结果）。 */
export function readFrameFrontmatter(directory: string, file: string): Record<string, unknown> {
  const text = frameFrontmatter(directory, file);
  const doc = parseDocument(text, { uniqueKeys: true, merge: true });
  if (doc.errors.length > 0) {
    throw new Error(`画幅文件 ${file} 的 frontmatter 解析失败：yaml: ${doc.errors[0].message.split('\n')[0]}`);
  }
  const value = doc.toJS() as unknown;
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`画幅文件 ${file} 的 frontmatter 解析失败：yaml: unmarshal errors`);
  }
  return value as Record<string, unknown>;
}

/** frame.md 在哪：镜头目录（或它的某个上级）加文件名。 */
export interface FrameSource {
  directory: string;
  file: string;
}

/** 新建项目时按画幅下发到项目根的画幅文件。 */
export const FrameFile = 'frame.md';

/**
 * 镜头的画幅从哪份 frame.md 读：先看镜头目录，再逐级向上到项目根（有 onset.conf 的那一层）。
 * 找不到项目根时只看镜头目录本身，不去翻项目外的 frame.md。都没有时为 null。
 */
export function frameSource(s: { directory: string }): FrameSource | null {
  const sceneDir = path.resolve(s.directory);
  const candidates: string[] = [];
  let projectFound = false;
  for (let dir = sceneDir; ; ) {
    candidates.push(dir);
    if (isRegularFile(path.join(dir, projectMarker))) {
      projectFound = true;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const dir of projectFound ? candidates : [sceneDir]) {
    if (isRegularFile(path.join(dir, FrameFile))) return { directory: dir, file: FrameFile };
  }
  return null;
}

/**
 * 镜头的画幅，见 frameSource。找不到 frame.md 时报错，不静默按某个默认画幅渲染：
 * 那样提示词、onset-scene.js 与产物校验会一起按错的画幅走，成片画幅错了也照样「通过」。
 */
export function sceneCanvas(s: { directory: string }): Canvas {
  const source = frameSource(s);
  if (!source) throw new Error(`找不到画幅：镜头目录 ${s.directory} 与它的上级直到项目根都没有 ${FrameFile}`);
  return canvasOf(source.directory, source.file);
}

/** 从 frame.md 读出画布；缺 width_px / height_px / fps 时报错。 */
export function canvasOf(directory: string, file: string): Canvas {
  const c = readFrameTokens(directory, file).canvas;
  if (c.widthPx <= 0 || c.heightPx <= 0 || c.fps <= 0) {
    throw new Error(`画幅文件 ${file} 的 canvas 缺少 width_px / height_px / fps`);
  }
  return { widthPx: c.widthPx, heightPx: c.heightPx, fps: c.fps };
}

/** 成片混音的响度目标，取自 frame.md 的 audio 块。 */
export interface AudioTargets {
  integratedLUFS: number;
  tolerance: number;
  truePeakMax: number;
}

/**
 * 读出 frame.md 里的成片响度目标。三个字段缺一即报错：
 * 给半套目标做比对，结论会比不比更误导。
 */
export function audioTargetsOf(directory: string, file: string): AudioTargets {
  const a = readFrameTokens(directory, file).audio;
  if (a.finalLUFS === null || a.lufsTolerance === null || a.truePeakMax === null) {
    throw new Error(`画幅文件 ${file} 的 audio 缺少 final_integrated_lufs / final_lufs_tolerance / true_peak_max_dbtp`);
  }
  return { integratedLUFS: a.finalLUFS, tolerance: a.lufsTolerance, truePeakMax: a.truePeakMax };
}

/** 项目新建时记下的渲染提示词版本；不在项目里或更早建的项目是 1。 */
export function renderPromptVersion(s: { directory: string }): number {
  const root = findProjectRoot(s.directory);
  if (!root) return 1;
  return flow.flowRecord(root)?.render_prompt ?? 1;
}
