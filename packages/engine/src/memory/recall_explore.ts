import crypto from 'node:crypto';
import { KindLesson, type Memory } from './memory';
import type { RecallItem, RecallResult } from './recall';

/**
 * 以 rate 的概率把注入的最后一条经验换成 omitted 里第一条换得进去的经验
 * （字数预算仍然成立）。抽签由 seed 的哈希决定，可复现。
 */
export function explore(
  r: RecallResult,
  rate: number,
  seed: string,
  itemsDigest: (items: readonly RecallItem[]) => string,
): RecallResult {
  let last = -1;
  r.items.forEach((item, i) => {
    if (item.kind === KindLesson) last = i;
  });
  if (last < 0) return r;
  const dropped = { ...r.items[last] };
  let pick = -1;
  for (let i = 0; i < r.omitted.length; i++) {
    const item = r.omitted[i];
    if (item.kind === KindLesson && r.used - dropped.chars + item.chars <= r.budget) {
      pick = i;
      break;
    }
  }
  if (pick < 0 || draw(seed) >= rate) return r;
  const out: RecallResult = { ...r };
  const added = { ...r.omitted[pick] };
  out.canonical = itemsDigest(r.items);
  added.omit_reason = '';
  const items = [...r.items];
  items[last] = added;
  const omitted = [...r.omitted.slice(0, pick), ...r.omitted.slice(pick + 1)];
  dropped.omit_reason = 'explore';
  out.items = items;
  out.omitted = [...omitted, dropped];
  out.used = r.used + added.chars - dropped.chars;
  out.explored = { dropped: dropped.name, added: added.name, propensity: rate };
  return out;
}

/**
 * 把 seed 映射到 [0, 1)：sha256 的前 8 字节按大端读成 uint64，右移 11 位留下 53 位，除以 2^53。
 * 与 Go 版逐位相同，同一个种子在两边抽到同一个结果。
 */
export function draw(seed: string): number {
  const sum = crypto.createHash('sha256').update(seed, 'utf8').digest();
  const n = sum.readBigUInt64BE(0) >> 11n;
  return Number(n) / 2 ** 53;
}

/**
 * 把试用记忆加进召回池；试用记忆是某条生效记忆的修订时，
 * 被修订的旧版本退出召回池——两版同时注入就等于并列新增。
 */
export function withExtra(memories: readonly Memory[], extra: readonly Memory[]): Memory[] {
  const replaced = new Set<string>();
  for (const m of extra) {
    if (m.revises !== '') replaced.add(m.revises);
  }
  return [...memories.filter((m) => !replaced.has(m.name)), ...extra];
}
