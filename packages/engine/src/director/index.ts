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
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../envutil';

/** 工具名：ORCHESTRATOR=director。 */
export const Tool = 'director';

/** 覆盖制作人数据目录（模型服务、会话）的环境变量。 */
export const DirEnv = 'ONSET_AGENT_DIR';

/** 制作人的数据目录：ONSET_AGENT_DIR，否则 <数据目录>/onset/agent。环境里什么都没有时为空。 */
export function defaultDir(env: Record<string, string | undefined>): string {
  if (env[DirEnv]) return env[DirEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'agent');
}

/**
 * 模型服务文件，权限 0600：{active, services: [{id, name, preset, protocol, base_url, model, vision, key | enc}]}。
 * key 在客户端里经 safeStorage 加密（enc），没有加密可用时是明文（key）。只有父进程读它（resolveService），
 * 制作人子进程与 pi 都不读。
 */
export function servicesFile(dir: string): string {
  return path.join(dir, 'services.json');
}

/** 会话文件的根目录：数据目录下的 sessions/，再按项目路径分子目录（见 packages/cli/src/agent/pi.ts）。 */
export function sessionsDir(dir: string): string {
  return path.join(dir, 'sessions');
}

/**
 * 协议：openai 是 OpenAI 的 Chat Completions（/chat/completions），国内几家与 OpenRouter 都兼容；
 * anthropic 是 Anthropic 的 Messages（/v1/messages），Claude 与 MiniMax 的 Anthropic 端点用它。
 */
export type Protocol = 'openai' | 'anthropic';
export const Protocols: readonly Protocol[] = ['openai', 'anthropic'];

/** 协议对应的 pi 接口名。 */
export function piApi(protocol: Protocol): 'openai-completions' | 'anthropic-messages' {
  return protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
}

/**
 * 预设：只用来预填表单。base URL 与模型取自 pi 1.4.0 自带的模型目录（2026-11 核对过）：预设的 base URL 与目录里
 * 那家服务商一致时，pi 目录里这个模型的上下文长度、推理参数会被沿用（见 packages/cli/src/agent/pi.ts 的 serviceModel），
 * 所以改预设时要对着目录改，packages/cli/src/agent/catalog.test.ts 钉着。
 */
export interface Preset {
  id: string;
  label: string;
  protocol: Protocol;
  baseURL: string;
  model: string;
  /** 推荐模型能不能读图。画面验收与整片复查要看截图，看不了图的模型只能请用户看。 */
  vision: boolean;
  /** 申请 API key 的页面，界面上给一个链接。 */
  keyURL: string;
}

export const Presets: readonly Preset[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, keyURL: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', label: 'Kimi（月之暗面）', protocol: 'openai', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3', vision: true, keyURL: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'glm', label: '智谱 GLM（Coding Plan）', protocol: 'openai', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3', vision: false, keyURL: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  { id: 'bailian', label: '阿里云百炼（Token Plan）', protocol: 'openai', baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', vision: true, keyURL: 'https://bailian.console.aliyun.com/?apiKey=1' },
  { id: 'minimax', label: 'MiniMax', protocol: 'anthropic', baseURL: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3', vision: true, keyURL: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
  { id: 'anthropic', label: 'Anthropic（Claude）', protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', vision: true, keyURL: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-5.5', vision: true, keyURL: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'anthropic', baseURL: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-5.5', vision: true, keyURL: 'https://openrouter.ai/keys' },
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

/** 一套模型服务，不含 key（给界面看的）。 */
export interface ServiceInfo {
  id: string;
  name: string;
  /** 从哪个预设填的；手填的为空。只给界面显示「去申请」链接用，不影响行为。 */
  preset: string;
  protocol: Protocol;
  base_url: string;
  model: string;
  vision: boolean;
  has_key: boolean;
}

/** 交给制作人用的一套模型服务，含明文 key（只在内存与 stdin 里）。 */
export interface ResolvedService {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  model: string;
  vision: boolean;
  key: string;
}

/** 文件里的一项。 */
interface StoredService {
  id: string;
  name: string;
  preset?: string;
  protocol: Protocol;
  base_url: string;
  model: string;
  vision: boolean;
  key?: string;
  enc?: string;
}

interface StoredFile {
  active: string;
  services: StoredService[];
}

function readFile(dir: string): StoredFile {
  const empty: StoredFile = { active: '', services: [] };
  if (dir === '') return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(servicesFile(dir), 'utf8'));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const raw = parsed as Record<string, unknown>;
  const services: StoredService[] = [];
  for (const s of Array.isArray(raw.services) ? raw.services : []) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
    if (str('id') === '' || str('base_url') === '') continue;
    services.push({
      id: str('id'),
      name: str('name') || str('id'),
      ...(str('preset') ? { preset: str('preset') } : {}),
      protocol: r.protocol === 'anthropic' ? 'anthropic' : 'openai',
      base_url: str('base_url'),
      model: str('model'),
      vision: r.vision === true,
      ...(str('key') ? { key: str('key') } : {}),
      ...(str('enc') ? { enc: str('enc') } : {}),
    });
  }
  const active = typeof raw.active === 'string' && services.some((s) => s.id === raw.active) ? raw.active : (services[0]?.id ?? '');
  return { active, services };
}

