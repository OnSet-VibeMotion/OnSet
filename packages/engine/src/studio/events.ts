/**
 * Studio 里的事件（第三方站的事件钩子用）。单独一个模块、不依赖别的 studio 模块：
 * 发事件的（对话、任务、关卡、记忆）与收事件的（stations.ts）之间不形成循环引用。
 */
import type { HookEvent } from '../flow';
import type { Project, Server } from './studio';

type Listener = (s: Server, p: Project, event: HookEvent, payload: Record<string, unknown>) => void;

const listeners: Listener[] = [];

export function onStudioEvent(fn: Listener): void {
  listeners.push(fn);
}

/** 发一个事件。收事件的出错不影响发事件的一方。 */
export function emitStudioEvent(s: Server, p: Project, event: HookEvent, payload: Record<string, unknown> = {}): void {
  for (const fn of listeners) {
    try {
      fn(s, p, event, payload);
    } catch {
      // 钩子是顺手做的事，不能让对话、任务因此失败。
    }
  }
}
