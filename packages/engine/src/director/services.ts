import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeBaseURL, Presets, type Protocol, Protocols, servicesFile } from './presets';

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
  if (codec) {
    return {
      encrypted: false,
      note: '这台电脑的系统钥匙串用不了，API key 只能以明文存在用户目录里一个只有你能读的文件中。',
    };
  }
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
  const active =
    typeof raw.active === 'string' && services.some((s) => s.id === raw.active) ? raw.active : (services[0]?.id ?? '');
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
  return {
    id: s.id,
    name: s.name,
    preset: s.preset ?? '',
    protocol: s.protocol,
    base_url: s.base_url,
    model: s.model,
    vision: s.vision,
    has_key: !!(s.key || s.enc),
  };
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
    target = {
      id: 's-' + crypto.randomBytes(4).toString('hex'),
      name,
      protocol: 'openai',
      base_url: '',
      model: '',
      vision: false,
    };
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