/** 写文件：有 codec 时把还是明文的 key 都加密；0600，先写临时文件再改名。 */
function writeFile(dir: string, file: StoredFile): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const c = activeCodec();
  const services = file.services.map((s) => {
    if (c && s.key) {
      const { key, ...rest } = s;
      return { ...rest, enc: c.encrypt(key) };
    }
    return s;
  });
  const target = servicesFile(dir);
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ active: file.active, services }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

function info(s: StoredService): ServiceInfo {
  return { id: s.id, name: s.name, preset: s.preset ?? '', protocol: s.protocol, base_url: s.base_url, model: s.model, vision: s.vision, has_key: !!(s.key || s.enc) };
}

/** 存下的模型服务（不含 key）与在用的那一套。 */
export function listServices(dir: string): { active: string; services: ServiceInfo[] } {
  const f = readFile(dir);
  return { active: f.active, services: f.services.map(info) };
}

/** 有没有一套在用的模型服务（「制作人能不能用」）。 */
export function hasService(dir: string): boolean {
  return readFile(dir).active !== '';
}

/** 在用的那一套（不含 key）。 */
export function activeServiceInfo(dir: string): ServiceInfo | null {
  const f = readFile(dir);
  const s = f.services.find((x) => x.id === f.active);
  return s ? info(s) : null;
}

/** base URL 去掉首尾空白与结尾的斜杠；不是 http(s) 地址时报错。 */
export function normalizeBaseURL(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error('base URL 不是合法的网址：' + raw);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('base URL 只能是 http 或 https 地址');
  return v;
}

/** 新建或修改一套服务的输入。key 不给（或空）时：修改保留原来的 key，新建就没有 key（本机的服务常常不要）。 */
export interface ServiceInput {
  id?: string;
  name: string;
  preset?: string;
  protocol: string;
  base_url: string;
  model: string;
  vision: boolean;
  key?: string;
}

const modelPattern = /^\S{1,200}$/;

