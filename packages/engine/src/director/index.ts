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

/**
 * 凭据文件，权限 0600：{服务商: {type: "api_key", enc}}（客户端里 safeStorage 加密）或 {type: "api_key", key}
 * （没有加密可用时的明文）。只有父进程读它（loadKeys），导演子进程与 pi 都不读。
 */
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
}

export const Providers: readonly Provider[] = [
  { id: 'deepseek', label: 'DeepSeek', keyURL: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek/deepseek-v4-pro' },
  { id: 'moonshotai-cn', label: 'Kimi（月之暗面）', keyURL: 'https://platform.moonshot.cn/console/api-keys', defaultModel: 'moonshotai-cn/kimi-k3' },
  { id: 'zai-coding-cn', label: '智谱 GLM（Coding Plan）', keyURL: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', defaultModel: 'zai-coding-cn/glm-5.3' },
  { id: 'qwen-token-plan-cn', label: '阿里云百炼（Token Plan）', keyURL: 'https://bailian.console.aliyun.com/?apiKey=1', defaultModel: 'qwen-token-plan-cn/qwen3.8-max' },
  { id: 'minimax-cn', label: 'MiniMax', keyURL: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', defaultModel: 'minimax-cn/MiniMax-M3' },
  { id: 'anthropic', label: 'Anthropic（Claude）', keyURL: 'https://console.anthropic.com/settings/keys', defaultModel: 'anthropic/claude-sonnet-5-5' },
  { id: 'openai', label: 'OpenAI', keyURL: 'https://platform.openai.com/api-keys', defaultModel: 'openai/gpt-5.5' },
  { id: 'openrouter', label: 'OpenRouter', keyURL: 'https://openrouter.ai/keys', defaultModel: 'openrouter/anthropic/claude-sonnet-5.5' },
];

/**
 * 磁盘上的 key 怎么加密。客户端主进程注入 Electron 的 safeStorage（apps/desktop/src/main/keycodec.ts）：
 * 引擎不能 import electron，所以经这里换。没有注入时（开发用的命令行、vitest）key 以明文写进 0600 的文件；
 * 注入了但 available() 为 false（safeStorage 用不了，例如 Linux 没有钥匙串）时同样退回明文，
 * 设置页经 keyStorage() 照实说一句。
 */
export interface KeyCodec {
  available(): boolean;
  /** 明文 → 可以写进 JSON 的字符串（base64）。 */
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

let codec: KeyCodec | null = null;

/** 换掉加解密（客户端主进程启动时调用一次；传 null 回到明文）。 */
export function useKeyCodec(c: KeyCodec | null): void {
  codec = c;
}

function activeCodec(): KeyCodec | null {
  try {
    return codec && codec.available() ? codec : null;
  } catch {
    return null;
  }
}

/** 现在写入的 key 是不是加密的；不是时附一句给设置页的说明。 */
export function keyStorage(): { encrypted: boolean; note?: string } {
  if (activeCodec()) return { encrypted: true };
  if (codec) return { encrypted: false, note: '这台电脑的系统钥匙串用不了，API key 只能以明文存在用户目录里一个只有你能读的文件中。' };
  return { encrypted: false, note: '不在客户端里运行：API key 以明文存在用户目录里一个只有你能读的文件中。' };
}

/** auth.json 的一项：明文是 key，加密的是 enc（codec 加密后的字符串）。 */
type AuthEntry = { type?: string; key?: string; enc?: string };

function readAuth(dir: string): Record<string, AuthEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile(dir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, AuthEntry>) : {};
  } catch {
    return {};
  }
}

function filled(v: AuthEntry | undefined): boolean {
  return !!v && ((typeof v.key === 'string' && v.key !== '') || (typeof v.enc === 'string' && v.enc !== ''));
}

/** 已经填了 API key 的服务商（只返回 id，不返回 key；加密的也算，不用解密）。 */
export function configuredProviders(dir: string): string[] {
  if (dir === '') return [];
  return Object.entries(readAuth(dir))
    .filter(([, v]) => filled(v))
    .map(([k]) => k)
    .sort();
}

const providerIDPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 写入或删除（key 为空）一家服务商的 API key。有 codec 时加密写入，顺手把文件里还是明文的几项也加密；
 * 文件权限 0600，先写临时文件再改名。key 不进 settings.conf、不进项目、不进子进程环境，
 * 导演用到时由父进程解密后经 stdin 交给它（Request.keys）。
 */
export function setProviderKey(dir: string, provider: string, key: string): void {
  if (!providerIDPattern.test(provider)) throw new Error(`不认识的服务商：${provider}`);
  if (/[\s"'\\]/.test(key.trim()) && key.trim() !== '') throw new Error('API key 里不能有空白或引号');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const c = activeCodec();
  const auth = readAuth(dir);
  if (key.trim() === '') delete auth[provider];
  else auth[provider] = { type: 'api_key', key: key.trim() };
  for (const [id, v] of Object.entries(auth)) {
    if (c && typeof v.key === 'string' && v.key !== '') auth[id] = { type: 'api_key', enc: c.encrypt(v.key) };
  }
  const file = authFile(dir);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** 交给子进程的 key（useKeys）；设了就不再读文件。 */
let handedKeys: Record<string, string> | null = null;

/**
 * 这个进程里的 key 来自父进程（经 stdin 交来，见 KeysStdinEnv），不读磁盘：执行进程里没有 safeStorage，
 * 解不开客户端加密写下的文件。
 */
export function useKeys(keys: Record<string, string> | null): void {
  handedKeys = keys ? { ...keys } : null;
}

/**
 * 读出全部 API key（服务商 → key），给导演的请求用。父进程交过 key 就用交来的；否则读文件，
 * 加密的项用 codec 解密，解不开（没有 codec，例如在终端里跑 am run 而 key 是客户端加密写下的）就跳过，
 * 导演会照常报「还没有填 key」。
 */
export function loadKeys(dir: string): Record<string, string> {
  if (handedKeys) return { ...handedKeys };
  const out: Record<string, string> = {};
  if (dir === '') return out;
  const c = activeCodec();
  for (const [id, v] of Object.entries(readAuth(dir))) {
    if (typeof v?.key === 'string' && v.key !== '') out[id] = v.key;
    else if (typeof v?.enc === 'string' && v.enc !== '' && c) {
      try {
        const plain = c.decrypt(v.enc);
        if (plain !== '') out[id] = plain;
      } catch {
        // 解不开（换了机器、钥匙串重置）：当作没填。
      }
    }
  }
  return out;
}

/**
 * 执行进程（am.cjs __op）的环境里有它（值为 1）时，先从 stdin 读一行 JSON（服务商 → key）交给 useKeys。
 * 只给 KeyOps 里的操作这样起：它们会再起导演（整理经验的整理者），而执行进程解不开加密的文件。
 * key 只走 stdin，不进环境、命令行与磁盘。
 */
export const KeysStdinEnv = 'AM_AGENT_KEYS_STDIN';

/** 会起导演的操作。 */
export const KeyOps: ReadonlySet<string> = new Set(['memory_consolidate']);

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
  /** 导演的数据目录（defaultDir，会话、模型缓存都在这里）。由父进程算好传下来：子进程的环境按安全模式白名单裁过，算不出同一个目录。 */
  agent_dir: string;
  /**
   * 服务商 → API key，由父进程读出（loadKeys，客户端里经 safeStorage 解密）交下来。导演不读磁盘上的凭据：
   * 文件可能是加密的，而且 key 只该在内存里。
   */
  keys?: Record<string, string>;
}

/** 选不出模型时的报错：界面据此引导用户去设置里填 key。 */
export const NoModelMessage = '导演还没有可用的模型：请在设置里填一个模型服务的 API key';

/** 按请求挑模型：写了就用写的；没写就用第一家填了 key、且有推荐模型的服务商。 */
export function pickModel(model: string, configured: readonly string[]): string {
  if (model !== '') return model;
  for (const p of Providers) if (configured.includes(p.id) && p.defaultModel !== '') return p.defaultModel;
  return '';
}
