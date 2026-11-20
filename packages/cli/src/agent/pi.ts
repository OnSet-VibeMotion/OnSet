/**
 * 制作人的 agent 循环：pi（@earendil-works/pi-coding-agent，MIT）。打成单独的 onset-agent.cjs，
 * 只由 onset studio agent 加载（见 command.ts）。
 *
 * pi 默认会到处找东西：~/.pi/agent 下的设置、技能、扩展、凭据，上级目录与家目录里的 AGENTS.md / CLAUDE.md，
 * 项目里的 .pi/。这些在用户机器上都可能有（开发者自己装了 pi，或别的工具留下的 CLAUDE.md），读进来就会让
 * 编排工具照着别人的规矩做片。所以这里把每一处都显式关掉或换成我们给的：
 *
 * | 东西 | 这里怎么给 |
 * |---|---|
 * | 设置 | SettingsManager.inMemory，不读 ~/.pi/agent/settings.json |
 * | 模型服务 | 父进程经 stdin 交来的 request.service 登记成服务商 onset（serviceModel），key 设成运行时 key（setRuntimeApiKey），不读也不写任何凭据文件 |
 * | 模型目录 | 只用 pi 自带的那份查上下文长度、推理参数（serviceModel），不联网刷新；缓存在 request.agent_dir 下的 models-store.json |
 * | 扩展 | 只有这里的权限闸门（extensionsOverride 去掉其余） |
 * | 技能 | 只有项目根 .agents/skills（onset init 装进去的那一份） |
 * | 上下文文件 | 只有项目根的 AGENTS.md（项目规则，project.rules 写的） |
 * | 提示词模板、主题 | 不要 |
 * | 遥测、归因头 | 关掉（enableInstallTelemetry 与 PI_TELEMETRY，见 runAgent） |
 * | 会话 | 应用数据目录：request.agent_dir 下的 sessions/<按项目路径编码>/（与 claude 的 ~/.claude、codex 的 ~/.codex 同理），不写进项目 |
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { CreateModelRuntimeOptions, ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  createReadToolDefinition,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as director from '@onset/engine/director';
import { completeToolArguments } from './arguments';
import { PreviewHistory } from './preview-history';
import { rendererFileTools, rendererFileWorkflow } from './renderer-files';
import { StreamWriter } from './stream';
import { compactToolError } from './tool-errors';
import type { AgentModule, AgentTool, RunOptions } from './types';

/** pi 的内置工具里给编排用的这几个；powershell、codemode、tool_search 不要。 */
const builtinTools = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];

const GateExtension = 'onset-gate';

/**
 * 系统提示词：只交代环境与工作习惯。做什么由每一轮的提示词说（制作提示词、客户端的交互约定 studioInteraction：
 * 待办清单、choices 代码块、studio_show / studio_step 都在那里），这里不重复，免得两处说法不一。
 * 每一轮都要发、按 token 计费，所以一条一句话。成熟的编码 CLI 自带的习惯（先读后改、失败先看报错）pi 没有，要写明。
 */
const preamble = `你在一个视频项目的目录里工作，帮用户把文章做成动态视频。
- 项目里的每一步制作都有对应的工具（scene_run、align_build……）。参数不确定时先 tool_help({"tool": "<工具名>"}) 查，不要猜。onset 不在终端里，不要在 bash 里找它或运行它。
- 这里的制作工具会一直等到做完才返回，渲染、拼接可能要几十分钟：直接等结果，不要中途重复发起；没有任务号，也没有 job_wait。
- 文件只在项目目录里读写，.env 里是凭据，不要读。改文件前先读它；大文件按段读，不要一次读全。
- 列目录、读写文件和查找内容优先用 ls、read、write、edit、grep、find；读取 JSON 字段可用 jq，不为这些简单操作另写 Python 或 Node 脚本。制作步骤优先用现有制作工具，只有项目特有且工具无法完成的数据处理才写脚本。
- 工具报错或命令失败时，先读报错弄清原因，再换一种做法；不要原样重试同一条调用。命令被拒绝了就换一种在白名单内的做法。
- 有好几步的工作，开工时用 TodoWrite 列出步骤，每开始、做完一步就更新一次（每次传完整清单）。
- 要用户拍板的事（选方案、确认稿件或分镜、几种做法里选一种）停下来问，不替用户决定。
- 回复用户时用中文，每一轮结束时说清做了什么、接下来做什么或在等用户什么。`;

