/**
 * 输入框的「润色」：
 *
 *   POST   /api/polish   {message, view, attachments, session_id?, tool?, model?}：把用户还没发出的一句话
 *                        交给优化工具改写一次，返回 {decision, text, notes}
 *   DELETE /api/polish   取消进行中的那次
 *
 * 不写项目文件、不开轮次、不占项目写锁：一轮对话正在跑时也能润色。用的工具：设置里给「润色与检查」
 * 单选了工具时用那一家，否则跟随这个会话的编排工具（还没有会话时跟随输入框底下选的）。花的钱记进项目的账本。
 */
import * as agentrun from '../agentrun';
import * as config from '../config';
import { envMap, parsePassthrough } from '../envutil';
import { goTrimSpace } from '../gofmt';
import * as ledger from '../ledger';
import * as promptopt from '../promptopt';
import type { ViewState } from '../studioview';
import { decodeChoice } from './agents';
import { DecodeError, decodeJSON, fieldArray, fieldObject, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { getSession, kindUser, overrideAgents, sessionConfig, validateChoice, type Attachment, type Session } from './sessions';
import type { Server } from './studio';
import { describeView } from './view';

/** 每个项目同时只润色一次：再点一次就取消上一次。 */
const running = new Map<string, AbortController>();

/** 最近一条回复：最后一条用户消息之后的正文。 */
export function lastReply(sess: Session): string {
  let at = -1;
  for (let i = sess.events.length - 1; i >= 0; i--) {
    if (sess.events[i]!.kind === kindUser) {
      at = i;
      break;
    }
  }
  return sess.events
    .slice(at + 1)
    .filter((e) => e.kind === agentrun.KindText && e.text)
    .map((e) => e.text!)
    .join('\n')
    .trim();
}

export interface PolishDecoders {
  view: (v: Record<string, unknown> | undefined) => ViewState | null;
  attachments: (v: unknown[] | undefined) => Attachment[] | null;
}

export async function polishAPI(s: Server, request: Request, decode: PolishDecoders): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  if (request.method === 'DELETE') {
    running.get(p.path)?.abort();
    running.delete(p.path);
    return writeJSON(200, goMap({ ok: true }));
  }
  if (request.method !== 'POST') return methodNotAllowed('POST, DELETE');
  let message: string;
  let view: ViewState | null;
  let attachments: Attachment[] | null;
  let sess: Session | undefined;
  let cfg: config.Config;
  try {
    const body = await decodeJSON(request);
    message = fieldString(body, 'message');
    view = decode.view(fieldObject(body, 'view'));
    attachments = decode.attachments(fieldArray(body, 'attachments'));
    const id = fieldString(body, 'session_id');
    sess = id === '' ? undefined : getSession(s, p.path, id);
    if (sess) cfg = sessionConfig(p.path, sess.meta);
    else {
      const choice = decodeChoice(body);
      validateChoice(choice);
      cfg = overrideAgents(config.load(p.path, null), choice);
    }
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    return writeError(400, 'invalid_request', (err as Error).message);
  }
  if (goTrimSpace(message) === '') return writeError(400, 'invalid_request', '没有要润色的文字');

  running.get(p.path)?.abort();
  const controller = new AbortController();
  running.set(p.path, controller);
  const { tool, model, options } = promptopt.optimizerOf(cfg);
  const env = config.childEnvironment(cfg, envMap(), s.config.unsafe, parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''));
  const input: promptopt.PolishInput = {
    draft: message,
    view: describeView(view) || undefined,
    quotes: (attachments ?? []).map((a) => a.label ?? '').filter((l) => l !== ''),
    lastReply: (sess && lastReply(sess)) || undefined,
  };
  try {
    const result = await promptopt.polish(input, (prompt) =>
      promptopt.callOnce({ tool, model, options, prompt, env, unsafe: s.config.unsafe, signal: controller.signal, ledgerFile: ledger.projectFile(p.path), source: ledger.SourcePolish }),
    );
    return writeJSON(200, goMap({ decision: result.decision, text: result.text, notes: result.notes, tool, model: model || undefined }));
  } catch (err) {
    if (controller.signal.aborted) return writeError(409, 'cancelled', '已取消');
    return writeError(502, 'polish_failed', `润色没有成功：${(err as Error).message}`);
  } finally {
    if (running.get(p.path) === controller) running.delete(p.path);
  }
}
