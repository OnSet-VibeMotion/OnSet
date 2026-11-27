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
import path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import * as director from '@onset/engine/director';
import { completeToolArguments, normalizeLegacyToolCalls } from './arguments';
import { modelRuntime, projectSessionDir, ServiceProvider, serviceModel, sessionManager, toPiTool } from './pi_runtime';
import { PreviewHistory } from './preview-history';
import { rendererFileTools, rendererFileWorkflow } from './renderer-files';
import { StreamWriter } from './stream';
import { compactToolResult, toolOutputArchiveDir } from './tool-errors';
import type { AgentModule, RunOptions } from './types';

export { projectSessionDir, ServiceProvider, serviceModel };

/** pi 的内置工具里给编排用的这几个；powershell、codemode、tool_search 不要。 */
const builtinTools = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];

const GateExtension = 'onset-gate';

/**
 * 系统提示词：只交代环境与工作习惯。做什么由每一轮的提示词说（制作提示词、客户端的交互约定 studioInteraction：
 * 待办清单、choices 代码块、studio_show / studio_step 都在那里），这里不重复，免得两处说法不一。
 * 每一轮都要发、按 token 计费，所以一条一句话。成熟的编码 CLI 自带的习惯（先读后改、失败先看报错）pi 没有，要写明。
 */
const preamble = `你在一个视频项目的目录里工作，帮用户把文章做成动态视频。
- 项目里的每一步制作都有对应的工具（scene_run、align_build……）。查参数或搜扩展工具先用 tool_search({"query": "<工具名或关键词>"})，未直接暴露的扩展与第三方站工具经 tool_call({"tool": "<工具名>", "arguments": {...}}) 调用，不要猜。onset 不在终端里，不要在 bash 里找它或运行它。
- 这里的制作工具会一直等到做完才返回，渲染、拼接可能要几十分钟：直接等结果，不要中途重复发起；没有任务号，也没有 job_wait。
- 文件只在项目目录里读写，.env 里是凭据，不要读。改文件前先读它；大文件按段读，不要一次读全。
- 列目录、读写文件和查找内容优先用 ls、read、write、edit、grep、find；读取 JSON 字段可用 jq，不为这些简单操作另写 Python 或 Node 脚本。制作步骤优先用现有制作工具，只有项目特有且工具无法完成的数据处理才写脚本。
- 工具报错或命令失败时，先读报错弄清原因，再换一种做法；不要原样重试同一条调用。命令被拒绝了就换一种在白名单内的做法。
- 有好几步的工作，开工时用 TodoWrite 列出步骤，每开始、做完一步就更新一次（每次传完整清单）。
- 要用户拍板多项制作规格或选择方案时（开场方式、画风、节奏、重点章节等），优先调用 studio_ask 一次性列出清晰的多题选项让用户勾选，不要替用户决定；稿件、配音、分镜等审核关卡仍需用户在对话中亲口确认后再调用 studio_confirm。
- 回复用户时用中文，每一轮结束时说清做了什么、接下来做什么或在等用户什么。`;