const rendererPreamble = `你是制作人，当前只负责一个镜头的实现与渲染。
- 严格按本轮镜头提示词、scene.json、画幅与技能完成合成；不要规划整片、改口播稿或等待整片审批。
- ${rendererFileWorkflow}
- 用 read 按段查看源码，用 hyperframes 工具检查、截图和渲染。参数不确定时先用 tool_help 查询。
- scene_preview_check 已直接附联系表时，直接看本次结果；小字或有疑问的局部再补查。其他截图用 read 打开。没有收到图片时报告阻塞，不用脚本或字符画代替视觉验收。
- 制作工具会一直等到执行完；不要重复提交，没有 job_wait。onset 不在终端里，不要在 bash 里运行 onset。
- 只修改当前镜头目录，技能与共享素材只读；不要读取 .env 或模型服务凭据。
- 出错先读返回原因再修复，最后核对镜头提示词要求的产物。`;

type CredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>;
type Credential = Awaited<ReturnType<CredentialStore['read']>>;

/**
 * 只在内存里的凭据：不给 pi authPath（它默认读写 agent_dir/auth.json，那份文件在客户端里是加密的，
 * 也不该让制作人自己去读）。key 由 setRuntimeApiKey 设进来，进程退出就没了。
 */
function memoryCredentials(): CredentialStore {
  const store = new Map<string, NonNullable<Credential>>();
  return {
    read: async (id) => store.get(id),
    list: async () => [...store.entries()].map(([providerId, c]) => ({ providerId, type: c.type })),
    modify: async (id, fn) => {
      const next = await fn(store.get(id));
      if (next) store.set(id, next);
      return store.get(id);
    },
    delete: async (id) => {
      store.delete(id);
    },
  };
}

async function modelRuntime(agentDir: string): Promise<ModelRuntime> {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  return ModelRuntime.create({
    credentials: memoryCredentials(),
    // 不读用户自己的 ~/.pi/agent/models.json；自定义服务商以后经设置页写进 agent_dir。
    modelsPath: null,
    modelsStorePath: path.join(agentDir, 'models-store.json'),
    // 模型目录用 pi 自带的那份，不在开工时联网刷新：国内网络下这一步可能卡住。
    allowModelNetwork: false,
  });
}

/** 用户的模型服务在 pi 里登记成的服务商 id。 */
export const ServiceProvider = 'onset';

/** 没在 pi 目录里查到这个模型时的缺省：够做片的上下文，又不至于让服务拒绝请求。 */
const fallbackContextWindow = 128_000;
const fallbackMaxTokens = 16_384;

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/**
 * 把一套模型服务登记成 pi 的服务商 onset，返回要用的模型。协议决定 pi 用哪种接口（openai-completions 或
 * anthropic-messages），各家 OpenAI 兼容端点的差异（DeepSeek 的 reasoning_content、Kimi、GLM……）由 pi 按 base URL
 * 自己认（pi-ai 的 openai-completions detectCompat）。pi 自带目录里有同一 base URL、同一模型名的，
 * 沿用它的上下文长度与推理（预设就是照目录写的，见 director.Presets）；查不到时按不推理、128K 上下文。
 * 能不能看图只按服务上用户写的那一项。
 */
