/**
 * 制作人（pi）的运行时初始化、模型服务登记、工具适配与会话目录管理。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  type CreateModelRuntimeOptions,
  createReadToolDefinition,
  defineTool,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import * as director from '@onset/engine/director';
import { Type } from 'typebox';
import type { AgentTool } from './types';

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

export async function modelRuntime(agentDir: string): Promise<ModelRuntime> {
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
export async function serviceModel(
  runtime: ModelRuntime,
  service: director.ResolvedService,
  modelId: string,
): Promise<Model<Api>> {
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

export function toPiTool(tool: AgentTool, workdir: string, vision: boolean, sent: Set<string>) {
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
        if (!/^\.onset\/preview-[^/]+\/(?:contact-sheet|frame-\d+|detail-[^/]+)\.(?:png|jpe?g)$/i.test(rel)) {
          return reply(r.text + '\n预览图位置异常，未附图。请重新生成预览。');
        }
        const stat = fs.statSync(file, { bigint: true });
        if (!stat.isFile() || stat.size > 24n * 1024n * 1024n) {
          return reply(r.text + '\n联系表无法直接附图。请核查预览文件或按需查看单帧。');
        }
        const identity = JSON.stringify([file, stat.size.toString(), stat.ctimeNs.toString()]);
        if (sent.has(identity)) return reply(r.text + '\n同一张联系表已在当前上下文中，可沿用上次看图结论。');
        const result = await read.execute(id, { path: file }, signal, undefined, ctx);
        const image = result.content.find((block) => block.type === 'image');
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
  const safe = `--${path
    .resolve(workdir)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
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
export function sessionManager(workdir: string, agentDir: string, sessionID: string, resume: boolean): SessionManager {
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
