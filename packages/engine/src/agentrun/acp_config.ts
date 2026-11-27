/**
 * ACP 会话开出后的模型、权限与 MCP 配置（mcode、agy、opencode、codebuddy）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { effectiveOptions, type McpServer, ToolsMaxWaitEnv, ToolsServerName } from '../tools';
import { type Obj, obj, str } from './acp_protocol';
import type { Spec } from './run';

/** session/new 结果里的当前模型：models.currentModelId（codebuddy）或 configOptions 里的 model（opencode）。 */
export function acpModel(created: Obj): string {
  const models = obj(created.models);
  if (str(models.currentModelId) !== '') return str(models.currentModelId);
  const options = Array.isArray(created.configOptions) ? created.configOptions.map(obj) : [];
  const model = options.find((o) => o.id === 'model' || o.category === 'model');
  if (!model) return '';
  const value = str(model.currentValue);
  return mcodeModelValue(value)?.model ?? value;
}

/**
 * mcode 的 ACP 模型值写成 `m:<服务商>:<模型>:v:<变体>`（`m:minimax:MiniMax-M3.1-Flash:v:thinking`，0.6.12 实测），
 * 同一模型的「思考 / 不思考」是两项。onset 里模型一律记成 exec 的 --model 写法「服务商/模型」。
 */
export function mcodeModelValue(value: string): { model: string; variant: string } | null {
  const m = /^m:([^:]+):(.+):v:([^:]*)$/.exec(value);
  return m ? { model: `${m[1]}/${m[2]}`, variant: m[3]! } : null;
}

/** mcode 会话的选项（session/new 的 configOptions）里，某一项的当前值与可选值。 */
function configOption(opened: Obj, id: string): Obj | undefined {
  const options = Array.isArray(opened.configOptions) ? opened.configOptions.map(obj) : [];
  return options.find((o) => o.id === id);
}

function configOptionValue(opened: Obj, id: string): unknown {
  return configOption(opened, id)?.currentValue;
}

/**
 * mcode 会话开出来后：
 * - 权限模式（permissionMode，只对这个进程生效）：用户自己的 config.yaml 常是 bypassPermissions，安全模式必须显式切成
 *   default（Ask），白名单外的调用才会发 session/request_permission（2026-11 实测 curl 会问）；不安全模式切成 bypassPermissions。
 * - 模型：值要换成它自己的 `m:…:v:…`，同一模型优先保留当前的变体（思考与否）；
 * - 推理强度（thinkingEffort）：只有部分模型报这一项，切完模型再设，不支持时它报 Invalid params。
 * 改动后把 opened 里的当前值改掉，acpModel 读到的就是这一轮实际用的。
 */
export async function configureMcode(
  peer: { request(method: string, params: unknown): Promise<unknown> },
  sessionID: string,
  opened: Obj,
  spec: Pick<Spec, 'unsafe' | 'model' | 'options' | 'env'>,
): Promise<void> {
  mcodeAskBash(mcodeDataDir(spec.env ?? (process.env as Record<string, string>)), sessionID, !spec.unsafe);
  const set = async (configId: string, value: string): Promise<void> => {
    const result = obj(await peer.request('session/set_config_option', { sessionId: sessionID, configId, value }));
    if (Array.isArray(result.configOptions)) opened.configOptions = result.configOptions;
  };
  const mode = spec.unsafe ? 'bypassPermissions' : 'default';
  if (str(configOption(opened, 'permissionMode')?.currentValue) !== mode) await set('permissionMode', mode);
  const wanted = spec.model ?? '';
  const model = configOption(opened, 'model');
  if (wanted !== '' && model) {
    const current = mcodeModelValue(str(model.currentValue));
    if (current?.model !== wanted) {
      const choices = (Array.isArray(model.options) ? model.options.map(obj) : [])
        .map((o) => str(o.value))
        .filter((v) => mcodeModelValue(v)?.model === wanted);
      const pick = choices.find((v) => mcodeModelValue(v)?.variant === current?.variant) ?? choices[0];
      if (!pick)
        throw new Error(`MiniMax Code 没有模型 ${wanted}（写成「服务商/模型」，例如 minimax/MiniMax-M3.1-Flash）`);
      try {
        await set('model', pick);
      } catch (err) {
        throw new Error(`编排工具不接受模型 ${wanted}：${(err as Error).message}`, { cause: err });
      }
    }
  }
  const effort = effectiveOptions('mcode', spec.options).effort ?? '';
  if (effort !== '' && str(configOption(opened, 'thinkingEffort')?.currentValue) !== effort) {
    try {
      await set('thinkingEffort', effort);
    } catch (err) {
      throw new Error(`这个模型不支持推理强度「${effort}」：${(err as Error).message}`, { cause: err });
    }
  }
}

