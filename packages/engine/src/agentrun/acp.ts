/**
 * ACP（Agent Client Protocol）编排：opencode acp 与 codebuddy --acp。
 *
 * 一轮 = initialize → session/new（或 session/load 续接）→ session/prompt，期间对方用 session/update 推送
 * 正文、思考、工具调用与待办，用 session/request_permission 请我们批准工具调用。2026-11 用 opencode 2.1.0
 * 实测：请求里的 toolCall 带 rawInput.command；拒绝后 opencode 直接结束这一轮（stopReason cancelled），
 * 不像 claude 那样接着换做法。CodeBuddy 2.168 的审批、续接与后台子任务也经真实 CLI 验证。
 */
import {
  acpMcpServers,
  acpModel,
  configureAgy,
  configureMcode,
  ensureModel,
  mcodeAskBash,
  mcodeDataDir,
  mcodeModelValue,
} from './acp_config';
import {
  acpOutcome,
  acpPermissionTool,
  acpText,
  acpUsage,
  CodebuddyUsage,
  isAcpToolsServerCall,
  type Obj,
  obj,
  str,
} from './acp_protocol';
import { ACPTranslator } from './acp_translate';
import { type DriveContext, runInteractive } from './interactive';
import { type Event, KindError, KindSession } from './parse';
import type { Outcome, Spec } from './run';

export {
  ACPTranslator,
  acpModel,
  acpOutcome,
  acpPermissionTool,
  acpText,
  acpUsage,
  CodebuddyUsage,
  configureAgy,
  configureMcode,
  ensureModel,
  isAcpToolsServerCall,
  mcodeAskBash,
  mcodeDataDir,
  mcodeModelValue,
};

/** ACP 的协议版本（整数）。 */
export const ACPProtocolVersion = 1;

/** 编排工具用 ACP 跑一轮（argv 与额外环境由 tools.acpInvocation 给出）。 */
export function runACP(
  spec: Spec,
  emit: (event: Event) => void,
  signal: AbortSignal | undefined,
  argv: string[],
  env: Record<string, string> | undefined,
): Promise<Outcome> {
  return runInteractive(spec, emit, signal, argv, env, (ctx) => driveACP(ctx));
}

async function driveACP(ctx: DriveContext): Promise<void> {
  const { peer, spec, signal } = ctx;
  const translator = new ACPTranslator(ctx.emit);
  let loading = false;
  let denied = false;
  const requests = new CodebuddyUsage();
  let sessionID = '';
  peer.onNotification((method, params) => {
    if (method === 'opencode/session/child_update' && !loading) {
      const p = obj(params);
      if (sessionID !== '' && str(p.rootSessionId) === sessionID) translator.childUpdate(p);
      return;
    }
    if (method !== 'session/update' || loading) return; // 续接时对方会把历史重放一遍，不能当成这一轮的事件。
    const p = obj(params);
    if (sessionID !== '' && str(p.sessionId) !== '' && str(p.sessionId) !== sessionID) return;
    const update = obj(p.update);
    if (update.sessionUpdate === 'usage_update') requests.add(update);
    translator.update(update);
  });
  peer.onRequest('session/request_permission', async (params) => {
    const p = obj(params);
    translator.flush();
    // onset 自己的工具服务直接放行，不打断用户（与 codexapp.ts 同意 onset 的 elicitation 同一约定）。
    if (isAcpToolsServerCall(p.toolCall, spec.toolsServer)) return acpOutcome(p.options, { decision: 'allow' });
    const { toolName, input } = acpPermissionTool(p.toolCall);
    const answer = await ctx.decide(toolName, input);
    if (answer.decision !== 'allow' && answer.decision !== 'always') denied = true;
    return acpOutcome(p.options, answer);
  });
  const race = <T>(p: Promise<T>) => Promise.race([p, ctx.exited]);

  const init = obj(
    await race(
      peer.request('initialize', {
        protocolVersion: ACPProtocolVersion,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(spec.tool === 'opencode' ? { _meta: { 'opencode/child-session-updates': true } } : {}),
        },
        clientInfo: { name: 'onset', version: '1' },
      }),
    ),
  );
  const canLoad = obj(init.agentCapabilities).loadSession === true;
  const cwd = spec.workdir || process.cwd();
  if (spec.resume && spec.sessionID) {
    if (!canLoad) throw new Error('这个编排工具不支持续接会话（ACP loadSession）');
    loading = true;
    let loaded: Obj;
    try {
      loaded = obj(
        await race(
          peer.request('session/load', {
            sessionId: spec.sessionID,
            cwd,
            mcpServers: acpMcpServers(spec.toolsServer, spec.tool),
          }),
        ),
      );
    } finally {
      loading = false;
    }
    sessionID = spec.sessionID;
    if (spec.tool === 'mcode') await race(configureMcode(peer, sessionID, loaded, spec));
    else if (spec.tool === 'agy') await race(configureAgy(peer, sessionID, loaded, spec));
    else await race(ensureModel(peer, sessionID, loaded, spec.model ?? ''));
    ctx.result.model = acpModel(loaded);
  } else {
    const created = obj(
      await race(peer.request('session/new', { cwd, mcpServers: acpMcpServers(spec.toolsServer, spec.tool) })),
    );
    sessionID = str(created.sessionId);
    if (sessionID === '') throw new Error('session/new 没有返回 sessionId');
    if (spec.tool === 'mcode') await race(configureMcode(peer, sessionID, created, spec));
    else if (spec.tool === 'agy') await race(configureAgy(peer, sessionID, created, spec));
    else await race(ensureModel(peer, sessionID, created, spec.model ?? ''));
    ctx.result.model = acpModel(created);
  }
  ctx.emit({ kind: KindSession, session_id: sessionID });

  const onAbort = () => peer.notification('session/cancel', { sessionId: sessionID });
  signal?.addEventListener('abort', onAbort, { once: true });
  let response: Obj;
  try {
    response = obj(
      await race(
        peer.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: spec.prompt }] }),
      ),
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
    translator.flush();
  }
  const usage = acpUsage(response.usage, translator.steps(), translator.singleRequest()) ?? requests.total();
  if (usage) ctx.result.usage = usage;
  const stop = str(response.stopReason);
  if (stop === 'cancelled' && !signal?.aborted && denied) {
    // opencode 被拒后不换做法，直接结束这一轮：说清楚为什么停了，免得用户以为它卡住或做完了。
    ctx.emit({
      kind: KindError,
      text: '你拒绝了一条调用，编排工具因此结束了这一轮。可以在对话里告诉它换一种做法再继续。',
    });
  }
  if (stop === 'refusal' && !ctx.result.produced) {
    // codebuddy 把模型请求失败（例如未登录）报成 refusal，原因写在 _meta 里。
    const meta = obj(response._meta);
    const detail = Object.entries(meta).find(([key]) => key.endsWith('errorMessage'))?.[1];
    let message = '编排工具拒绝了这一轮';
    if (typeof detail === 'string') {
      try {
        message = str(obj(JSON.parse(detail)).message) || detail;
      } catch {
        message = detail;
      }
    }
    ctx.emit({ kind: KindError, text: message });
    throw new Error(message);
  }
}
