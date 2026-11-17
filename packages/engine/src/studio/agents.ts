/**
 * 编排工具与渲染工具的选择。
 * agentChoice 的校验、sessionConfig 与 overrideAgents 在 sessions.ts（会话与任务都要用，放一处免得循环导入）。
 */
import * as agentrun from '../agentrun';
import * as director from '../director';
import * as config from '../config';
import { envMap, lookPath } from '../envutil';
import * as procgroup from '../procgroup';
import * as tools from '../tools';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { emit, kindNotice, sessionMetaJSON, updateMeta, validateChoice, type AgentChoice, type Session } from './sessions';
import type { Server } from './studio';

/**
 * agentOrder 是网页上编排工具的展示顺序、名称与安装入口（各家官方的安装说明页；首次引导在一家能渲染的都没装时
 * 列出来）。取值必须都在 tools.ValidTools 里，「agentOrder 覆盖全部工具」的测试守着两边一致。
 */
export const agentOrder: readonly { id: string; label: string; installURL: string }[] = [
  { id: 'claude', label: 'Claude Code', installURL: 'https://code.claude.com/docs/en/setup' },
  { id: 'codex', label: 'Codex', installURL: 'https://developers.openai.com/codex/cli' },
  { id: 'qoder', label: 'Qoder（国内版）', installURL: 'https://help.aliyun.com/zh/lingma/qoder-cli-cn-get-started-quickly' },
  { id: 'qoder-intl', label: 'Qoder（国际版）', installURL: 'https://docs.qoder.com/cli/quick-start' },
  { id: 'codebuddy', label: 'CodeBuddy', installURL: 'https://www.codebuddy.cn/docs/cli/installation' },
  { id: 'opencode', label: 'OpenCode', installURL: 'https://opencode.ai/docs/' },
  { id: 'mcode', label: 'MiniMax Code', installURL: 'https://www.npmjs.com/package/@minimax-ai/code' },
  { id: 'director', label: '制作人', installURL: '' },
];

/**
 * 从请求体读出 {tool, renderer, model, renderer_model}（Go 里内嵌在各请求结构里的 agentChoice）。
 * 模型没写是 undefined（不改），写了空串是「跟随设置」。
 */
export function decodeChoice(body: Record<string, unknown>): AgentChoice {
  const choice: AgentChoice = { tool: fieldString(body, 'tool'), renderer: fieldString(body, 'renderer') };
  if (Object.hasOwn(body, 'model')) choice.model = fieldString(body, 'model').trim();
  if (Object.hasOwn(body, 'renderer_model')) choice.rendererModel = fieldString(body, 'renderer_model').trim();
  if (Object.hasOwn(body, 'options')) choice.options = fieldString(body, 'options').trim();
  if (Object.hasOwn(body, 'renderer_options')) choice.rendererOptions = fieldString(body, 'renderer_options').trim();
  return choice;
}

/** withDefaults 用项目配置补齐没选的那一项。 */
export function withDefaults(choice: AgentChoice, cfg: config.Config): AgentChoice {
  return { ...choice, tool: choice.tool || cfg.orchestrator, renderer: choice.renderer || cfg.renderer };
}

interface AgentInfo {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  path?: string;
  /** 能不能当渲染工具（tools.ValidRenderers）。 */
  renderer: boolean;
  /** 没法用时给界面的一句说明（制作人还没填模型服务密钥）。 */
  hint?: string;
  /** 官方安装说明页；制作人随客户端下发，没有。 */
  install_url?: string;
  /** 这家能调的选项（推理强度、快速模式、上下文长度……，tools/options.ts）；界面据此画控件。 */
  option_specs: tools.AgentOptionSpec[];
}

/** executable 从调用矩阵取工具的命令名，不在这里另写一份。 */
export function executable(tool: string): string {
  try {
    const { argv } = tools.orchestratorInvocation(tool, { workdir: '.', prompt: '-', sessionID: agentrun.newSessionID(tool) });
    return argv.length > 0 ? argv[0] : tool;
  } catch {
    return tool;
  }
}

