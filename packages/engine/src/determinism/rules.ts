//
// 正则与 Go RE2 的差异在这里统一处理：\s 一律展开成 ASCII 空白类（见 gostd.ts 的 S），
// \b、\w、\d 在不带 u 标志的 JS 正则里本来就只认 ASCII，与 RE2 相同。
import { isIPv6 } from 'node:net';
import { S, goTrimSpace } from './gostd';

/**
 * AllowMarker 写在某一行的注释里，豁免这一行的全部发现。
 *
 * 豁免存在的理由：algorithmic-art 的 viewer 引擎在交互路径上合法地用了
 * requestAnimationFrame 和 Math.random（播放预览、「随机种子」按钮），渲染路径
 * 走的是 __art.renderFrame，不经过它们。没有豁免的话，照技能说明把 viewer 放进
 * 镜头目录就必然被判失败——误判一次，这道门就没人信了。
 *
 * 豁免必须逐行写、写在代码旁边，并且会出现在报告的 allowed 里，可审计。
 */
export const AllowMarker = 'am-allow-nondeterministic';

/**
 * Rule 是一条源码级确定性规则。needsStrings 的规则要看字符串字面量
 * （网络规则看 fetch 的 URL），在只剥了注释的文本上匹配；其余规则在连字符串
 * 内容也抹掉的文本上匹配，画面文案里提到禁用 API 不算违规。
 */
export interface Rule {
  id: string;
  /** 带 g 标志。 */
  pattern: RegExp;
  message: string;
  needsStrings: boolean;
}

/**
 * scriptRules 作用于脚本正文（内联 <script> 与本地 JS 文件，注释已剥除）。
 *
 * 每条都对应上游 hyperframes 技能 Contract 第 4 条与 runtimes.md 里的禁令（0.8.14 时在
 * hyperframes-core 的 determinism-rules.md），且都是
 * HyperFrames 自己的 lint 不查的：lint 查 repeat 取整溢出，不查无限 repeat；
 * 时钟、随机数、定时器与运行时网络请求它一条都不看。
 *
 * 刻意没有收录 setTimeout：等字体、等资源就绪的代码里常见它，并不决定画面状态，
 * 收录的话误判远多于真问题。setInterval 则几乎只用于驱动画面变化。
 */
export const scriptRules: Rule[] = [
  {
    id: 'clock',
    pattern: new RegExp(`\\bDate\\.now${S}*\\(|\\bperformance\\.now${S}*\\(|\\bnew${S}+Date${S}*\\(${S}*\\)`, 'g'),
    message: '读取了真实时钟；渲染按帧 seek，画面状态只能由时间轴位置决定',
    needsStrings: false,
  },
  {
    id: 'random',
    pattern: new RegExp(`\\bMath\\.random${S}*\\(`, 'g'),
    message: '使用了未播种的 Math.random()；随机效果请用固定种子的 PRNG',
    needsStrings: false,
  },
  {
    id: 'raf',
    pattern: new RegExp(`\\brequestAnimationFrame${S}*\\(`, 'g'),
    message: '使用了 requestAnimationFrame；动画必须挂在 paused timeline 上由渲染器 seek',
    needsStrings: false,
  },
  {
    id: 'interval',
    pattern: new RegExp(`\\bsetInterval${S}*\\(`, 'g'),
    message: '使用了 setInterval；定时器按真实时间触发，与渲染帧无关',
    needsStrings: false,
  },
  {
    id: 'infinite-repeat',
    pattern: new RegExp(`\\brepeat${S}*:${S}*-${S}*1\\b`, 'g'),
    message: 'repeat: -1 是无限循环；请按镜头时长算出有限次数',
    needsStrings: false,
  },
  {
    id: 'network',
    pattern: new RegExp(
      `\\bfetch${S}*\\(${S}*['"\`](?:https?:)?//|\\bnew${S}+(?:XMLHttpRequest|WebSocket|EventSource)\\b`,
      'g',
    ),
    message: '渲染时发起网络请求；所需资源必须随镜头目录提供',
    needsStrings: true,
  },
];

// pinnedCDNs 是允许远程引用的脚本 CDN，且必须带完整版本号。
//
// 上游技能的最小合成示例就是从 jsdelivr 引固定版本的 GSAP，把远程脚本一律
// 判死等于判死几乎所有镜头。版本号是底线：不带版本或写 @latest 时，同一镜头
// 隔一周重渲染会拿到另一份库，那才是不可复现。
const semverInPath = /@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\/|$)/;
const cdnjsVersion = /^\/ajax\/libs\/[^/]+\/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\//;