/**
 * Antigravity CLI（agy acp，1.5.13 实测）会话开出来后：
 * - 安全模式切到 accept-edits（自动批准工作区文件编辑，命令与 MCP 发 session/request_permission；不安全模式启动时已带 --dangerously-skip-permissions）。
 * - 模型：configOptions.model 接受基础模型名（如 gemini-3.8-flash），models.availableModels 含带档位的完整名（如 gemini-3.8-flash-low），两种写法都认。
 * - 推理强度（thought_level）：换完模型再设，不同模型的可选档位不一样。
 */
export async function configureAgy(
  peer: { request(method: string, params: unknown): Promise<unknown> },
  sessionID: string,
  opened: Obj,
  spec: Pick<Spec, 'unsafe' | 'model' | 'options'>,
): Promise<void> {
  const set = async (configId: string, value: string): Promise<void> => {
    const result = obj(await peer.request('session/set_config_option', { sessionId: sessionID, configId, value }));
    if (Array.isArray(result.configOptions)) opened.configOptions = result.configOptions;
  };
  if (!spec.unsafe && str(configOption(opened, 'mode')?.currentValue) !== 'accept-edits') {
    await set('mode', 'accept-edits');
  }
  const wanted = spec.model ?? '';
  if (wanted !== '') {
    const modelOpt = configOption(opened, 'model');
    const baseValues = (Array.isArray(modelOpt?.options) ? modelOpt.options.map(obj) : []).map((o) => str(o.value));
    const available = (
      Array.isArray(obj(opened.models).availableModels)
        ? (obj(opened.models).availableModels as unknown[]).map(obj)
        : []
    ).map((m) => str(m.modelId));
    try {
      if (baseValues.includes(wanted)) {
        if (str(modelOpt?.currentValue) !== wanted) await set('model', wanted);
        if (opened.models && typeof opened.models === 'object') obj(opened.models).currentModelId = wanted;
      } else if (available.includes(wanted)) {
        if (str(obj(opened.models).currentModelId) !== wanted) {
          await peer.request('session/set_model', { sessionId: sessionID, modelId: wanted });
          obj(opened.models).currentModelId = wanted;
        }
      } else if (modelOpt) {
        await set('model', wanted);
        if (opened.models && typeof opened.models === 'object') obj(opened.models).currentModelId = wanted;
      } else {
        await peer.request('session/set_model', { sessionId: sessionID, modelId: wanted });
        if (opened.models && typeof opened.models === 'object') obj(opened.models).currentModelId = wanted;
      }
    } catch (err) {
      throw new Error(`编排工具不接受模型 ${wanted}：${(err as Error).message}`, { cause: err });
    }
  }
  const effort = effectiveOptions('agy', spec.options).effort ?? '';
  if (effort !== '' && str(configOption(opened, 'thought_level')?.currentValue) !== effort) {
    try {
      await set('thought_level', effort);
    } catch (err) {
      throw new Error(`这个模型不支持推理强度「${effort}」：${(err as Error).message}`, { cause: err });
    }
  }
}

/**
 * 会话开出来后核对模型：启动参数（codebuddy 的 --model、opencode 配置里的 model）没生效时，按对方报的方式再切一次——
 * opencode 报 configOptions 里的 model 项，用 session/set_config_option；codebuddy 报 models，用 session/set_model。
 * 切完把 opened 里记的当前模型改成新的，acpModel 读到的就是这一轮实际用的。对方什么都没报时不切（不知道它认不认）。
 */
