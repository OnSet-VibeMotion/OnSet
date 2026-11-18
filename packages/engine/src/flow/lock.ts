/**
 * 项目里的 onset.flow.json（LockFile）：新建时记下的流程与画幅。第三方插件不记在这里，
 * 装在用户级（installed.ts），对所有项目生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { isObject } from './fields';

export const LockFile = 'onset.flow.json';

/**
 * 新建项目记下的渲染提示词版本（FlowRecord.render_prompt）。改渲染提示词、又不想让已有项目的镜头变 Stale 时，
 * 把新内容按版本挂上、递增这个数：只有新建的项目拿到新版。
 *   2：开工须知（scene.ts 的 startSection），2026-11。
 *   3：优先查看联系表，按发现的问题复检。
 *   4：合并预览检查，正式渲染由引擎接管。
 */
export const RenderPromptVersion = 4;

/**
 * 新建项目时记下的流程（片型）与画幅。制作提示词由运行期按它组合（compose.ts）；项目用哪个流程也只看它。
 * 没有它的目录不是这一版建的项目：detectFlow 直接报错，不按标记文件推断。流程只在新建时定。
 */
export interface FlowRecord {
  /** 内置流程或内置插件的流程：speech、beat、song；第三方插件带来的流程是 x:<插件 id>。 */
  id: string;
  /** 画幅（预设 id），组合提示词时替换画幅占位符用。 */
  canvas: string;
  /**
   * 新建时用的渲染提示词版本（scene.RenderPromptVersion）。没有这一项的是更早建的项目，按 1 处理：
   * 渲染提示词在镜头指纹里，给老项目换提示词会让它所有已渲染的镜头都变 Stale，编排还可能真去重渲染。
   */
  render_prompt?: number;
}

export interface Lock {
  version: 1;
  /** 新建项目时记下的流程。 */
  production?: FlowRecord;
}

/** 读项目的锁文件；没有文件是空的。以前记在这里的 stations、flow 一概不认（插件改装在用户级，流程只在新建时定）。 */
export function readLock(root: string): Lock {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, LockFile), 'utf8');
  } catch {
    return { version: 1 };
  }
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw) || raw.version !== 1) throw new Error(`${LockFile} 格式不对`);
  const out: Lock = { version: 1 };
  const rec = raw.production;
  if (isObject(rec) && typeof rec.id === 'string' && rec.id !== '') {
    out.production = { id: rec.id, canvas: typeof rec.canvas === 'string' ? rec.canvas : '' };
    if (typeof rec.render_prompt === 'number' && Number.isInteger(rec.render_prompt) && rec.render_prompt > 0) out.production.render_prompt = rec.render_prompt;
  }
  return out;
}

export function writeLock(root: string, lock: Lock): void {
  const file = path.join(root, LockFile);
  if (!lock.production) {
    fs.rmSync(file, { force: true });
    return;
  }
  atomicWrite(file, marshalIndent(lock) + '\n', 0o644);
}

/** 新建时记下的流程；没有记录或读不了锁文件为 null。 */
export function flowRecord(root: string): FlowRecord | null {
  try {
    return readLock(root).production ?? null;
  } catch {
    return null;
  }
}

/** 记下（或换掉）项目的流程（写在锁文件最前面）。 */
export function recordFlow(root: string, rec: FlowRecord): Lock {
  const next: Lock = { version: 1, production: rec };
  writeLock(root, next);
  return next;
}