/** remoteProblem 判定一个远程 URL 是否违规，返回规则 ID 与说明；合规时返回空串。 */
export function remoteProblem(raw: string): [string, string] {
  let target = raw;
  if (target.startsWith('//')) {
    target = 'https:' + target;
  }
  const parsed = parseGoURL(target);
  if (parsed === null || parsed.host === '') {
    return ['remote-asset', '无法解析的远程地址；所需资源必须随镜头目录提供'];
  }
  const host = hostname(parsed.host).toLowerCase();
  switch (host) {
    case 'fonts.googleapis.com':
    case 'fonts.gstatic.com':
      return ['remote-font', '引用了在线字体；字体必须用 @font-face 指向镜头目录内的文件'];
    case 'cdn.jsdelivr.net':
    case 'unpkg.com':
    case 'esm.sh':
      if (semverInPath.test(parsed.path)) {
        return ['', ''];
      }
      return ['unpinned-cdn', 'CDN 引用没有固定到完整版本号；库内容会随上游漂移，请写成 包名@x.y.z 的形式'];
    case 'cdnjs.cloudflare.com':
      if (cdnjsVersion.test(parsed.path)) {
        return ['', ''];
      }
      return ['unpinned-cdn', 'CDN 引用没有固定到完整版本号；库内容会随上游漂移，请写成 包名@x.y.z 的形式'];
  }
  return ['remote-asset', '引用了远程资源；所需资源必须随镜头目录提供，或内联进合成'];
}

/** isRemote 报告引用是否指向网络。 */
export function isRemote(ref: string): boolean {
  const lower = ref.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//');
}

/** isIgnoredRef 报告引用是否与文件无关：页内锚点、内联数据与伪协议。 */
export function isIgnoredRef(ref: string): boolean {
  const lower = goTrimSpace(ref).toLowerCase();
  if (lower === '' || lower.startsWith('#')) {
    return true;
  }
  for (const prefix of ['data:', 'blob:', 'javascript:', 'mailto:', 'about:']) {
    if (lower.startsWith(prefix)) {
      return true;
    }
  }
  // 模板插值（${...}、{{...}}）在静态扫描时无法求值，不猜。
  return ref.includes('${') || ref.includes('{{');
}

/**
 * RuleIDs 返回扫描可能报出的全部规则 ID，顺序固定。
 *
 * 渲染记忆（internal/memory）的经验必须写明由哪个校验器判定，校验器 ID 以
 * 这份清单为准；新增规则时在这里补上，否则引用它的经验过不了格式校验。
 */
export function ruleIDs(): string[] {
  const ids = scriptRules.map((rule) => rule.id);
  return [...ids, 'font-display', 'font-missing', 'remote-font', 'unpinned-cdn', 'remote-asset'];
}

// ---- Go net/url.Parse 的子集 ----
//
// 只为 remoteProblem 服务：判定能否解析、取 Host 与解码后的 Path。WHATWG URL 会规范化路径
// （解析 ..、百分号编码），与 Go 的结果不同，所以照 Go 的 parse / parseAuthority / parseHost
// 手写，出错的条件与 Go 1.25 一致（控制字符、非法转义、主机名非法字符、非法端口）。

function isHex(c: string): boolean {
  return /^[0-9A-Fa-f]$/.test(c);
}

function unhex(c: string): number {
  return parseInt(c, 16);
}

/** Go 的 shouldEscape(c, encodeHost)。 */
function hostShouldEscape(c: string): boolean {
  if (/^[A-Za-z0-9]$/.test(c)) return false;
  if ('!$&\'()*+,;=:[]<>"'.includes(c)) return false;
  if ('-_.~'.includes(c)) return false;
  return true;
}

type Mode = 'path' | 'host' | 'fragment' | 'userinfo';