export async function serviceModel(runtime: ModelRuntime, service: director.ResolvedService, modelId: string): Promise<Model<Api>> {
  const api = director.piApi(service.protocol);
  const baseUrl = trimSlash(service.base_url);
  const same = runtime.getModels().filter((m) => m.id === modelId && trimSlash(m.baseUrl) === baseUrl);
  // 上下文长度、推理与价格不随接口变（OpenAI 在目录里是 Responses 接口，这里走 Chat Completions）；接口特有的参数只在接口相同时沿用。
  const known = same.find((m) => m.api === api) ?? same[0];
  const sameApi = known?.api === api;
  runtime.registerProvider(ServiceProvider, {
    name: service.name,
    baseUrl,
    api,
    models: [
      {
        id: modelId,
        name: modelId,
        api,
        baseUrl,
        input: service.vision ? ['text', 'image'] : ['text'],
        cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: known?.reasoning ?? false,
        contextWindow: known?.contextWindow ?? fallbackContextWindow,
        maxTokens: known?.maxTokens ?? fallbackMaxTokens,
        ...(sameApi && known.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
        ...(sameApi && known.promptCache ? { promptCache: known.promptCache } : {}),
        ...(sameApi && known.compat ? { compat: known.compat } : {}),
      },
    ],
  });
  // 本机的服务常常不要 key，但 pi 没有 key 就当这家没配置；随便给一个，服务不看它。
  await runtime.setRuntimeApiKey(ServiceProvider, service.key || 'none');
  const model = runtime.getModel(ServiceProvider, modelId);
  if (!model) throw new Error(`制作人没能登记模型 ${modelId}`);
  return model;
}

function toPiTool(tool: AgentTool, workdir: string, vision: boolean, sent: Set<string>) {
  const read = tool.name === 'scene_preview_check' && vision ? createReadToolDefinition(workdir) : null;
  return defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
    // pi 自带的 read、bash 这些保持 pi 的默认（并行）；onset 的写操作顺序执行，见 AgentTool.sequential。
    executionMode: tool.sequential ? 'sequential' : 'parallel',
    async execute(id, params, signal, _update, ctx) {
      const r = await tool.execute((params ?? {}) as Record<string, unknown>, signal);
      if (r.isError) throw new Error(r.text);
      const reply = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
      if (!r.imagePath) return reply(r.text);
      if (!read) return reply(r.text + '\n模型未开启视觉，联系表未送入模型；报告画面验收阻塞。');
      try {
        const file = fs.realpathSync(r.imagePath);
        const rel = path.relative(fs.realpathSync(workdir), file).split(path.sep).join('/');
        if (!/^\.onset\/preview-[^/]+\/contact-sheet\.(?:png|jpe?g)$/i.test(rel)) {
          return reply(r.text + '\n联系表位置异常，未附图。请重新生成预览。');
        }
        const stat = fs.statSync(file, { bigint: true });
        if (!stat.isFile() || stat.size > 24n * 1024n * 1024n) return reply(r.text + '\n联系表无法直接附图。请核查预览文件或按需查看单帧。');
        const identity = JSON.stringify([file, stat.size.toString(), stat.ctimeNs.toString()]);
        if (sent.has(identity)) return reply(r.text + '\n同一张联系表已在当前上下文中，可沿用上次看图结论。');
        const result = await read.execute(id, { path: file }, signal, undefined, ctx);
        const image = result.content.find(block => block.type === 'image');
        if (image) {
          if (sent.size >= 32) sent.clear();
          sent.add(identity);
          return { content: [...reply(r.text).content, image], details: undefined };
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      return reply(r.text + '\n联系表附图失败，必要时用 read 查看以上路径；未收到图时不能完成视觉验收。');
    },
  });
}

/**
 * 这个项目的会话目录：sessions/--<项目绝对路径，分隔符换成 ->--。编码照 pi 自己的默认目录写（它没导出这个函数），
 * 同一个项目在 pi 命令行里与这里落在同一处，方便排查。
 */
export function projectSessionDir(agentDir: string, workdir: string): string {
  const safe = `--${path.resolve(workdir).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(director.sessionsDir(agentDir), safe);
}

/** 按会话 id 找会话文件：文件名以 _<id>.jsonl 结尾。 */
function findSession(dir: string, sessionID: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return '';
  }
  const name = names.find((n) => n.endsWith('_' + sessionID + '.jsonl'));
  return name ? path.join(dir, name) : '';
}

/**
 * 会话文件放在应用数据目录（agent_dir/sessions/<按项目路径编码>/，见 projectSessionDir），不写进项目：
 * 项目目录里的东西会被轮次快照、归档、同步盘带走，也会出现在用户的文件树里；整理经验这类不在项目里跑的调用
 * 也不该往工作目录里留会话。续接时先找这个项目的目录，项目挪过位置就到整个 sessions/ 下按 id 找。
 */
function sessionManager(workdir: string, agentDir: string, sessionID: string, resume: boolean): SessionManager {
  const dir = projectSessionDir(agentDir, workdir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!resume) return SessionManager.create(workdir, dir);
  let file = findSession(dir, sessionID);
  if (file === '') {
    const root = director.sessionsDir(agentDir);
    for (const sub of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      file = findSession(path.join(root, sub), sessionID);
      if (file !== '') break;
    }
  }
  if (file === '') throw new Error(`找不到制作人的会话 ${sessionID}`);
  // 工作目录以这一次为准（项目可能挪过）；之后的新分支照样建在这个项目的目录里。
  return SessionManager.open(file, dir, workdir);
}

export const runAgent: AgentModule['runAgent'] = async (o: RunOptions) => {
  const req = o.request;
  const workdir = path.resolve(req.workdir);
  if (req.agent_dir === '') throw new Error('没有制作人的数据目录（agent_dir）');
  const runtime = await modelRuntime(req.agent_dir);

  const service = req.service;
  if (!service) throw new Error(director.NoServiceMessage);
  let selected: Model<Api> | undefined;
  let model: string;
  if (o.setupModels) {
    // 测试：登记假服务商，返回「服务商/模型」；key 照正式路径来自请求。
    const ref = await o.setupModels(runtime);
    const i = ref.indexOf('/');
    await runtime.setRuntimeApiKey(ref.slice(0, i), service.key || 'none');
    selected = runtime.getModel(ref.slice(0, i), ref.slice(i + 1));
    model = ref;
  } else {
    model = director.effectiveModel(req.model ?? '', service);
    if (model === '') throw new Error(director.NoServiceMessage);
    selected = await serviceModel(runtime, service, model);
  }
  if (!selected) throw new Error(`制作人不认识模型 ${model}`);

  const sentPreviews = new Set<string>();
  const history = new PreviewHistory();
  const compactAt = req.profile === 'renderer' && Number.isSafeInteger(req.compact_at) && req.compact_at! >= 32_000 ? req.compact_at : undefined;
  let droppedPreviews = 0;
  const gate: ExtensionFactory = (pi: ExtensionAPI) => {
    pi.on('session_before_compact', async () => { sentPreviews.clear(); });
    // message_end 在参数校验与权限闸门之前，替换结果也会写入会话，续接时保持一致。
    pi.on('message_end', async (event) => {
      if (event.message.role === 'toolResult') {
        const message = compactToolError(event.message, req.agent_dir);
        return message === event.message ? undefined : { message };
      }
      if (event.message.role !== 'assistant') return;
      const message = completeToolArguments(event.message);
      return message ? { message } : undefined;
    });
    // Old sessions keep their original records. Limit their errors on the way back to the model.
    pi.on('context', async ({ messages }) => {
      const safe = messages.map(message => compactToolError(message, req.agent_dir));
      if (!compactAt) return { messages: safe };
      const projected = history.project(safe, compactAt);
      if (projected.trimmed) {
        droppedPreviews += projected.trimmed;
        sentPreviews.clear();
      }
      return { messages: projected.messages };
    });
    pi.on('tool_call', async (event) => {
      const reason = await o.gate(event.toolName, (event.input ?? {}) as Record<string, unknown>, o.signal);
      return reason === null ? undefined : { block: true, reason };
    });
    pi.on('tool_result', async (event) => {
      if (event.toolName !== 'read') return;
      // pi 的 read 把解码/缩放失败当成功返回一句省略提示。明确报错，免得模型靠脚本猜画面。
      const omitted = event.content.some(c => c.type === 'text'
        && c.text.startsWith('Read image file [') && c.text.includes('[Image omitted:'));
      if (!omitted) return;
      return {
        isError: true,
        content: [...event.content, {
          type: 'text' as const,
          text: '读图失败：你没有收到图片，无法完成视觉验收。报告这个阻塞及图片路径；不要用 Python、字符画或像素统计代替看图，也不要据此修改镜头或宣称验收通过。',
        }],
      };
    });
  };
  const skillsDir = path.join(workdir, '.agents', 'skills');
  const projectRules = path.join(workdir, 'AGENTS.md');
  const loader = new DefaultResourceLoader({
    cwd: workdir,
    agentDir: req.agent_dir,
    extensionFactories: [{ name: GateExtension, factory: gate }],
    // 不加载任何发现到的扩展（项目里的 .pi/extensions 是会被执行的代码），只留下面的权限闸门。
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: req.profile === 'renderer' ? rendererPreamble : preamble,
    extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => e.path === `<inline:${GateExtension}>`) }),
    skillsOverride: (base) => ({ ...base, skills: req.profile === 'renderer' ? [] : base.skills.filter((s) => path.resolve(s.filePath).startsWith(skillsDir + path.sep)) }),
    agentsFilesOverride: (base) => ({ agentsFiles: req.profile === 'renderer' ? [] : base.agentsFiles.filter((f) => path.resolve(f.path) === projectRules) }),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // pi 的「安装遥测」开关同时管给 OpenRouter、NVIDIA、OpenCode 的请求加归因头（pi-ai 的 utils/identity.js），默认开。
  // 环境变量 PI_TELEMETRY 优先于设置（pi-coding-agent 的 core/telemetry.js），所以两处都关：设置给 false，
  // 这个进程里的 PI_TELEMETRY 也写成 0（--unsafe 时子进程拿到的是用户的完整环境，里面可能有 PI_TELEMETRY=1）。
  process.env.PI_TELEMETRY = '0';
  const settings = SettingsManager.inMemory({
    enableInstallTelemetry: false,
    // 只在制作任务需要时调用模型，避免后台保温额外消耗 token。
    cacheWarming: 'off',
    // 全文摘要沿用 SDK 的安全阈值，避免提前改写大量已缓存的输入。
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });
  const { session } = await createAgentSession({
    cwd: workdir,
    agentDir: req.agent_dir,
    model: selected,
    // 设置里选的思考强度；pi 会按模型能力收窄（不支持思考的模型照常跑）。
    ...(req.thinking ? { thinkingLevel: req.thinking as NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"] } : {}),
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: sessionManager(workdir, req.agent_dir, req.session_id ?? '', req.resume === true),
    // tools 是这一会话启用的全部工具名：不把 onset 的工具列进去，它们就被藏起来（只登记不启用）。
    tools: [...builtinTools, ...o.tools.map((t) => t.name)],
    customTools: [
      ...o.tools.map(tool => toPiTool(tool, workdir, service.vision, sentPreviews)),
      ...(req.profile === 'renderer' ? rendererFileTools(workdir) : []),
    ],
  });
  const writer = new StreamWriter(o.write);
  const onAbort = () => void session.abort();
  try {
    await session.bindExtensions({});
    writer.init(session.sessionId, model);
    session.subscribe((event) => writer.event(event));
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let error = '';
    try {
      await session.prompt(req.prompt);
    } catch (err) {
      error = (err as Error).message;
    }
    if (error === '') error = writer.error();
    if (o.signal?.aborted) error = '已取消';
    writer.result(error, droppedPreviews);
    return error === '' ? { ok: true } : { ok: false, error };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    session.dispose();
  }
};
