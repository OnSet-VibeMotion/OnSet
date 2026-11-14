import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agentrun from '../agentrun';
import * as config from '../config';
import { addToolsLocation, envMap, lookPath, parsePassthrough } from '../envutil';
import * as ledger from '../ledger';
import * as tools from '../tools';
import { decodeJSONStrict, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { overrideAgents } from './sessions';

/**
 * 首页「一句话建项目」的起名：建文件夹之前，用首页选的编排工具调一次模型，按用户的话与素材
 * 起一个说清片子内容的项目名。以前直接截用户第一句话，满是「我想做一个这个内容的视频」。
 *
 * 在一个空的临时目录里、安全模式下跑，不挂 onset 的工具服务：起名只要读提示词、回一行字。
 * 这次调用花了钱，用量先存在内存里（token → 账），建项目时（createAPI 带上 naming）记进
 * 新项目的编排账本；一直没建的，过一阵丢掉。
 */

/** 起名最多等多久；超时由界面退回按第一句话起名。 */
export const NamingTimeoutMs = 45_000;
/** 每份素材摘录的字数上限；全文没必要，开头足够看出讲什么。 */
export const NamingExcerptRunes = 3000;
/** 项目名的字数上限（不含日期后缀）。 */
export const NameMaxRunes = 20;
const pendingTTL = 30 * 60_000;

/** 用户在首页给的东西：说的话，以及素材（文件名与能读出来的文字开头）。 */
export interface NamingInput {
  message: string;
  files: { name: string; text: string }[];
}

/** 写给起名的那次调用的说明。「用户的原话：」那一行是 e2e 假编排工具的取词锚点。 */
export function namingPrompt(input: NamingInput): string {
  const parts = [
    '请给一条讲解视频的项目起一个名字，用作项目文件夹名。',
    '',
    '要求：',
    '- 说清这条视频讲的是什么（主题、对象或核心观点），不要写「我想做一个视频」「这个内容」这类请求本身的话。',
    `- 不超过 ${NameMaxRunes} 个字；素材是中文就用中文。`,
    '- 不要书名号、引号、标点、斜杠与表情，不要加日期。',
    '- 不要读写任何文件、不要运行任何命令，直接回答。',
    '- 只回一行：项目名本身，不要解释。',
    '',
    '用户的原话：',
    input.message.trim() || '（没有说话，只给了素材）',
  ];
  for (const file of input.files) {
    parts.push('', `素材「${file.name}」` + (file.text.trim() ? '的开头：' : '（读不出文字，只有文件名）'));
    if (file.text.trim()) parts.push(Array.from(file.text.trim()).slice(0, NamingExcerptRunes).join(''));
  }
  return parts.join('\n') + '\n';
}

/**
 * 把模型的回答整理成一个能当文件夹名的项目名：取最后一行非空的字，去掉 Markdown、引号、书名号、
 * 「项目名：」这类前缀与路径不允许的字符，中间的标点与空白换成「-」，截到 NameMaxRunes。
 * 整理完是空的返回空串，由调用方退回旧的起名办法。
 */
export function cleanName(answer: string): string {
  const lines = answer.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !/^```/.test(line));
  let name = lines.at(-1) ?? '';
  name = name
    .replace(/^[-*#>\s]+/, '')
    .replace(/^(项目名|项目名称|名字|名称|片名|标题)\s*[:：]\s*/, '')
    .replace(/[*_`~]/g, '')
    .replace(/["'“”‘’「」『』《》〈〉【】()（）[\]]/g, '')
    .replace(/[\\/:*?<>|\u0000-\u001f]/g, ' ')
    .replace(/[，。！？、；：,.!?;:…—·]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
  name = Array.from(name).slice(0, NameMaxRunes).join('').replace(/^[-.]+|-+$/g, '');
  return name;
}

interface Pending {
  entry: ledger.Entry;
  at: number;
}

const pending = new Map<string, Pending>();

function remember(entry: ledger.Entry): string {
  const now = Date.now();
  for (const [key, item] of pending) if (now - item.at > pendingTTL) pending.delete(key);
  const token = crypto.randomBytes(8).toString('hex');
  pending.set(token, { entry, at: now });
  return token;
}

/** 建项目时把起名那次调用的账记进新项目；token 不认识（过期、重复）就算了。 */
export function recordNamingUsage(token: string, projectPath: string): void {
  const item = token ? pending.get(token) : undefined;
  if (!item) return;
  pending.delete(token);
  try {
    ledger.append(ledger.projectFile(projectPath), item.entry);
  } catch {
    // 记不进账本不影响建项目；用量是尽力记录。
  }
}

/** 起名的结果：name 为空表示没起出来（工具没装、超时、回答整理完是空的），error 说原因。 */
export interface NamingResult {
  name: string;
  token: string;
  error?: string;
}

/** 用编排工具 tool 起名。不抛错：任何失败都只让界面退回旧的起名办法。 */
export async function suggestName(tool: string, input: NamingInput, signal?: AbortSignal): Promise<NamingResult> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-naming-'));
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('起名超时')), NamingTimeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    // 空目录没有项目配置，读到的是全局设置；工具换成首页选的那家，模型跟着 overrideAgents 的规矩走。
    const cfg = overrideAgents(config.load(workdir, null), { tool, renderer: '', model: '', rendererModel: '' });
    const env = config.childEnvironment(cfg, envMap(), false, parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''));
    addToolsLocation(env);
    let text = '';
    const outcome = await agentrun.run(
      {
        tool: cfg.orchestrator,
        model: cfg.orchestratorModel,
        workdir,
        prompt: namingPrompt(input),
        access: { commands: [] },
        env,
        lookPath: (name) => lookPath(name, env.PATH ?? ''),
      },
      (event) => {
        if (event.kind === agentrun.KindText && event.text) text += event.text;
      },
      abort,
    );
    const { result, error } = outcome;
    let token = '';
    if (result.started) {
      const model = result.model || tools.configuredModel(cfg.orchestrator, env);
      token = remember(ledger.fromResult(ledger.SourceStudio, cfg.orchestrator, model, result.sessionID, result.usage, error, abort.aborted));
    }
    if (error) return { name: '', token, error: abort.aborted ? '起名超时' : error.message };
    const name = cleanName(text);
    return name ? { name, token } : { name: '', token, error: '没有拿到项目名' };
  } catch (err) {
    return { name: '', token: '', error: (err as Error).message };
  } finally {
    clearTimeout(timer);
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

/** POST /api/projects/name：{tool, message, files: [{name, text}]} → {name, naming, error?}。 */
export async function namingAPI(request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let tool = '';
  const input: NamingInput = { message: '', files: [] };
  try {
    const body = await decodeJSONStrict(request);
    tool = typeof body.tool === 'string' ? body.tool : '';
    input.message = typeof body.message === 'string' ? body.message : '';
    if (Array.isArray(body.files)) {
      for (const item of body.files.slice(0, 10)) {
        if (!item || typeof item !== 'object') continue;
        const f = item as Record<string, unknown>;
        input.files.push({ name: typeof f.name === 'string' ? f.name : '', text: typeof f.text === 'string' ? f.text : '' });
      }
    }
  } catch {
    return writeError(400, 'invalid_json', '请求不是合法 JSON');
  }
  if (tool !== '' && !tools.ValidTools.has(tool)) return writeError(400, 'invalid_tool', '未知的编排工具：' + tool);
  if (input.message.trim() === '' && input.files.length === 0) return writeError(400, 'invalid_request', '没有可以起名的内容');
  const result = await suggestName(tool, input, request.signal);
  return writeJSON(200, goMap({ name: result.name, naming: result.token || undefined, error: result.error || undefined }));
}
