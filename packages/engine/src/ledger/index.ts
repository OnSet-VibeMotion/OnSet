//
// 编排工具用量的账本。
//
// 渲染的用量记在每个镜头的尝试记录里；编排工具（am run、Studio 对话、整理记忆）
// 没有这样的落点，跑完只在终端打印一行，关掉就没了。账本是一份只追加的 JSONL：
// 每次调用一行，失败、取消的调用照样记——钱已经花了。
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes, marshal, sortedKeys as sortedRecord } from '../gojson';
import { newUsage, usageAdd, usageEmpty, usageJSON, type Usage } from '../tools';

// 调用来源。
export const SourceStudio = 'studio'; // Studio 的一轮对话或「开始制作」
export const SourceConsolidate = 'consolidate'; // am memory consolidate 的整理者

/**
 * 项目里的账本路径。它在 production/usage/ 下而不是 production/studio/：Studio 扫描项目时跳过这个目录，
 * 回退一轮不会把账抹掉。
 */
export function projectFile(project: string): string {
  return path.join(projectDir(project), 'orchestrator.jsonl');
}

/** 项目里账本所在的目录。 */
export function projectDir(project: string): string {
  return path.join(project, 'production', 'usage');
}

/** 一次编排调用的账。 */
export interface Entry {
  time: string;
  source: string;
  tool: string;
  /** 来自输出流或工具配置；读不到就留空。 */
  model?: string;
  session?: string;
  /** Studio 的轮次编号。 */
  turn?: string;
  /** succeeded / failed / cancelled。 */
  status: string;
  /** 为空表示这次没读到用量，汇总时标为不完整。 */
  usage?: Usage | null;
}

/** 按 Go struct 的字段顺序与 omitempty 排出可交给 gojson 的对象。 */
export function entryJSON(entry: Entry): Record<string, unknown> {
  return {
    time: entry.time,
    source: entry.source,
    tool: entry.tool,
    model: entry.model || undefined,
    session: entry.session || undefined,
    turn: entry.turn || undefined,
    status: entry.status,
    usage: entry.usage ? usageJSON(entry.usage) : undefined,
  };
}

/** Go 的 time.Now().UTC().Format(time.RFC3339)：秒级、以 Z 结尾。 */
function nowRFC3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 把一条账追加到 file。每条是一次 O_APPEND 的单行写入，并发调用不会穿插。 */
export function append(file: string, entry: Entry): void {
  if (!entry.time) entry = { ...entry, time: nowRFC3339() };
  const line = marshal(entryJSON(entry)) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, { mode: 0o644 });
}

const stringKeys = ['time', 'source', 'tool', 'model', 'session', 'turn', 'status'] as const;
const usageNumberKeys = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'turns'] as const;

/** 对应 json.Unmarshal 进 Entry：类型对不上的行算坏行。 */
function decodeEntry(line: string): Entry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entry: Entry = { time: '', source: '', tool: '', status: '' };
  for (const key of stringKeys) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return undefined;
    entry[key] = v;
  }
  const usage = raw.usage;
  if (usage !== undefined && usage !== null) {
    if (typeof usage !== 'object' || Array.isArray(usage)) return undefined;
    const u = usage as Record<string, unknown>;
    const out = newUsage();
    for (const key of usageNumberKeys) {
      const v = u[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isInteger(v)) return undefined;
      out[key] = v;
    }
    if (u.cost_usd !== undefined && u.cost_usd !== null) {
      if (typeof u.cost_usd !== 'number') return undefined;
      out.cost_usd = u.cost_usd;
    }
    if (u.partial !== undefined && u.partial !== null) {
      if (typeof u.partial !== 'boolean') return undefined;
      out.partial = u.partial;
    }
    for (const key of ['basis', 'source'] as const) {
      const v = u[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') return undefined;
      out[key] = v;
    }
    entry.usage = out;
  }
  return entry;
}

/** 读出 file 里的全部账，按写入顺序；文件不存在时返回空（null），坏行跳过。 */
export function read(file: string): Entry[] | null {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let out: Entry[] | null = null;
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    const entry = decodeEntry(line);
    if (entry) (out ??= []).push(entry);
  }
  return out;
}

/** 一组账的合计。 */
export interface Summary {
  calls: number;
  total: Usage;
  by_source: Record<string, Usage>;
  /** 键是「编排工具/模型」，模型未知时只有工具名。 */
  by_model: Record<string, Usage>;
}

/** 按 Go 的输出排出可交给 gojson 的对象（map 按键排序）。 */
export function summaryJSON(summary: Summary): Record<string, unknown> {
  const mapJSON = (m: Record<string, Usage>) =>
    sortedRecord(Object.fromEntries(Object.entries(m).map(([key, usage]) => [key, usageJSON(usage)])));
  return {
    calls: summary.calls,
    total: usageJSON(summary.total),
    by_source: mapJSON(summary.by_source),
    by_model: mapJSON(summary.by_model),
  };
}

/** 合计一组账。 */
export function summarize(entries: Entry[] | null): Summary {
  const out: Summary = { calls: 0, total: newUsage(), by_source: {}, by_model: {} };
  for (const entry of entries ?? []) {
    out.calls++;
    const usage = entry.usage ?? newUsage();
    let key = entry.tool;
    if (entry.model) key += '/' + entry.model;
    const bySource = Object.hasOwn(out.by_source, entry.source) ? out.by_source[entry.source] : newUsage();
    const byModel = Object.hasOwn(out.by_model, key) ? out.by_model[key] : newUsage();
    for (const target of [out.total, bySource, byModel]) usageAdd(target, usage);
    out.by_source[entry.source] = bySource;
    out.by_model[key] = byModel;
  }
  return out;
}

/** 返回 map 的键，按字典序（Go 的字节序）。 */
export function sortedKeys(m: Record<string, Usage>): string[] {
  return Object.keys(m).sort(compareBytes);
}

/** 从一次调用的结果组一条账：没读到用量时 usage 留空。time 由 append 补。 */
export function fromResult(
  source: string,
  tool: string,
  model: string,
  session: string,
  usage: Usage,
  err: unknown,
  cancelled: boolean,
): Entry {
  const entry: Entry = { time: '', source, tool, model, session, status: 'succeeded' };
  if (cancelled) entry.status = 'cancelled';
  else if (err) entry.status = 'failed';
  if (!usageEmpty(usage)) entry.usage = { ...usage };
  return entry;
}

/** 记忆库里的账本：整理记忆不属于哪个项目，记在记忆库里。 */
export function memoryFile(memoryDir: string): string {
  return path.join(memoryDir, 'orchestrator-usage.jsonl');
}
