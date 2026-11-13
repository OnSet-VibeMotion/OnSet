/**
 * 音色库：用户级目录里的一组参考音色，所有项目共用。
 *
 * 为什么要有它：只靠一句描述设计音色（Breeze 的 --instruct）每次生成都会漂。2026-11 实测
 * 同一句描述三次生成，说话人相似度（Resemblyzer 余弦）只有 0.69 / 0.69 / 0.82，听起来像换了人；
 * 拿其中一段当参考音频克隆新文案是 0.93 / 0.89。长期做一个账号要的是同一个声音，所以
 * 确认过的声音存成「参考音频 + 逐字一致的文字稿」，以后每部片子都从它克隆。
 *
 * 目录结构（<数据目录>/am/voices，AM_VOICES_DIR 覆盖）：
 *
 *   library.json          {"default": "<名字>"}
 *   <名字>/reference.wav  24kHz 单声道 16 位，由 mediaprobe 从原文件转出
 *   <名字>/voice.json     名字、文字稿、来源、当时的描述、时长、创建时间
 *
 * 音色库不在项目里：项目只记音色名（production-config.json 的 ttsVoice、角色包的 voiceId）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { newToolchain, type Toolchain } from '../mediaprobe';


/** 参考音频的文件名与规格：Breeze 的编解码器按 24kHz 单声道工作，转好了存，克隆时不用再转。 */
export const ReferenceFile = 'reference.wav';
export const ReferenceSampleRate = 24000;
const metaFile = 'voice.json';
const libraryFile = 'library.json';

/**
 * 参考音频的时长范围。太短听不出音色，克隆出来像别人；太长占满模型的上下文，
 * 合成变慢还容易串进参考里的语气。Breeze 官方示例用的是一句话（几秒到十几秒）。
 */
export const MinReferenceSeconds = 3;
export const MaxReferenceSeconds = 30;
/** 文字稿上限：参考音频最长 30 秒，按每秒 4.5 字算远不到 500 字，超了多半是贴错了。 */
export const MaxTextRunes = 500;

/** 音色从哪来：描述设计出来后确认的、用户自己录的、用户上传的别的音频。 */
export const Sources = ['designed', 'recorded', 'uploaded'] as const;
export type Source = (typeof Sources)[number];

/** voice.json 的内容。字段名就是文件里的字段名。 */
export interface Voice {
  name: string;
  /** 参考音频里说的话，逐字一致：Breeze 克隆时作为 --ref_text。 */
  text: string;
  source: Source;
  /** 设计这个音色时用的描述（source 为 designed 时有）；只作记录，克隆不用它。 */
  instruction?: string;
  duration_seconds: number;
  created: string;
}

/** 带上绝对路径的音色，给调用方直接用。 */
export interface VoiceEntry extends Voice {
  dir: string;
  audio: string;
  is_default: boolean;
}

/**
 * 音色名就是目录名：允许中文、字母、数字、连字符与下划线，首字不能是符号
 * （以 . 或 _ 开头的目录会被当成内部文件跳过），最长 40 字。
 */
export function validName(name: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u.test(name);
}

function checkName(name: string): void {
  if (!validName(name)) throw new Error(`音色名「${name}」不合法：只能用中文、字母、数字、- 和 _，首字不能是符号，最长 40 字`);
}