export async function ensureModel(
  peer: { request(method: string, params: unknown): Promise<unknown> },
  sessionID: string,
  opened: Obj,
  model: string,
): Promise<void> {
  // opencode 的推理档位附在模型名后（provider/model#high，见 tools/options.ts）：报回来的带不带变体都算同一个模型。
  const current = acpModel(opened);
  if (mcodeModelValue(str(configOptionValue(opened, 'model'))) !== null) return; // mcode：configureMcode 已经切过。
  if (model === '' || current === model || current.split('#')[0] === model || current === '') return;
  const options = Array.isArray(opened.configOptions) ? opened.configOptions.map(obj) : [];
  const option = options.find((o) => o.id === 'model' || o.category === 'model');
  try {
    if (option) {
      await peer.request('session/set_config_option', { sessionId: sessionID, configId: str(option.id), value: model });
      option.currentValue = model;
    } else {
      await peer.request('session/set_model', { sessionId: sessionID, modelId: model });
      obj(opened.models).currentModelId = model;
    }
  } catch (err) {
    throw new Error(`编排工具不接受模型 ${model}：${(err as Error).message}`, { cause: err });
  }
}

/**
 * ACP 的 mcpServers：stdio 服务的 env 是 {name, value} 列表。
 * agy 默认 MCP 超时 180 秒，给 onset 设 150 秒上限减少短轮询；
 * 编排档位已全局默认开启静态紧凑模式（核心精简直出 + tool_search + tool_call），所有后端均稳守 agy ~32 KB 声明预算。
 */
export function acpMcpServers(server: McpServer | undefined, tool = ''): Array<Record<string, unknown>> {
  if (!server) return [];
  const env = { ...(server.env ?? {}) };
  if (tool === 'agy' && server.name === ToolsServerName) {
    if (!env[ToolsMaxWaitEnv]) env[ToolsMaxWaitEnv] = '150';
  }
  return [
    {
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    },
  ];
}

/** mcode 的数据目录：MINIMAX_DATA_DIR，缺省 ~/.minimax。 */
export function mcodeDataDir(env: Record<string, string | undefined>): string {
  return env.MINIMAX_DATA_DIR || path.join(env.HOME || os.homedir(), '.minimax');
}

/** 「每条 shell 命令都问」这条会话规则（version 2 的写法）。 */
const askBashRule = { tool_name: 'bash', matcher: { kind: 'tool' } };
const isAskBash = (rule: unknown): boolean => {
  const r = obj(rule);
  return r.tool_name === 'bash' && obj(r.matcher).kind === 'tool';
};

/**
 * mcode 的 Ask 模式自己判断哪些命令要批准（部分交给云端判定），白名单外的 brew 有时照样直接跑（2026-11 实测），
 * 不能当闸门。它的权限规则按会话存在 `<数据目录>/sessions/<会话>/permission.json`（version 2：allow / deny / ask，
 * 每条 {tool_name, matcher}），判定顺序是 deny → ask → 安全检查 → allow，不带命令的 ask 规则让这个会话的每条 bash
 * 都来问；白名单内的由 agentrun 直接答应（commandAllowed）。用户点「允许一次」时 mcode 会往同一份文件记 allow，
 * ask 排在前面，下一次照样来问，「以后都允许」只由客户端记。安全模式加上这条，不安全模式去掉，其余规则不动。
 */
export function mcodeAskBash(dataDir: string, sessionID: string, ask: boolean): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error(`mcode 会话号不对：${sessionID}`);
  const file = path.join(dataDir, 'sessions', sessionID, 'permission.json');
  let doc: Obj = { version: 2, allow: [], deny: [], ask: [] };
  try {
    const existing = obj(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (existing.version === 2) doc = existing;
  } catch {
    // 没有或读不了：从空规则开始。
  }
  const rules = Array.isArray(doc.ask) ? doc.ask : [];
  const has = rules.some(isAskBash);
  if (has === ask) return;
  doc.ask = ask ? [...rules, askBashRule] : rules.filter((r) => !isAskBash(r));
  for (const key of ['allow', 'deny']) if (!Array.isArray(doc[key])) doc[key] = [];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWrite(file, marshalIndent(doc) + '\n', 0o600);
}