/** agentsAPI 列出五家工具在本机是否装好，以及项目配置里的默认选择。 */
export function agentsAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const pathValue = envMap().PATH ?? '';
  const agents: AgentInfo[] = agentOrder.map((a) => {
    const renderer = tools.ValidRenderers.has(a.id);
    if (a.id === director.Tool) {
      // 制作人随客户端下发，不用装；「装好」指配了一套在用的模型服务。
      const ready = director.hasService(director.defaultDir(envMap()));
      return { id: a.id, label: a.label, command: 'onset studio agent', installed: ready, renderer, option_specs: tools.agentOptionSpecs(a.id), ...(ready ? {} : { hint: '先在设置里配置一个模型服务' }) };
    }
    const info: AgentInfo = { id: a.id, label: a.label, command: executable(a.id), installed: false, renderer, install_url: a.installURL, option_specs: tools.agentOptionSpecs(a.id) };
    try {
      info.path = lookPath(info.command, pathValue);
      info.installed = true;
    } catch {
      // 没装。
    }
    return info;
  });
  // 不看项目时的渲染工具（环境变量 > 全局设置 > 默认）：新建的项目跟着它，首页与首次引导据此判断渲染工具装没装。
  const globalRenderer = config.describeSettings('', envMap()).find((r) => r.key === 'RENDERER')?.effective ?? '';
  const result: Record<string, unknown> = { agents, orchestrator: '', renderer: '', orchestrator_model: '', renderer_model: '', orchestrator_options: '', renderer_options: '', global_renderer: globalRenderer };
  try {
    const p = s.currentProject();
    try {
      const cfg = config.load(p.path, null);
      result.orchestrator = cfg.orchestrator;
      result.renderer = cfg.renderer;
      result.orchestrator_model = cfg.orchestratorModel;
      result.renderer_model = cfg.rendererModel;
      result.orchestrator_options = cfg.orchestratorOptions;
      result.renderer_options = cfg.rendererOptions;
    } catch (err) {
      result.config_error = (err as Error).message;
    }
  } catch {
    // 没有打开项目：默认选择留空。
  }
  return writeJSON(200, goMap(result));
}

/**
 * switchSessionAgents 改一个会话的编排工具或渲染工具，从下一轮起生效。换编排工具时原 CLI 会话
 * 对新工具没有意义，清掉会话 id，下一轮按续接失败的路子带上对话记录开新会话。
 */
export async function switchSessionAgents(request: Request, sess: Session): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let choice: AgentChoice;
  try {
    choice = decodeChoice(await decodeJSON(request));
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  try {
    validateChoice(choice);
  } catch (err) {
    return writeError(400, 'invalid_agent', (err as Error).message);
  }
  if (sess.meta.running_turn) return writeError(409, 'turn_running', '这一轮还在进行，结束后再换工具');
  const switched = choice.tool !== '' && choice.tool !== sess.meta.tool;
  const rendererSwitched = choice.renderer !== '' && choice.renderer !== (sess.meta.renderer ?? '');
  const modelChanged = choice.model !== undefined && choice.model !== (sess.meta.model ?? '');
  const optionsChanged = choice.options !== undefined && choice.options !== (sess.meta.options ?? '');
  updateMeta(sess, (meta) => {
    if (choice.tool !== '') meta.tool = choice.tool;
    if (choice.renderer !== '') meta.renderer = choice.renderer;
    // 换了工具又没给模型：原来的模型是给上一家选的，回到跟随设置。
    if (choice.model !== undefined) meta.model = choice.model || undefined;
    else if (switched) meta.model = undefined;
    if (choice.rendererModel !== undefined) meta.renderer_model = choice.rendererModel || undefined;
    else if (rendererSwitched) meta.renderer_model = undefined;
    // 选项同理：只对选它时的那家工具有意义。
    if (choice.options !== undefined) meta.options = choice.options || undefined;
    else if (switched) meta.options = undefined;
    if (choice.rendererOptions !== undefined) meta.renderer_options = choice.rendererOptions || undefined;
    else if (rendererSwitched) meta.renderer_options = undefined;
    if (switched) meta.cli_session_id = undefined;
  });
  if (switched) emit(sess, '', { kind: kindNotice, text: '对话改用 ' + choice.tool + '，下一轮会带上之前的对话记录开新会话' });
  // 同一家工具换模型：CLI 会话照样续接，续接时带上新模型（各家的 --model / -c model 对 resume 同样生效）。
  else if (modelChanged) emit(sess, '', { kind: kindNotice, text: choice.model ? '编排模型改为 ' + choice.model + '，下一轮起生效' : '编排模型改为跟随设置，下一轮起生效' });
  // 选项同理：codex、claude 续接时带上新的推理强度与快速模式照样生效。
  else if (optionsChanged) emit(sess, '', { kind: kindNotice, text: choice.options ? '编排选项改为 ' + choice.options + '，下一轮起生效' : '编排选项改为跟随设置，下一轮起生效' });
  return writeJSON(200, sessionMetaJSON(sess.meta));
}

/** 列模型的结果缓存：跑一次 codex debug models 要一两秒，下拉框每次打开都跑太慢。 */
const modelCache = new Map<string, { at: number; models: tools.ModelOption[] }>();
const modelCacheTTL = 10 * 60 * 1000;
/** 制作人的模型列表按服务缓存（键是服务 id、base URL 与模型）。 */
const directorModelCache = new Map<string, { at: number; models: tools.ModelOption[] }>();
const modelListTimeout = 20_000;

