import fs from 'node:fs';
import path from 'node:path';
import { goRound } from '../gofmt';
import { compareBytes } from '../gojson';
import * as srt from '../srt';
import { digestFile, digestString, toSlash } from './record_digest';
import { DesignFile, type Scene, sceneCanvas } from './scene';
import { localCues, localPhrases } from './scenedata';
import { parsePhraseTimeline } from './timing';

/** 镜头目录里的渲染记录文件名。 */
export const RecordFile = '.onset-render.json';

/**
 * 渲染记录的结构版本。
 *
 * 4：技能摘要收窄到各技能目录；HyperFrames 入口技能只记镜头可以读取的文档。
 * 3：发行版本与全片分镜摘要留作追溯。复用核对渲染契约和镜头自己的字段。
 * 2：镜头的输入文件按内容记（inputDigest）：scene.json 按解析后的数据，字幕与短语时间轴只记落在本镜头里的那几条。
 * 1：输入文件按字节记。旧记录照旧按字节核对（fingerprint 的 schema 参数），升级后没动过的镜头不会因为换了算法变成 Stale。
 */
export const RenderRecordSchema = 4;
export const contentSchema = 2;
export const RecordSchemaRenderContract = 3;

/** 只有改变既有镜头的渲染契约且其他指纹识别不到时才升级。 */
export const renderContract: string = '1';
export const legacyRenderContract = '1';

/** 输入文件按字节记的旧记录版本。 */
export const RecordSchemaBytes = 1;

/**
 * 一次渲染的全部输入摘要。
 *
 * parts 的键是输入项名字（prompt、renderer、onset、file:<相对路径>、skill:<技能名>），
 * 值是该项内容的 sha256。分项记下而不是只存总指纹，是为了在判定 Stale 时能说出
 * 到底是哪一项变了——只说「输入变了」的话，人还得自己去翻是谁改了什么。
 */
export interface Inputs {
  fingerprint: string;
  /** Go 的 map[string]string；nil 写成 null。 */
  parts: Record<string, string> | null;
}

/**
 * 镜头产物通过校验时写下的渲染记录。
 *
 * 它回答的问题是「这份已验收的产物，是不是由当前这套输入渲出来的」，而不是
 * 「同样的输入能不能复现它」——渲染由 AI 完成，本来就不可复现。所以指纹一致时
 * 跳过重渲染是对的，指纹不一致时也只标 Stale，仍要显式 --force 才会覆盖。
 */
export interface RenderRecord extends Inputs {
  schema: number;
  output: string;
  output_size: number;
  output_sha256: string;
  onset_version?: string;
  legacy_onset_sha256?: string;
  plan_sha256?: string;
}

/**
 * 列出镜头声明过的输入文件（相对镜头目录），即输入指纹覆盖的文件。
 * 渲染记忆冻结经历时按这份清单拷贝，与指纹同源，不会一边多一边少。
 * 扩展块的目录类输入（例如角色包）见各块的 fingerprintParts，不在这份清单里。
 */
export function inputFiles(s: Scene): string[] {
  const files = ['scene.json', s.transcript];
  if (fs.existsSync(path.join(s.directory, 'prompt.md'))) files.push('prompt.md');
  // 两段式的设计稿：有它时实现者照它做，改了它就该重渲染。没有它的镜头清单不变。
  if (fs.existsSync(path.join(s.directory, DesignFile))) files.push(DesignFile);
  return [...files, ...timingInputFiles(s)];
}

/**
 * 时间合同引用的镜头内文件，供输入指纹使用。
 *
 * 镜头局部数据 onset-scene.js 不算：它由 scene.json、字幕、frame.md 与这里的
 * 短语时间轴推出，每次渲染前重写，算进去只会重复计数。
 */
function timingInputFiles(s: Scene): string[] {
  if (s.timing === null || s.timing.phrases === '') return [];
  return [s.timing.phrases];
}

/** 本镜头在全片里的位置（裁字幕、短语时间轴用），只算一次；没有 timing 或画幅读不出时为 null。 */
export interface InputWindow {
  start: number;
  frames: number;
  fps: number;
}

export function windowOf(s: Scene): () => InputWindow | null {
  let done = false;
  let w: InputWindow | null = null;
  return () => {
    if (!done) {
      done = true;
      try {
        if (s.timing !== null) {
          const fps = sceneCanvas(s).fps;
          w = { start: s.timing.start_frame, frames: goRound(s.duration_seconds * fps), fps };
        }
      } catch {
        w = null;
      }
    }
    return w;
  };
}

/**
 * 一个输入文件按内容的摘要（file 默认是镜头目录里的 rel，旧记录核对时换成快照里的旧内容）。按字节算的话，
 * 同一份内容换个写法也算输入变了：编排工具用脚本重写 scene.json，6.100000 变成 6.1；全片字幕里另一个镜头的
 * 一条改了时间，每个镜头目录里那份字幕都变，所有镜头跟着 Stale（2026-11 实测：一个项目 24 个镜头里 18 个
 * 就这样被判要重渲染，实际一个都没受影响）。
 *
 *   scene.json        解析后按键排序重新序列化：数字写法、键的先后、缩进都不算变化
 *   字幕、短语时间轴  只记渲染器实际拿到的那几条：有 timing 的镜头是 onset-scene.js 里裁到本镜头的字幕与短语
 *                     （正文与局部帧号，scenedata 的 localCues / localPhrases），没有 timing 的镜头记全部字幕（正文与时间）
 *   其余（prompt.md） 按字节：渲染器逐字读它
 *
 * 渲染器能看到的其余信息都在提示词里，由 prompt 那一项管。读不懂（JSON 写坏、字幕格式不对）时退回按字节。
 */
