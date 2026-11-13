/**
 * 导演的 agent 循环：pi（@earendil-works/pi-coding-agent，MIT）。打成单独的 am-agent.cjs，
 * 只由 am studio agent 加载（见 command.ts）。
 *
 * pi 默认会到处找东西：~/.pi/agent 下的设置、技能、扩展、凭据，上级目录与家目录里的 AGENTS.md / CLAUDE.md，
 * 项目里的 .pi/。这些在用户机器上都可能有（开发者自己装了 pi，或别的工具留下的 CLAUDE.md），读进来就会让
 * 编排工具照着别人的规矩做片。所以这里把每一处都显式关掉或换成我们给的：
 *
 * | 东西 | 这里怎么给 |
 * |---|---|
 * | 设置 | SettingsManager.inMemory，不读 ~/.pi/agent/settings.json |
 * | 凭据 | 只在内存里：父进程经 stdin 交来的 request.keys，设成运行时 key（setRuntimeApiKey），不读也不写任何凭据文件 |
 * | 模型缓存 | request.agent_dir 下的 models-store.json，不联网刷新模型目录 |
 * | 扩展 | 只有这里的权限闸门（extensionsOverride 去掉其余） |
 * | 技能 | 只有项目根 .agents/skills（am init 装进去的那一份） |
 * | 上下文文件 | 只有项目根的 AGENTS.md（项目规则，project.rules 写的） |
 * | 提示词模板、主题 | 不要 |
 * | 会话 | 应用数据目录：request.agent_dir 下的 sessions/<按项目路径编码>/（与 claude 的 ~/.claude、codex 的 ~/.codex 同理），不写进项目 |
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CreateModelRuntimeOptions, ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as director from '@am/engine/director';
import { StreamWriter } from './stream';
import type { AgentModule, AgentTool, RunOptions } from './types';

/** pi 的内置工具里给编排用的这几个；powershell、codemode、tool_search 不要。 */
const builtinTools = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];

const GateExtension = 'am-gate';

/** 系统提示词的开头。具体做什么由每一轮的提示词说（制作提示词、客户端的交互约定），这里只交代环境。 */
const preamble = `你在一个视频项目的目录里工作，帮用户把文章做成动态视频。项目里的每一步制作都有对应的工具（beat_import、scene_run、align_build……），参数与用法用 tool_help 查；不要在终端里找 am 这个命令，它不在那里。
文件只在项目目录里读写。.env 里是凭据，不要读。要运行的命令在安全模式下有白名单，白名单外的会先问用户，被拒绝了就换一种做法。
回复用户时用中文，说清做了什么、接下来要什么。`;

type CredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>;
type Credential = Awaited<ReturnType<CredentialStore['read']>>;

/**
 * 只在内存里的凭据：不给 pi authPath（它默认读写 agent_dir/auth.json，那份文件在客户端里是加密的，
 * 也不该让导演自己去读）。key 由 setRuntimeApiKey 设进来，进程退出就没了。
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

/** 父进程交来的 key 设成运行时 key（只在内存里）。 */
async function applyKeys(runtime: ModelRuntime, keys: Record<string, string> | undefined): Promise<void> {
  for (const [provider, key] of Object.entries(keys ?? {})) {
    if (key !== '') await runtime.setRuntimeApiKey(provider, key);
  }
}

function splitModel(model: string): { provider: string; id: string } {
  const provider = director.providerOf(model);
  return { provider, id: provider === '' ? model : model.slice(provider.length + 1) };
}

function toPiTool(tool: AgentTool) {
  return defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
    async execute(_id, params, signal) {
      const r = await tool.execute((params ?? {}) as Record<string, unknown>, signal);
      if (r.isError) throw new Error(r.text);
      return { content: [{ type: 'text', text: r.text }], details: undefined };
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
  if (file === '') throw new Error(`找不到导演的会话 ${sessionID}`);
  // 工作目录以这一次为准（项目可能挪过）；之后的新分支照样建在这个项目的目录里。
  return SessionManager.open(file, dir, workdir);
}

export const runAgent: AgentModule['runAgent'] = async (o: RunOptions) => {
  const req = o.request;
  const workdir = path.resolve(req.workdir);
  if (req.agent_dir === '') throw new Error('没有导演的数据目录（agent_dir）');
  const runtime = await modelRuntime(req.agent_dir);

  let model = req.model ?? '';
  if (o.setupModels) model = await o.setupModels(runtime);
  await applyKeys(runtime, req.keys);
  const keyed = Object.keys(req.keys ?? {}).filter((p) => req.keys![p] !== '');
  model = director.pickModel(model, keyed);
  if (model === '') throw new Error(director.NoModelMessage);
  const { provider, id } = splitModel(model);
  const selected = runtime.getModel(provider, id);
  if (!selected) throw new Error(`导演不认识模型 ${model}（写成「服务商/模型」，例如 ${director.Providers[0]!.defaultModel}）`);
  if (!keyed.includes(provider) && !runtime.hasConfiguredAuth(provider)) throw new Error(`还没有填 ${provider} 的 API key：请在设置里填写`);

  const gate: ExtensionFactory = (pi: ExtensionAPI) => {
    pi.on('tool_call', async (event) => {
      const reason = await o.gate(event.toolName, (event.input ?? {}) as Record<string, unknown>, o.signal);
      return reason === null ? undefined : { block: true, reason };
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
    systemPrompt: preamble,
    extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => e.path === `<inline:${GateExtension}>`) }),
    skillsOverride: (base) => ({ ...base, skills: base.skills.filter((s) => path.resolve(s.filePath).startsWith(skillsDir + path.sep)) }),
    agentsFilesOverride: (base) => ({ agentsFiles: base.agentsFiles.filter((f) => path.resolve(f.path) === projectRules) }),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const settings = SettingsManager.inMemory({
    // 整片制作一轮能跑很久，上下文快满时自动压缩；完整记录仍在会话文件里。
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });
  const { session } = await createAgentSession({
    cwd: workdir,
    agentDir: req.agent_dir,
    model: selected,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: sessionManager(workdir, req.agent_dir, req.session_id ?? '', req.resume === true),
    // tools 是这一会话启用的全部工具名：不把 am 的工具列进去，它们就被藏起来（只登记不启用）。
    tools: [...builtinTools, ...o.tools.map((t) => t.name)],
    customTools: o.tools.map(toPiTool),
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
    writer.result(error);
    return error === '' ? { ok: true } : { ok: false, error };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    session.dispose();
  }
};

/** 列模型只要服务商 id（configuredProviders 不解密），pi 的模型目录不需要 key。 */
export const listModels: AgentModule['listModels'] = async (agentDir: string) => {
  const runtime = await modelRuntime(agentDir);
  const out: string[] = [];
  for (const provider of director.configuredProviders(agentDir)) {
    for (const m of runtime.getModels(provider)) out.push(provider + '/' + m.id);
  }
  return out;
};
