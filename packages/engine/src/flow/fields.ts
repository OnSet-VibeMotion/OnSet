/**
 * 解析清单与锁文件共用的小工具：取字段、校验路径、拒收不认识的字段。错误一律带上字段位置。
 */
import { compareBytes } from '../gojson';
import { ReservedPrefixes } from './scope';

export const idPattern = /^[a-z][a-z0-9-]{1,39}$/;
export const opPattern = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function str(raw: Record<string, unknown>, key: string, where: string, required = true): string {
  const v = raw[key];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && v.trim() === '')) throw new Error(`${where}.${key} 要是非空字符串`);
  return v;
}

export function strings(raw: Record<string, unknown>, key: string, where: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) throw new Error(`${where}.${key} 要是字符串数组`);
  return v as string[];
}

/** 项目里的相对路径：不能是绝对路径、不能有 `..`、不能碰客户端自己的状态。 */
export function projectPath(p: string, where: string): string {
  const norm = p.replaceAll('\\', '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')) throw new Error(`${where}：${p} 要是项目里的相对路径`);
  if (ReservedPrefixes.some((r) => norm === r.replace(/\/$/, '') || norm.startsWith(r))) throw new Error(`${where}：${p} 是 am 自己的文件，第三方站不能声明`);
  return norm;
}

/** 站目录里的相对路径（命令、提示词），不能跑出站目录。 */
export function relativeInside(p: string, where: string): void {
  const norm = p.replaceAll('\\', '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')) throw new Error(`${where}：${p} 要是站目录里的相对路径`);
}

export function knownFields(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${where} 有不认识的字段：${extra.sort(compareBytes).join('、')}`);
}