/** Go 的 unescape：非法转义返回 null；host 模式下还拒绝非法字符。 */
function unescape(s: string, mode: Mode): string | null {
  const bytes: number[] = [];
  const raw = Buffer.from(s, 'utf8');
  for (let i = 0; i < raw.length; ) {
    const b = raw[i];
    if (b === 0x25) {
      if (i + 2 >= raw.length) return null;
      const h1 = String.fromCharCode(raw[i + 1]);
      const h2 = String.fromCharCode(raw[i + 2]);
      if (!isHex(h1) || !isHex(h2)) return null;
      if (mode === 'host' && unhex(h1) < 8 && `%${h1}${h2}` !== '%25') return null;
      bytes.push(unhex(h1) * 16 + unhex(h2));
      i += 3;
      continue;
    }
    if (mode === 'host' && b < 0x80 && hostShouldEscape(String.fromCharCode(b))) return null;
    bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

function validOptionalPort(port: string): boolean {
  if (port === '') return true;
  if (port[0] !== ':') return false;
  return /^[0-9]*$/.test(port.slice(1));
}

function validUserinfo(s: string): boolean {
  for (const c of s) {
    if (/^[A-Za-z0-9]$/.test(c)) continue;
    if ("-._:~!$&'()*+,;=%@".includes(c)) continue;
    return false;
  }
  return true;
}

function parseHost(host: string): string | null {
  const open = host.lastIndexOf('[');
  if (open > 0) return null;
  if (open === 0) {
    const close = host.lastIndexOf(']');
    if (close < 0) return null;
    const colonPort = host.slice(close + 1);
    if (!validOptionalPort(colonPort)) return null;
    const name = host.slice(1, close);
    const zone = name.indexOf('%25');
    const hostPart = unescape(zone >= 0 ? name.slice(0, zone) : name, 'host');
    const zonePart = zone >= 0 ? unescape(name.slice(zone), 'fragment') : '';
    if (hostPart === null || zonePart === null) return null;
    // 只有 IPv6 地址可以放在方括号里（Go 用 netip.ParseAddr 校验并拒绝 IPv4）。
    if (!isIPv6(hostPart + zonePart)) return null;
    return '[' + hostPart + zonePart + ']' + colonPort;
  }
  const i = host.lastIndexOf(':');
  if (i !== -1 && !validOptionalPort(host.slice(i))) return null;
  return unescape(host, 'host');
}

function parseAuthority(authority: string): string | null {
  const i = authority.lastIndexOf('@');
  if (i < 0) return parseHost(authority);
  const host = parseHost(authority.slice(i + 1));
  if (host === null) return null;
  const userinfo = authority.slice(0, i);
  if (!validUserinfo(userinfo)) return null;
  if (unescape(userinfo, 'userinfo') === null) return null;
  return host;
}

/** Go 的 url.Parse 的子集：返回 Host 与解码后的 Path；Go 会报错的输入返回 null。 */
export function parseGoURL(rawURL: string): { host: string; path: string } | null {
  const hashAt = rawURL.indexOf('#');
  const main = hashAt >= 0 ? rawURL.slice(0, hashAt) : rawURL;
  if (hashAt >= 0 && unescape(rawURL.slice(hashAt + 1), 'fragment') === null) return null;
  for (let i = 0; i < main.length; i++) {
    const c = main.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  // getScheme
  let scheme = '';
  let rest = main;
  for (let i = 0; i < main.length; i++) {
    const c = main[i];
    if (/[A-Za-z]/.test(c)) continue;
    if (/[0-9+\-.]/.test(c)) {
      if (i === 0) break;
      continue;
    }
    if (c === ':') {
      if (i === 0) return null;
      scheme = main.slice(0, i);
      rest = main.slice(i + 1);
    }
    break;
  }
  if (rest.endsWith('?') && rest.split('?').length - 1 === 1) {
    rest = rest.slice(0, -1);
  } else {
    const q = rest.indexOf('?');
    if (q >= 0) rest = rest.slice(0, q);
  }
  if (!rest.startsWith('/')) {
    if (scheme !== '') return { host: '', path: '' };
    const slash = rest.indexOf('/');
    const segment = slash >= 0 ? rest.slice(0, slash) : rest;
    if (segment.includes(':')) return null;
  }
  let host = '';
  if ((scheme !== '' || !rest.startsWith('///')) && rest.startsWith('//')) {
    const after = rest.slice(2);
    const slash = after.indexOf('/');
    const authority = slash >= 0 ? after.slice(0, slash) : after;
    rest = slash >= 0 ? after.slice(slash) : '';
    const parsed = parseAuthority(authority);
    if (parsed === null) return null;
    host = parsed;
  }
  const decoded = unescape(rest, 'path');
  if (decoded === null) return null;
  return { host, path: decoded };
}

/** URL.Hostname：去掉端口与 IPv6 方括号。 */
function hostname(hostPort: string): string {
  let host = hostPort;
  const colon = host.lastIndexOf(':');
  if (colon !== -1 && validOptionalPort(host.slice(colon))) {
    host = host.slice(0, colon);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return host;
}