const rendererPreamble = `你是制作人，当前只负责一个镜头的实现与渲染。
- 严格按本轮镜头提示词、scene.json、画幅与技能完成合成；不要规划整片、改口播稿或等待整片审批。
- ${rendererFileWorkflow}
- 源码较长时拆成 index.html、style.css、scene.js 分文件编写，首次创建可在同一轮并行调用多次 write 一次建完，减少往返轮次；用 read 按段查看源码，优先用 read/write/edit/grep/find 处理文件。
- 当前工作目录已是本镜头目录，bash 命令直接执行，不要每条命令前都加 cd。
- 画面检查与细节放大优先用 scene_preview_check（支持 frames 联系表，也支持 zoom_frame / crop 查单帧细节并自动附图）；不要重复调用 hyperframes snapshot。其他截图用 read 打开。没有收到图片时报告阻塞，不用 magick/python/ffmpeg 写脚本或字符画代替视觉验收。
- 参数不确定时先用 tool_help 查询。制作工具会一直等到执行完；不要重复提交，没有 job_wait。onset 不在终端里，不要在 bash 里运行 onset。
- 只修改当前镜头目录，技能与共享素材只读；不要读取 .env 或模型服务凭据。
- 出错先读返回原因再修复，最后核对镜头提示词要求的产物。`;

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
  const history = new PreviewHistory(req.profile === 'renderer' ? 'renderer' : 'orchestrator');
  const compactAt = Number.isSafeInteger(req.compact_at) && req.compact_at! >= 32_000 ? req.compact_at : undefined;
  let droppedPreviews = 0;
  const sessions = sessionManager(workdir, req.agent_dir, req.session_id ?? '', req.resume === true);
  const realSessionID = sessions.getSessionId();
  o.onSessionID?.(realSessionID);
  const archiveDir = toolOutputArchiveDir(realSessionID);
  const registeredToolNames = new Set(o.tools.map((t) => t.name));
  const gate: ExtensionFactory = (pi: ExtensionAPI) => {
    pi.on('session_before_compact', async () => {
      sentPreviews.clear();
    });
    // 跨镜头前缀缓存：每个镜头目录不同（scenes/scene-001 vs scene-002），pi 默认把绝对路径 cwd 写进 System Prompt，
    // 导致所有镜头在 System Prompt 就发生字节分叉、v5/v6 跨镜头缓存完全击穿。渲染档把 System Prompt 里的 <cwd> 归一化为 `.`
    // （文件与命令执行仍使用真实 workdir），并让同项目镜头共用同一个 prompt_cache_key。
    if (req.profile === 'renderer') {
      pi.on('before_agent_start', async (event) => {
        event.systemPromptOptions.cwd = '.';
        if (/<cwd>[\s\S]*?<\/cwd>/.test(event.systemPrompt)) {
          return { systemPrompt: event.systemPrompt.replace(/<cwd>[\s\S]*?<\/cwd>/, '<cwd>.</cwd>') };
        }
        return undefined;
      });
      if (req.cache_key) {
        const cacheKey = req.cache_key;
        pi.on('before_provider_request', async (event) => {
          const payload = event.payload;
          if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'prompt_cache_key' in payload) {
            (payload as Record<string, unknown>).prompt_cache_key = cacheKey;
          }
        });
      }
    }
    // message_end 在参数校验与权限闸门之前，替换结果也会写入会话，续接时保持一致。
    pi.on('message_end', async (event) => {
      if (event.message.role === 'toolResult') {
        const message = compactToolResult(event.message, req.agent_dir, archiveDir);
        return message === event.message ? undefined : { message };
      }
      if (event.message.role !== 'assistant') return;
      const completed = completeToolArguments(event.message);
      const next = normalizeLegacyToolCalls(completed ?? event.message, registeredToolNames) ?? completed;
      return next ? { message: next } : undefined;
    });
    // Old sessions keep their original records. Limit their errors & oversized bash outputs on the way back to the model.
    pi.on('context', async ({ messages }) => {
      const safe = messages.map((message) => compactToolResult(message, req.agent_dir, archiveDir));
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
      const omitted = event.content.some(
        (c) => c.type === 'text' && c.text.startsWith('Read image file [') && c.text.includes('[Image omitted:'),
      );
      if (!omitted) return;
      return {
        isError: true,
        content: [
          ...event.content,
          {
            type: 'text' as const,
            text: '读图失败：你没有收到图片，无法完成视觉验收。报告这个阻塞及图片路径；不要用 Python、字符画或像素统计代替看图，也不要据此修改镜头或宣称验收通过。',
          },
        ],
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
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((e) => e.path === `<inline:${GateExtension}>`),
    }),
    skillsOverride: (base) => ({
      ...base,
      skills:
        req.profile === 'renderer'
          ? []
          : base.skills.filter((s) => path.resolve(s.filePath).startsWith(skillsDir + path.sep)),
    }),
    agentsFilesOverride: (base) => ({
      agentsFiles:
        req.profile === 'renderer' ? [] : base.agentsFiles.filter((f) => path.resolve(f.path) === projectRules),
    }),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // pi 的「安装遥测」开关同时管给 OpenRouter、NVIDIA、OpenCode 的请求加归因头（pi-ai 的 utils/identity.js），默认开。
  // 环境变量 PI_TELEMETRY 优先于设置（pi-coding-agent 的 core/telemetry.js），所以两处都关：设置给 false，
  // 这个进程里的 PI_TELEMETRY 也写成 0（--unsafe 时子进程拿到的是用户的完整环境，里面可能有 PI_TELEMETRY=1）。
  process.env.PI_TELEMETRY = '0';
  // 编排长会话常常等待镜头渲染十几到几十分钟：Anthropic 协议默认 5 分钟短缓存会频繁过期重写，
  // 对齐 Claude CLI 的 1h 缓存策略（用户显式设了 PI_CACHE_RETENTION 时不覆盖）。
  if (req.profile !== 'renderer' && service.protocol === 'anthropic' && !process.env.PI_CACHE_RETENTION) {
    process.env.PI_CACHE_RETENTION = 'long';
  }
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
    ...(req.thinking
      ? { thinkingLevel: req.thinking as NonNullable<Parameters<typeof createAgentSession>[0]>['thinkingLevel'] }
      : {}),
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: sessions,
    // tools 是这一会话启用的全部工具名：不把 onset 的工具列进去，它们就被藏起来（只登记不启用）。
    tools: [...builtinTools, ...o.tools.map((t) => t.name)],
    customTools: [
      ...o.tools.map((tool) => toPiTool(tool, workdir, service.vision, sentPreviews)),
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
