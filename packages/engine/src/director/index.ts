/**
 * 制作人：客户端自带的编排工具，不要求用户另装 claude、codex 这类 CLI，配一个模型服务就能用。
 *
 * 引擎这边只放与 agent 实现无关的部分：工具名、请求格式、模型服务的存取与预设。真正的 agent 循环用的是
 * pi（@earendil-works/pi-coding-agent，MIT），由 onset studio agent（packages/cli/src/agent/）在子进程里跑，
 * 打成单独的 onset-agent.cjs，只在这一个命令里加载：pi 连同依赖有十几 MB，打进 onset.cjs 的话每次 __op、
 * 每个工具服务进程都要多解析一遍。
 *
 * 子进程输出 claude 系的 stream-json（system/init、assistant、user、result），agentrun 的解析、用量累计与
 * 模型识别都按 claude 系处理，不另写一份。
 *
 * 模型服务（Service）就是一组「协议 + base URL + API key + 模型名 + 能不能看图」。用户可以存几套、选一套在用；
 * 预设（Presets）只是把这几项预填好，存下来之后与手填的没有区别。
 */
import path from 'node:path';
import { normalizeBaseURL } from './presets';
import type { ResolvedService } from './services';

export {
  DirEnv,
  defaultDir,
  normalizeBaseURL,
  type Preset,
  Presets,
  type Protocol,
  Protocols,
  piApi,
  servicesFile,
  sessionsDir,
  Tool,
} from './presets';
export {
  activeServiceInfo,
  deleteService,
  hasService,
  type KeyCodec,
  keyStorage,
  listServices,
  parseResolvedService,
  type ResolvedService,
  resolveService,
  type ServiceInfo,
  type ServiceInput,
  saveService,
  setActiveService,
  useKeyCodec,
  useService,
} from './services';

/**
 * 执行进程（onset.cjs __op）的环境里有它（值为 1）时，先从 stdin 读一行 JSON（ResolvedService）交给 useService。
 * 只给 KeyOps 里的操作这样起：它们会再起制作人（整理经验的整理者），而执行进程解不开加密的文件。
 * key 只走 stdin，不进环境、命令行与磁盘。
 */
export const ServiceStdinEnv = 'ONSET_AGENT_SERVICE_STDIN';

/** 会起制作人的操作：包括整理经验、检查画面描述与镜头渲染。 */
export const KeyOps: ReadonlySet<string> = new Set([
  'memory_consolidate',
  'audition_learn',
  'scene_prompt_check',
  'scene_run',
  'scene_run_all',
  'scene_repair',
  'scene_seams',
  'scene_design',
  'scene_audition',
  'scene_audition_retry',
  'memory_exam',
]);

/** 检查画面描述用优化工具（OPTIMIZER，空则跟随编排）。 */
export function keyTool(op: string, cfg: { orchestrator: string; optimizer: string }): string {
  return op === 'scene_prompt_check' && cfg.optimizer !== '' ? cfg.optimizer : cfg.orchestrator;
}

/** 渲染会话与模型目录缓存放在凭据目录之外，macOS 渲染沙箱仍禁止读取 agent/。 */
export function rendererDir(agentDir: string): string {
  return path.join(path.dirname(agentDir), path.basename(agentDir) + '-renderer');
}

/**
 * 交给 onset studio agent 的一次调用（经 stdin，一行 JSON）。不走命令行参数：提示词很长，
 * 而且命令行在 ps 里谁都看得见。
 */
export interface Request {
  workdir: string;
  prompt: string;
  /** 不给时是整片编排；renderer 只启用单镜头渲染工具。 */
  profile?: 'renderer';
  /** 渲染器需要只读的技能与项目资源目录。 */
  read_dirs?: string[];
  /** 空是新会话；resume 为 true 时续接这个会话。 */
  session_id?: string;
  resume?: boolean;
  /** 只换模型名（设置里的编排模型、对话里临时选的）；空时用服务自己的模型。 */
  model?: string;
  /** 思考强度（pi 的 thinkingLevel：off minimal low medium high xhigh max）；空按模型默认。见 tools/options.ts。 */
  thinking?: string;
  /** 可选的渲染上下文整理触发点，单位 Token。 */
  compact_at?: number;
  /** 跨镜头共享前缀缓存的路由键（同项目同批镜头一致，不随单镜会话变化）。 */
  cache_key?: string;
  unsafe?: boolean;
  /** 安全模式下 bash 直接放行的命令前缀（与其他编排工具同一份白名单）。 */
  commands?: string[];
  /** 工作目录之外还能读写的目录（记忆库、音色库）。 */
  writable_dirs?: string[];
  /** 制作人的数据目录（defaultDir，会话放在这里）。由父进程算好传下来：子进程的环境按安全模式白名单裁过，算不出同一个目录。 */
  agent_dir: string;
  /**
   * 在用的模型服务，含 key，由父进程读出（resolveService，客户端里经 safeStorage 解密）交下来。制作人不读磁盘上的凭据：
   * 文件可能是加密的，而且 key 只该在内存里。
   */
  service?: ResolvedService;
}

/** 没有模型服务时的报错：界面据此引导用户去设置里配置。 */
export const NoServiceMessage = '制作人还没有可用的模型服务：请在设置里配置一个（填 base URL 与 API key）';

/** 这一轮实际用的模型名：写了就用写的，否则用服务自己的。 */
export function effectiveModel(override: string, service: Pick<ResolvedService, 'model'> | null): string {
  return override.trim() || service?.model || '';
}

/** 列模型用的超时：base URL 写错时别让下拉框一直转。 */
const listTimeoutMs = 10_000;

/**
 * 问服务本身有哪些模型：openai 协议是 GET {base}/models（Bearer），anthropic 是 GET {base}/v1/models（x-api-key）。
 * 失败抛错，调用方让用户手填。
 */
export async function listServiceModels(
  s: Pick<ResolvedService, 'protocol' | 'base_url' | 'key'>,
  signal?: AbortSignal,
): Promise<string[]> {
  const base = normalizeBaseURL(s.base_url);
  const url = s.protocol === 'anthropic' ? base + '/v1/models' : base + '/models';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (s.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (s.key) headers['x-api-key'] = s.key;
  } else if (s.key) {
    headers.authorization = 'Bearer ' + s.key;
  }
  const timeout = AbortSignal.timeout(listTimeoutMs);
  const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
  const body = (await res.json()) as unknown;
  const data =
    body && typeof body === 'object'
      ? ((body as Record<string, unknown>).data ?? (body as Record<string, unknown>).models)
      : undefined;
  if (!Array.isArray(data)) throw new Error(`${url} 的返回里没有模型列表`);
  const ids = data
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).id : m))
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)].sort();
}