function readJSON(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readVoice(root: string, name: string): Voice | null {
  const raw = readJSON(path.join(root, name, metaFile));
  if (!raw || raw.name !== name || typeof raw.text !== 'string') return null;
  if (!fs.existsSync(path.join(root, name, ReferenceFile))) return null;
  const source = Sources.includes(raw.source as Source) ? (raw.source as Source) : 'uploaded';
  return {
    name,
    text: raw.text,
    source,
    ...(typeof raw.instruction === 'string' && raw.instruction !== '' ? { instruction: raw.instruction } : {}),
    duration_seconds: typeof raw.duration_seconds === 'number' ? raw.duration_seconds : 0,
    created: typeof raw.created === 'string' ? raw.created : '',
  };
}

/** 默认音色名；没设或设的音色已经不在了时为空。 */
export function defaultName(root: string): string {
  const raw = readJSON(path.join(root, libraryFile));
  const name = typeof raw?.default === 'string' ? raw.default : '';
  return name !== '' && validName(name) && readVoice(root, name) ? name : '';
}

function entry(root: string, voice: Voice, def: string): VoiceEntry {
  const dir = path.join(root, voice.name);
  return { ...voice, dir, audio: path.join(dir, ReferenceFile), is_default: voice.name === def };
}

/** 库里全部音色：默认音色在前，其余按创建时间从新到旧。读不了的目录跳过。 */
export function list(root: string): VoiceEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && validName(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const def = defaultName(root);
  const voices = names.map((name) => readVoice(root, name)).filter((v): v is Voice => v !== null);
  voices.sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return voices.map((v) => entry(root, v, def));
}

/** 按名字取一个音色；不在时抛错并列出库里有哪些。 */
export function get(root: string, name: string): VoiceEntry {
  checkName(name);
  const voice = readVoice(root, name);
  if (!voice) {
    const names = list(root).map((v) => v.name);
    throw new Error(`音色库里没有「${name}」` + (names.length > 0 ? `（现有：${names.join('、')}）` : '（音色库还是空的）'));
  }
  return entry(root, voice, defaultName(root));
}

export interface SaveOptions {
  name: string;
  /** 原始音频（任何 ffmpeg 读得了的格式）。 */
  audio: string;
  text: string;
  source: Source;
  instruction?: string;
  /** 同名音色已存在时替换它；不给就报错，免得一句话把用了几个月的声音换掉。 */
  overwrite?: boolean;
  /** 存好后设为默认音色。库里还没有默认音色时总会设。 */
  makeDefault?: boolean;
  env: Record<string, string>;
  signal?: AbortSignal;
  /** 测试注入用。 */
  toolchain?: Toolchain;
  now?: Date;
}

/**
 * 把一段确认过的声音存进音色库：转成 24kHz 单声道 WAV、检查时长，
 * 在临时目录里写好再整体换进去，失败不留半个音色。
 */
export async function save(root: string, opts: SaveOptions): Promise<VoiceEntry> {
  if (root === '') throw new Error('无法确定音色库目录：环境里没有 HOME');
  checkName(opts.name);
  const text = opts.text.trim();
  if (text === '') throw new Error('文字稿不能为空：要与参考音频里说的话逐字一致');
  if ([...text].length > MaxTextRunes) throw new Error(`文字稿超过 ${MaxTextRunes} 字：参考音频最长 ${MaxReferenceSeconds} 秒，文字稿应该只有一两句`);
  if (!Sources.includes(opts.source)) throw new Error(`来源只能是 ${Sources.join(' / ')}，收到 ${opts.source}`);
  if (!fs.existsSync(opts.audio)) throw new Error(`找不到音频文件：${opts.audio}`);
  const target = path.join(root, opts.name);
  const exists = fs.existsSync(target);
  if (exists && !opts.overwrite) throw new Error(`音色库里已经有「${opts.name}」；确实要替换它时加 overwrite`);

  fs.mkdirSync(root, { recursive: true });
  const staging = fs.mkdtempSync(path.join(root, '.saving-'));
  try {
    const t = opts.toolchain ?? newToolchain(opts.env);
    const reference = path.join(staging, ReferenceFile);
    await t.transcode(reference, ['-i', opts.audio, '-vn', '-ac', '1', '-ar', String(ReferenceSampleRate), '-c:a', 'pcm_s16le'], opts.signal);
    const duration = t.probe(reference).duration_seconds;
    if (!(duration >= MinReferenceSeconds && duration <= MaxReferenceSeconds)) {
      throw new Error(`参考音频要 ${MinReferenceSeconds} 到 ${MaxReferenceSeconds} 秒，这一段是 ${duration.toFixed(1)} 秒`);
    }
    const voice: Voice = {
      name: opts.name,
      text,
      source: opts.source,
      ...(opts.instruction && opts.instruction.trim() !== '' ? { instruction: opts.instruction.trim() } : {}),
      duration_seconds: Math.round(duration * 1000) / 1000,
      created: (opts.now ?? new Date()).toISOString(),
    };
    atomicWrite(path.join(staging, metaFile), marshalIndent(voice) + '\n');
    if (exists) {
      const old = target + '.replaced-' + process.pid;
      fs.renameSync(target, old);
      fs.renameSync(staging, target);
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, target);
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  if (opts.makeDefault || defaultName(root) === '') setDefault(root, opts.name);
  return get(root, opts.name);
}

/** 设默认音色：新项目用 Breeze 配音时直接克隆它。 */
export function setDefault(root: string, name: string): void {
  get(root, name);
  atomicWrite(path.join(root, libraryFile), marshalIndent({ default: name }) + '\n');
}

/** 删掉一个音色。删的是默认音色时，默认改成剩下的里最新的一个（没有就清空）。 */
export function remove(root: string, name: string): void {
  get(root, name);
  const wasDefault = defaultName(root) === name;
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
  if (!wasDefault) return;
  const next = list(root)[0];
  if (next) setDefault(root, next.name);
  else fs.rmSync(path.join(root, libraryFile), { force: true });
}
