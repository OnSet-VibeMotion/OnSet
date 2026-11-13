/**
 * 第三方站点的声明式状态（清单 nodes[].state）：读项目里一个文件的一个字段，按值落到一个状态上。
 * 不跑插件的任何代码；读不到、读坏、字段不在都各有确定的结果，不抛错（一站读坏不能拖垮整条路线）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../validate/validate';
import { toPlain } from '../validate/yamlany';
import type { DeclaredOutcome, DeclaredState } from './types';

/** 状态文件的大小上限：再大就算读不了（invalid）。 */
export const MaxStateFileBytes = 256 << 10;

export interface StateReading {
  /** 落到哪一项：cases[i]、otherwise、missing、invalid、no_field。 */
  branch: string;
  /** 落到的状态（没写的那一项是「没做」）。 */
  outcome: DeclaredOutcome;
  /** 读到的值（只有 cases 与 otherwise 有）。 */
  value?: string;
  /** 状态文件的修改时间（毫秒），文件不在为 0。 */
  mtime: number;
}

const fallback: DeclaredOutcome = { status: 'todo' };

/** 文件真实路径必须在项目里（符号链接指出去的当作不在）。 */
function inside(root: string, file: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

function lookup(data: unknown, key: readonly string[]): unknown {
  let cur = data;
  for (const k of key) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** 按声明读一次状态。 */
export function readDeclaredState(root: string, state: DeclaredState): StateReading {
  const file = path.join(root, state.file);
  let info: fs.Stats;
  try {
    info = fs.statSync(file);
  } catch {
    return { branch: 'missing', outcome: state.missing ?? fallback, mtime: 0 };
  }
  const mtime = info.mtimeMs;
  const invalid = (): StateReading => ({ branch: 'invalid', outcome: state.invalid ?? fallback, mtime });
  if (!info.isFile() || info.size > MaxStateFileBytes || !inside(root, file)) return invalid();
  let data: unknown;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (state.format === 'json') data = JSON.parse(text);
    else {
      const [front] = parseFrontmatter(state.file, text);
      data = front === null ? null : toPlain(front);
    }
  } catch {
    return invalid();
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return invalid();
  const value = lookup(data, state.key);
  if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
    return { branch: 'no_field', outcome: state.no_field ?? fallback, mtime };
  }
  const shown = String(value);
  const i = state.cases.findIndex((c) => c.is.some((x) => x === value));
  const picked = i >= 0 ? state.cases[i] : state.otherwise ?? fallback;
  const outcome: DeclaredOutcome = { status: picked.status };
  if (picked.detail !== undefined) outcome.detail = picked.detail.replaceAll('{value}', shown);
  if (picked.waiting) outcome.waiting = picked.waiting;
  if (picked.guide) outcome.guide = picked.guide;
  return { branch: i >= 0 ? `cases[${i}]` : 'otherwise', outcome, value: shown, mtime };
}