/** 跑 argv 收 stdout；超时、非零退出照样返回已收到的输出（codebuddy --help 之类的命令退出码不可靠）。 */
async function captureOutput(binary: string, args: string[], env: Record<string, string>): Promise<string> {
  const chunks: Buffer[] = [];
  const started = await procgroup.start(binary, args, { env, stdio: ['ignore', 'pipe', 'ignore'], signal: AbortSignal.timeout(modelListTimeout) });
  started.child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  try {
    await started.wait();
  } catch {
    // 见上。
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET /api/agents/{工具}/models：这家工具现在能选的模型（?refresh=1 不用缓存）。
 * 列表认不出或工具没装时 models 为空、附 error，界面仍能手填模型名。
 */
export async function agentModelsAPI(request: Request, rest: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const match = /^([a-z-]+)\/models$/.exec(rest);
  if (!match || !tools.ValidTools.has(match[1]!)) return writeError(404, 'unknown_agent', '不认识的工具：' + rest);
  const tool = match[1]!;
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  const cached = modelCache.get(tool);
  if (cached && !refresh && Date.now() - cached.at < modelCacheTTL) return writeJSON(200, goMap({ tool, models: cached.models }));
  const argv = tools.modelListCommand(tool);
  let models: tools.ModelOption[];
  if (tool === director.Tool) {
    // 制作人：直接问在用的模型服务；服务换了（id、base URL、模型不同）缓存就作废。
    const service = director.resolveService(director.defaultDir(envMap()));
    if (!service) return writeJSON(200, goMap({ tool, models: [], error: '还没有配置模型服务' }));
    const key = [service.id, service.base_url, service.model].join('|');
    const hit = directorModelCache.get(key);
    if (hit && !refresh && Date.now() - hit.at < modelCacheTTL) return writeJSON(200, goMap({ tool, models: hit.models }));
    try {
      models = (await director.listServiceModels(service)).map((id) => ({ id, label: id }));
    } catch (err) {
      return writeJSON(200, goMap({ tool, models: [], error: '没能从模型服务读出模型列表：' + (err as Error).message + '，可以直接填模型名' }));
    }
    directorModelCache.set(key, { at: Date.now(), models });
    return writeJSON(200, goMap({ tool, models }));
  }
  if (argv === null) {
    models = tools.parseModelList(tool, '');
  } else if (tools.isQoder(tool)) {
    // qoder 的完整模型表（说明、额度倍率、每个模型的推理档位与上下文长度）只在它的 SDK 协议里给，见 tools/qodermodels.ts；
    // 读不出来（没登录、版本不认）时退回 --list-models，至少还有名字。
    const env = envMap() as Record<string, string>;
    let binary: string;
    try {
      binary = lookPath(argv[0]!, env.PATH ?? '');
    } catch {
      return writeJSON(200, goMap({ tool, models: [], error: `找不到 ${argv[0]}，可以直接填模型名` }));
    }
    try {
      models = await tools.fetchQoderModels(tool, binary, env);
    } catch (err) {
      models = tools.parseModelList(tool, await captureOutput(binary, argv.slice(1), env).catch(() => ''));
      if (models.length === 0) return writeJSON(200, goMap({ tool, models: [], error: '没能从 ' + argv[0] + ' 读出模型列表（' + (err as Error).message + '），可以直接填模型名' }));
    }
  } else if (tool === 'mcode') {
    // mcode 的模型表只在 ACP 会话选项里给，见 tools/mcodemodels.ts。
    const env = envMap() as Record<string, string>;
    let binary: string;
    try {
      binary = lookPath(argv![0]!, env.PATH ?? '');
    } catch {
      return writeJSON(200, goMap({ tool, models: [], error: '找不到 mcode，可以直接填模型名' }));
    }
    try {
      models = await tools.fetchMcodeModels(binary, env);
    } catch (err) {
      return writeJSON(200, goMap({ tool, models: [], error: '没能从 mcode 读出模型列表（' + (err as Error).message + '），可以直接填「服务商/模型」' }));
    }
    if (models.length === 0) return writeJSON(200, goMap({ tool, models: [], error: '没能从 mcode 读出模型列表，可以直接填「服务商/模型」' }));
  } else {
    const env = envMap() as Record<string, string>;
    let binary: string;
    try {
      binary = lookPath(argv[0]!, env.PATH ?? '');
    } catch {
      return writeJSON(200, goMap({ tool, models: [], error: `找不到 ${argv[0]}，可以直接填模型名` }));
    }
    try {
      models = tools.parseModelList(tool, await captureOutput(binary, argv.slice(1), env));
    } catch (err) {
      return writeJSON(200, goMap({ tool, models: [], error: '没能列出模型：' + (err as Error).message }));
    }
    if (models.length === 0) return writeJSON(200, goMap({ tool, models: [], error: '没能从 ' + argv.join(' ') + ' 读出模型列表，可以直接填模型名' }));
  }
  modelCache.set(tool, { at: Date.now(), models });
  return writeJSON(200, goMap({ tool, models }));
}