/** 新建（不给 id）或修改一套服务，返回它的 id。还没有在用的服务时，新建的这套就成为在用的。 */
export function saveService(dir: string, input: ServiceInput): string {
  if (dir === '') throw new Error('找不到用户数据目录（没有 HOME）');
  if (!Protocols.includes(input.protocol as Protocol)) throw new Error('不认识的协议：' + input.protocol);
  const baseURL = normalizeBaseURL(input.base_url);
  const model = input.model.trim();
  if (!modelPattern.test(model)) throw new Error('要填模型名（不能有空白）');
  const key = (input.key ?? '').trim();
  if (/[\s"'\\]/.test(key)) throw new Error('API key 里不能有空白或引号');
  const name = input.name.trim() || (Presets.find((p) => p.id === input.preset)?.label ?? new URL(baseURL).host);
  const f = readFile(dir);
  let target = input.id ? f.services.find((s) => s.id === input.id) : undefined;
  if (input.id && !target) throw new Error('没有这套模型服务：' + input.id);
  if (!target) {
    target = { id: 's-' + crypto.randomBytes(4).toString('hex'), name, protocol: 'openai', base_url: '', model: '', vision: false };
    f.services.push(target);
  }
  target.name = name;
  target.protocol = input.protocol as Protocol;
  target.base_url = baseURL;
  target.model = model;
  target.vision = input.vision === true;
  if (input.preset && Presets.some((p) => p.id === input.preset)) target.preset = input.preset;
  else delete target.preset;
  if (key !== '') {
    target.key = key;
    delete target.enc;
  }
  if (f.active === '') f.active = target.id;
  writeFile(dir, f);
  return target.id;
}

/** 删掉一套；删的是在用的那套时，改用剩下的第一套。 */
export function deleteService(dir: string, id: string): void {
  const f = readFile(dir);
  if (!f.services.some((s) => s.id === id)) throw new Error('没有这套模型服务：' + id);
  f.services = f.services.filter((s) => s.id !== id);
  if (f.active === id) f.active = f.services[0]?.id ?? '';
  writeFile(dir, f);
}

/** 选一套在用。 */
export function setActiveService(dir: string, id: string): void {
  const f = readFile(dir);
  if (!f.services.some((s) => s.id === id)) throw new Error('没有这套模型服务：' + id);
  f.active = id;
  writeFile(dir, f);
}

/** 交给子进程的服务（useService）；设了就不再读文件。 */
let handed: ResolvedService | null = null;

/**
 * 这个进程用的服务来自父进程（经 stdin 交来，见 ServiceStdinEnv），不读磁盘：执行进程里没有 safeStorage，
 * 解不开客户端加密写下的文件。
 */
export function useService(s: ResolvedService | null): void {
  handed = s ? { ...s } : null;
}

function decryptKey(s: StoredService): string | null {
  if (s.key) return s.key;
  if (!s.enc) return '';
  const c = activeCodec();
  if (!c) return null;
  try {
    return c.decrypt(s.enc);
  } catch {
    return null;
  }
}

/**
 * 读出一套服务连同 key（id 为空时取在用的那套），给制作人的请求、列模型用。父进程交过就用交来的；否则读文件，
 * 加密的 key 用 codec 解密，解不开（没有 codec，例如在终端里跑 onset run 而 key 是客户端加密写下的；换了机器）
 * 就当作没有这套服务，制作人会照常报「还没有配置模型服务」。
 */
export function resolveService(dir: string, id = ''): ResolvedService | null {
  if (handed && (id === '' || id === handed.id)) return { ...handed };
  const f = readFile(dir);
  const s = f.services.find((x) => x.id === (id || f.active));
  if (!s) return null;
  const key = decryptKey(s);
  if (key === null) return null;
  return { id: s.id, name: s.name, protocol: s.protocol, base_url: s.base_url, model: s.model, vision: s.vision, key };
}

/** 从 stdin 交来的 JSON 里取服务；形状不对时为 null。 */
export function parseResolvedService(raw: unknown): ResolvedService | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  if (str('base_url') === '' || str('model') === '') return null;
  return {
    id: str('id'),
    name: str('name'),
    protocol: r.protocol === 'anthropic' ? 'anthropic' : 'openai',
    base_url: str('base_url'),
    model: str('model'),
    vision: r.vision === true,
    key: str('key'),
  };
}

/**
 * 执行进程（onset.cjs __op）的环境里有它（值为 1）时，先从 stdin 读一行 JSON（ResolvedService）交给 useService。
 * 只给 KeyOps 里的操作这样起：它们会再起制作人（整理经验的整理者），而执行进程解不开加密的文件。
 * key 只走 stdin，不进环境、命令行与磁盘。
 */
export const ServiceStdinEnv = 'ONSET_AGENT_SERVICE_STDIN';

/** 会起制作人的操作：包括整理经验、检查画面描述与镜头渲染。 */
export const KeyOps: ReadonlySet<string> = new Set(['memory_consolidate', 'audition_learn', 'scene_prompt_check', 'scene_run', 'scene_run_all', 'scene_repair', 'scene_seams', 'scene_design', 'scene_audition', 'scene_audition_retry', 'memory_exam']);

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
export async function listServiceModels(s: Pick<ResolvedService, 'protocol' | 'base_url' | 'key'>, signal?: AbortSignal): Promise<string[]> {
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
  const data = body && typeof body === 'object' ? ((body as Record<string, unknown>).data ?? (body as Record<string, unknown>).models) : undefined;
  if (!Array.isArray(data)) throw new Error(`${url} 的返回里没有模型列表`);
  const ids = data.map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).id : m)).filter((id): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)].sort();
}
