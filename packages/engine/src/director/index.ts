/**
 * 导演：客户端自带的编排工具，不要求用户另装 claude、codex 这类 CLI，填一个模型服务的 API key 就能用。
 *
 * 引擎这边只放与 agent 实现无关的部分：工具名、请求格式、凭据文件与服务商表。真正的 agent 循环用的是
 * pi（@earendil-works/pi-coding-agent，MIT），由 am studio agent（packages/cli/src/agent/）在子进程里跑，
 * 打成单独的 am-agent.cjs，只在这一个命令里加载：pi 连同依赖有十几 MB，打进 am.cjs 的话每次 __op、
 * 每个工具服务进程都要多解析一遍。
 *
 * 子进程输出 claude 系的 stream-json（system/init、assistant、user、result），agentrun 的解析、用量累计与
 * 模型识别都按 claude 系处理，不另写一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../envutil';
import { TextOnlyModels } from './textonly';

export { TextOnlyModels } from './textonly';

/** 工具名：ORCHESTRATOR=director。 */
export const Tool = 'director';

/** 覆盖导演数据目录（凭据、模型缓存）的环境变量。 */
export const DirEnv = 'AM_AGENT_DIR';

/** 导演的数据目录：AM_AGENT_DIR，否则 <数据目录>/am/agent。环境里什么都没有时为空。 */
export function defaultDir(env: Record<string, string | undefined>): string {
  if (env[DirEnv]) return env[DirEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'agent');
}

/** 凭据文件（pi 的 auth.json 格式：{服务商: {type: "api_key", key}}），权限 0600。 */
export function authFile(dir: string): string {
  return path.join(dir, 'auth.json');
}

/** 会话文件的根目录：数据目录下的 sessions/，再按项目路径分子目录（见 packages/cli/src/agent/pi.ts）。 */
export function sessionsDir(dir: string): string {
  return path.join(dir, 'sessions');
}

/**
 * 客户端里能直接选的服务商。id 是 pi 的服务商 id，模型写成「服务商/模型」（与 opencode 相同）。
 * 只列国内能直连、或做片常用的几家；pi 支持的其余服务商照样能用，只是要手填模型名。推荐模型取自
 * pi 1.4.0 自带的模型目录（2026-11 核对过），升级 pi 时要重新核对，director.test.ts 不联网、管不到这一条。
 */
export interface Provider {
  id: string;
  label: string;
  /** 申请 API key 的页面，界面上给一个链接。 */
  keyURL: string;
  /** 推荐的模型（「服务商/模型」），选了服务商又没选模型时用它。 */
  defaultModel: string;
  /**
   * 推荐模型能不能读图。画面验收与整片复查要打开 PNG 看图判断，看不了图的模型只会拿到 pi 的一句「图片已省略」，
   * 验收等于没做。packages/cli/src/agent/catalog.test.ts 对着 pi 的模型目录核对这一项。
   */
  vision: boolean;
}

