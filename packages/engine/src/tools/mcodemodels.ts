/**
 * MiniMax Code（mcode）能选的模型与每个模型的推理档位。
 *
 * mcode 没有列模型的命令（`mcode provider list --json` 的 models 是空的，0.6.12 实测）。完整的模型表只在 ACP 会话的
 * 选项里给：`mcode acp` → `initialize` → `session/new`，回应的 configOptions 里 `model` 一项列出全部可选值，
 * 写成 `m:<服务商>:<模型>:v:<变体>`（同一模型「思考 / 不思考」是两项）；`thinkingEffort` 一项是当前模型的推理档位，
 * 换模型（`session/set_config_option`）后的回应里带新模型的档位，模型不推理时没有这一项。
 *
 * 整个过程不发提示词、不调模型，不花额度；会话在一个空的临时目录里开，结束时 `session/close`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { start } from '../procgroup';
import { marshal } from '../gojson';
import type { ModelOption } from './modellist';

export const McodeACPTimeout = 30_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `m:minimax:MiniMax-M3:v:thinking` → minimax/MiniMax-M3 与变体（与 agentrun/acp.ts 的 mcodeModelValue 同一种写法）。 */
function parseValue(value: string): { model: string; variant: string } | null {
  const m = /^m:([^:]+):(.+):v:([^:]*)$/.exec(value);
  return m ? { model: `${m[1]}/${m[2]}`, variant: m[3]! } : null;
}

function option(configOptions: unknown, id: string): Obj | undefined {
  return (Array.isArray(configOptions) ? configOptions.map(obj) : []).find((o) => o.id === id);
}

/** 推理档位：去掉「default」（不选就是它），只留 onset 认识的写法。 */
function efforts(configOptions: unknown): { efforts: string[]; defaultEffort?: string } {
  const effort = option(configOptions, 'thinkingEffort');
  if (!effort) return { efforts: [] };
  const values = (Array.isArray(effort.options) ? effort.options.map(obj) : []).map((o) => str(o.value)).filter((v) => /^[a-z]+$/.test(v) && v !== 'default');
  const current = str(effort.currentValue);
  return { efforts: values, ...(current && current !== 'default' ? { defaultEffort: current } : {}) };
}

/** 把 configOptions 的模型项合成模型表（变体合并）；efforts 按模型给。 */
export function mcodeModelOptions(configOptions: unknown, effortsByModel: Map<string, string[]> = new Map()): ModelOption[] {
  const model = option(configOptions, 'model');
  if (!model) return [];
  const current = parseValue(str(model.currentValue))?.model ?? '';
  const out: ModelOption[] = [];
  for (const raw of Array.isArray(model.options) ? model.options.map(obj) : []) {
    const parsed = parseValue(str(raw.value));
    if (!parsed || out.some((o) => o.id === parsed.model)) continue;
    // 显示名里的「 · thinking」是变体，不是模型名。
    const label = str(raw.name).split(' · ')[0] || parsed.model;
    const e = effortsByModel.get(parsed.model);
    out.push({ id: parsed.model, label, ...(parsed.model === current ? { isDefault: true } : {}), ...(e ? { efforts: e } : {}) });
  }
  return out;
}

/**
 * 起 `mcode acp`、开一个会话读模型表，逐个模型切一下读推理档位，拿到就关会话、结束进程。
 * binary 是已经找到的可执行文件（lookPath 之后）。
 */
export async function fetchMcodeModels(binary: string, env: Record<string, string>, signal?: AbortSignal, timeout = McodeACPTimeout): Promise<ModelOption[]> {
  signal?.throwIfAborted();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mcode-models-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`mcode 在 ${timeout / 1000} 秒内没有给出模型表`)), timeout);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let exited: Promise<void> | undefined;
  try {
    const started = await start(binary, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], signal: controller.signal });
    const child = started.child;
    const closed = started.wait();
    exited = closed;
    closed.catch(() => {});
    controller.signal.throwIfAborted();
    let nextID = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const failed = new Promise<never>((_, reject) => {
      child.stdin?.on('error', reject);
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('已取消')), { once: true });
      closed.then(
        () => reject(new Error('mcode acp 提前退出了')),
        (err: Error) => reject(new Error(`mcode acp 提前退出了：${err.message}`)),
      );
    });
    failed.catch(() => {});
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let frame: Obj;
      try {
        frame = obj(JSON.parse(line));
      } catch {
        return;
      }
      if (typeof frame.id !== 'number' || frame.method !== undefined) return;
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(str(obj(frame.error).message) || 'ACP 请求失败'));
      else waiter.resolve(frame.result);
    });
    const request = (method: string, params: unknown): Promise<Obj> => {
      const id = ++nextID;
      const reply = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin?.write(marshal({ jsonrpc: '2.0', id, method, params }) + '\n');
      return Promise.race([reply, failed]).then(obj);
    };
    let sessionId = '';
    try {
      await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'onset', version: '1' } });
      const created = await request('session/new', { cwd, mcpServers: [] });
      sessionId = str(created.sessionId);
      if (sessionId === '') throw new Error('session/new 没有返回 sessionId');
      const model = option(created.configOptions, 'model');
      const byModel = new Map<string, string[]>();
      const current = parseValue(str(model?.currentValue));
      const values = (Array.isArray(model?.options) ? model!.options.map(obj) : []).map((o) => str(o.value));
      // 推理档位只在思考变体上有：同一模型优先切到 thinking 那一项去读。
      const ordered = [...values.filter((v) => parseValue(v)?.variant === 'thinking'), ...values];
      if (current && (current.variant === 'thinking' || !values.some(v => { const parsed = parseValue(v); return parsed?.model === current.model && parsed.variant === 'thinking'; }))) {
        byModel.set(current.model, efforts(created.configOptions).efforts);
      }
      for (const value of ordered) {
        const parsed = parseValue(value);
        if (!parsed || byModel.has(parsed.model)) continue;
        try {
          const changed = await request('session/set_config_option', { sessionId, configId: 'model', value });
          byModel.set(parsed.model, efforts(changed.configOptions).efforts);
        } catch {
          // 切不过去的模型照样列出，推理档位不知道。
        }
      }
      return mcodeModelOptions(created.configOptions, byModel);
    } finally {
      if (sessionId !== '' && !controller.signal.aborted) {
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([request('session/close', { sessionId }), new Promise((r) => { closeTimer = setTimeout(r, 2000); })]);
        } catch {
          // 关不掉也无妨：会话只是一条没有消息的记录。
        } finally { clearTimeout(closeTimer); }
      }
      child.stdin?.end();
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // 等进程和输出管道都关闭后再删工作目录；启动失败也走同一条清理路径。
    controller.abort();
    await exited?.catch(() => {});
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