export function inputDigest(
  s: Scene,
  rel: string,
  win: () => InputWindow | null,
  schema: number,
  file = path.join(s.directory, rel),
): string {
  try {
    if (rel === 'scene.json') {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        schema >= RecordSchemaRenderContract &&
        value?.timing &&
        typeof value.timing === 'object' &&
        !Array.isArray(value.timing)
      ) {
        delete value.timing.plan;
      }
      return digestString('json\n' + canonicalJSON(value));
    }
    if (rel === s.transcript) {
      const w = win();
      if (w !== null) {
        return digestString(
          'cues\n' +
            JSON.stringify(
              localCues(srt.readCues(file), w.start, w.frames, w.fps).map((c) => [
                c.text,
                c.start_frame,
                c.end_frame_exclusive,
              ]),
            ),
        );
      }
      if (s.timing === null) {
        return digestString(
          'cues\n' + JSON.stringify(srt.readCues(file).map((c) => [c.text, c.start_seconds, c.end_seconds])),
        );
      }
    }
    if (s.timing !== null && rel === s.timing.phrases) {
      const w = win();
      if (w !== null) {
        const phrases = localPhrases(parsePhraseTimeline(fs.readFileSync(file), w.fps), w.start, w.frames, w.fps);
        return digestString(
          'phrases\n' + JSON.stringify(phrases.map((p) => [p.phrase_id, p.text, p.start_frame, p.end_frame_exclusive])),
        );
      }
    }
  } catch {
    // 读不懂，按字节。
  }
  return digestFile(file);
}

/** 键按字节序排好的 JSON（数字按 JS 的最短写法）。 */
function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .sort(compareBytes)
        .map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

/**
 * 客户端每轮对话前后把项目里的文本文件按 sha256 存进 production/studio/blobs/（studio/turns.ts）。旧记录里的
 * 摘要正是那份内容的 sha256，找得到就能拿渲染时的内容按新规则比。项目根是镜头目录往上第一个有
 * onset.conf 的目录。
 */
function snapshotOf(dir: string, digest: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  for (let at = path.resolve(dir); ; ) {
    if (fs.existsSync(path.join(at, 'onset.conf'))) {
      const file = path.join(at, 'production', 'studio', 'blobs', digest);
      return fs.existsSync(file) ? file : null;
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * 镜头声明过的输入文件 rel 与渲染记录里的那一项是否一致。新记录（2）按内容比；旧记录（1）先按字节比，
 * 对不上时到客户端的快照里找渲染时那份内容，找到就两份都按内容比，找不到才算变了。
 */
export function inputMatchesRecord(
  s: Scene,
  rel: string,
  record: Pick<RenderRecord, 'schema' | 'parts'>,
  win: () => InputWindow | null = windowOf(s),
): boolean {
  const want = record.parts?.['file:' + toSlash(rel)];
  if (want === undefined) return false;
  try {
    if (record.schema >= contentSchema) return inputDigest(s, rel, win, record.schema) === want;
    const file = path.join(s.directory, rel);
    if (digestFile(file) === want) return true;
    const old = snapshotOf(s.directory, want);
    return (
      old !== null && inputDigest(s, rel, win, RenderRecordSchema, old) === inputDigest(s, rel, win, RenderRecordSchema)
    );
  } catch {
    return false;
  }
}

/**
 * 当前输入与渲染记录是否等价：指纹相同，或者变了的只有镜头的输入文件、且每个都与记录一致
 * （inputMatchesRecord：内容没变，只是写法、别的镜头的字幕变了）。onset 判断复用与镜头列表都用它。
 */
export function inputsMatchRecord(s: Scene, current: Inputs, record: RenderRecord): boolean {
  if (record.schema < RecordSchemaRenderContract && renderContract !== legacyRenderContract) return false;
  if (current.fingerprint === record.fingerprint) return true;
  if (!record.parts?.renderer || !record.parts.prompt) return false;
  const changed = renderInputChanges(current, record);
  const win = windowOf(s);
  return changed.every(
    (name) => name.startsWith('file:') && inputMatchesRecord(s, name.slice('file:'.length), record, win),
  );
}

/** 旧记录里的发行号只用于追溯。已经升级渲染契约时不能沿用旧记录。 */
export function renderInputChanges(current: Inputs, record: RenderRecord): string[] {
  const changed = changedInputs(current, record);
  if (record.schema >= RecordSchemaRenderContract) return changed;
  const renderChanges = changed.filter((name) => name !== 'onset');
  if (renderContract !== legacyRenderContract) renderChanges.push('render_contract');
  return renderChanges;
}

/** 与 other 相比内容不同、新增或消失的输入项，按名字排序。 */
export function changedInputs(inputs: Inputs, other: Inputs): string[] {
  const mine = inputs.parts ?? {};
  const theirs = other.parts ?? {};
  const changed: string[] = [];
  for (const [name, digest] of Object.entries(mine)) {
    if (theirs[name] !== digest) changed.push(name);
  }
  for (const name of Object.keys(theirs)) {
    if (!Object.hasOwn(mine, name)) changed.push(name);
  }
  return changed.sort(compareBytes);
}