export const Providers: readonly Provider[] = [
  { id: 'deepseek', label: 'DeepSeek', keyURL: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek/deepseek-v4-pro', vision: false },
  { id: 'moonshotai-cn', label: 'Kimi（月之暗面）', keyURL: 'https://platform.moonshot.cn/console/api-keys', defaultModel: 'moonshotai-cn/kimi-k3', vision: true },
  { id: 'zai-coding-cn', label: '智谱 GLM（Coding Plan）', keyURL: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', defaultModel: 'zai-coding-cn/glm-5.3', vision: false },
  { id: 'qwen-token-plan-cn', label: '阿里云百炼（Token Plan）', keyURL: 'https://bailian.console.aliyun.com/?apiKey=1', defaultModel: 'qwen-token-plan-cn/qwen3.8-max', vision: true },
  { id: 'minimax-cn', label: 'MiniMax', keyURL: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', defaultModel: 'minimax-cn/MiniMax-M3', vision: true },
  { id: 'anthropic', label: 'Anthropic（Claude）', keyURL: 'https://console.anthropic.com/settings/keys', defaultModel: 'anthropic/claude-sonnet-5-5', vision: true },
  { id: 'openai', label: 'OpenAI', keyURL: 'https://platform.openai.com/api-keys', defaultModel: 'openai/gpt-5.5', vision: true },
  { id: 'openrouter', label: 'OpenRouter', keyURL: 'https://openrouter.ai/keys', defaultModel: 'openrouter/anthropic/claude-sonnet-5.5', vision: true },
];

type AuthEntry = { type?: string; key?: string };

function readAuth(dir: string): Record<string, AuthEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile(dir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, AuthEntry>) : {};
  } catch {
    return {};
  }
}

/** 已经填了 API key 的服务商（只返回 id，不返回 key）。 */
export function configuredProviders(dir: string): string[] {
  if (dir === '') return [];
  return Object.entries(readAuth(dir))
    .filter(([, v]) => v && typeof v.key === 'string' && v.key !== '')
    .map(([k]) => k)
    .sort();
}

const providerIDPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 写入或删除（key 为空）一家服务商的 API key。文件权限 0600，先写临时文件再改名。
 * key 不进 settings.conf、不进项目、不进子进程环境：编排工具能跑的命令里拿不到它。
 */
export function setProviderKey(dir: string, provider: string, key: string): void {
  if (!providerIDPattern.test(provider)) throw new Error(`不认识的服务商：${provider}`);
  if (/[\s"'\\]/.test(key.trim()) && key.trim() !== '') throw new Error('API key 里不能有空白或引号');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const auth = readAuth(dir);
  if (key.trim() === '') delete auth[provider];
  else auth[provider] = { type: 'api_key', key: key.trim() };
  const file = authFile(dir);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** 模型「服务商/模型」里的服务商；没有斜杠时为空。 */
export function providerOf(model: string): string {
  const i = model.indexOf('/');
  return i > 0 ? model.slice(0, i) : '';
}

/**
 * 交给 am studio agent 的一次调用（经 stdin，一行 JSON）。不走命令行参数：提示词很长，
 * 而且命令行在 ps 里谁都看得见。
 */
export interface Request {
  workdir: string;
  prompt: string;
  /** 空是新会话；resume 为 true 时续接这个会话。 */
  session_id?: string;
  resume?: boolean;
  /** 「服务商/模型」；空时用第一家填了 key 的服务商的推荐模型。 */
  model?: string;
  unsafe?: boolean;
  /** 安全模式下 bash 直接放行的命令前缀（与其他编排工具同一份白名单）。 */
  commands?: string[];
  /** 工作目录之外还能读写的目录（记忆库、音色库）。 */
  writable_dirs?: string[];
  /** 凭据所在目录（defaultDir）。由父进程算好传下来：子进程的环境按安全模式白名单裁过，算不出同一个目录。 */
  agent_dir: string;
}

/** 选不出模型时的报错：界面据此引导用户去设置里填 key。 */
export const NoModelMessage = '导演还没有可用的模型：请在设置里填一个模型服务的 API key';

/**
 * 按请求挑模型：写了就用写的；没写就在填了 key 的服务商里先挑推荐模型能读图的（按 Providers 的顺序），
 * 都不能读图时才用第一家。画面验收、整片复查都要看图，能读图的模型才做得了。
 */
export function pickModel(model: string, configured: readonly string[]): string {
  if (model !== '') return model;
  const usable = Providers.filter((p) => configured.includes(p.id) && p.defaultModel !== '');
  return (usable.find((p) => p.vision) ?? usable[0])?.defaultModel ?? '';
}

/**
 * 模型能不能读图：pi 的模型目录里标着只收文字的是 false，其余（能读图的、不在表里的服务商、目录里查不到的模型）
 * 都是 undefined——查不到按不知道处理，不提示用户。
 */
export function modelVision(model: string): false | undefined {
  const provider = providerOf(model);
  if (provider === '') return undefined;
  const list = TextOnlyModels[provider];
  return list && list.includes(model.slice(provider.length + 1)) ? false : undefined;
}
