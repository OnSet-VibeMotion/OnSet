/**
 * 导演的 bash 会不会碰到凭据：白名单只按命令前缀比对（cat、cp、find、curl 都在里面），参数里写的是哪个文件
 * 它不管。这里把一条命令拆成参数，逐个按 shell 的写法还原成路径（引号、~、相对路径、--x=路径、@路径、
 * file://、git 的 rev:路径），再与凭据比对：
 *
 * - 指向导演的数据目录（agent_dir，API key 与会话在里面）或 .env / .env.*（.env.example 除外）→ deny，
 *   直接拒绝、不走审批卡片：用户在卡片上随手点「允许」就把 key 交出去了；
 * - 可能间接读到它们 → ask，改成问用户：递归读取的命令（grep -r、带 --hidden 的 rg、tar、zip、cp -r、
 *   diff -r）的起点包含凭据，find 带 -exec 一类，通配符或 ~user 这种认不准的写法。
 *
 * 宁可多拦也不要漏：判断错的代价是问一次用户，漏掉的代价是 key 进了模型的上下文。
 * 白名单本身拦下的写法（$、反引号、重定向、管道、反斜杠）在这之前已经不会自动放行。
 *
 * 管不到的：白名单里的 python3、node 能跑导演自己写的脚本文件，脚本里读什么这里看不见。所以 key 在客户端里
 * 经 safeStorage 加密落盘，导演也只从 stdin 拿 key（director.Request.keys），磁盘上没有明文可读。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SecretVerdict = { kind: 'deny'; reason: string } | { kind: 'ask' } | null;

export interface SecretScope {
  /** 项目目录（相对路径按它解析，已经 realpath）。 */
  workdir: string;
  /** 导演的数据目录（已经 realpath）；空表示没有。 */
  agentDir: string;
  /** 解析成真实路径（存在的最近一层上级目录 realpath 后接回剩下的部分）。 */
  realish: (p: string) => string;
}

export const EnvFileReason = '.env 里是凭据，不能读写。要用到的配置经 config_get 工具取。';
export const AgentDirReason = '导演的数据目录里是模型服务的 API key 与会话记录，不能读写。';

/** .env 与 .env.*（.env.example 是模板，不含凭据）。 */
export function isEnvFile(p: string): boolean {
  const base = path.basename(p);
  return (base === '.env' || base.startsWith('.env.')) && base !== '.env.example';
}

function inside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 按 shell 的规则拆参数：空白分隔，单引号、双引号里的原样保留并去掉引号。参数里带空白的（sh -c '…'、
 * python3 -c "…"）由调用方再拆一遍。$、反引号、反斜杠在白名单那一层已经不放行，这里不处理。
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let cur = '';
  let started = false;
  let quote = '';
  for (const ch of command) {
    if (quote !== '') {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) words.push(cur);
  return words;
}

const globChars = /[*?[{]/;

/** 一个参数可能是哪几个路径：本身、= 后面、去掉 @、file:// 后面、rev:路径 的路径、-x粘着的值。 */
function candidates(word: string): string[] {
  const out = new Set<string>([word]);
  const eq = word.indexOf('=');
  if (eq >= 0) out.add(word.slice(eq + 1));
  for (const w of [...out]) {
    if (w.startsWith('@')) out.add(w.slice(1));
    const url = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(w);
    if (url) out.add(decodeURIComponentSafe(url[1]!));
    if (process.platform === 'win32' && /^file:\/\//i.test(w)) {
      try {
        out.add(fileURLToPath(w));
      } catch {
        // 也兼容旧提示词里直接把 Windows 绝对路径接在 file:// 后的写法。
        const local = /^file:\/\/([a-z]:[\\/].*)$/i.exec(w);
        if (local) out.add(decodeURIComponentSafe(local[1]!));
      }
    }
    const colon = w.lastIndexOf(':');
    if (colon > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) out.add(w.slice(colon + 1));
    if (/^-[A-Za-z]./.test(w) && !w.startsWith('--')) out.add(w.slice(2));
  }
  out.delete('');
  return [...out];
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** ~ 与 ~/ 换成家目录；~user 认不准，返回 null。 */
function expandHome(p: string): string | null {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  if (p.startsWith('~')) return null;
  return p;
}

/** 把 shell 通配符（单段）换成正则：* ? 不匹配 / 与开头的点，[…] 原样，{a,b} 换成分支。 */
function globRegExp(pattern: string): RegExp {
  let re = '';
  let segStart = true;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') re += segStart ? '(?!\\.)[^/]*' : '[^/]*';
    else if (ch === '?') re += segStart ? '(?!\\.)[^/]' : '[^/]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        re += '[' + pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += '(?:' + pattern.slice(i + 1, end).split(',').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      }
    } else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    segStart = ch === '/';
  }
  return new RegExp('^' + re + '$');
}

/** 递归读取一个目录的命令（参数里的目录会被整棵读下去）。 */
function recursiveReader(words: string[]): { recursive: boolean; implicitCwd: boolean } {
  const cmd = path.basename(words[0] ?? '');
  const flags = words.slice(1).filter((w) => w.startsWith('-'));
  const shortHas = (letters: string) => flags.some((f) => !f.startsWith('--') && [...f.slice(1)].some((c) => letters.includes(c)));
  const longHas = (...names: string[]) => flags.some((f) => names.some((n) => f === n || f.startsWith(n + '=')));
  switch (cmd) {
    case 'grep':
    case 'egrep':
    case 'fgrep': {
      const r = shortHas('rR') || longHas('--recursive', '--dereference-recursive') || flags.some((f) => /^(-d|--directories)=?recurse$/.test(f));
      return { recursive: r, implicitCwd: r };
    }
    case 'rg': {
      // rg 默认跳过隐藏文件（.env 就是）；带 --hidden、-.、-uu 时才读到。
      const r = longHas('--hidden') || shortHas('.') || flags.some((f) => /^-[^-]*u[^-]*u/.test(f) || f === '-uu' || f === '-uuu');
      return { recursive: r, implicitCwd: r };
    }
    case 'tar':
    case 'zip':
      return { recursive: true, implicitCwd: false };
    case 'cp':
      return { recursive: shortHas('rRa') || longHas('--recursive', '--archive'), implicitCwd: false };
    case 'diff':
      return { recursive: shortHas('r') || longHas('--recursive'), implicitCwd: false };
    default:
      return { recursive: false, implicitCwd: false };
  }
}

/** find 带了会对找到的文件执行命令、或把结果写进文件的动作。 */
function findRuns(words: string[]): boolean {
  return path.basename(words[0] ?? '') === 'find' && words.some((w) => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w));
}

/**
 * 检查一条 bash 命令（含 sh -c '…' 这类嵌套）是否碰到凭据。
 */
export function checkCommand(command: string, scope: SecretScope): SecretVerdict {
  return checkWords(shellWords(command), scope, 0);
}

function checkWords(words: string[], scope: SecretScope, depth: number): SecretVerdict {
  let ask = false;
  const envFilesIn = (dir: string): boolean => {
    try {
      return fs.readdirSync(dir).some((n) => isEnvFile(n));
    } catch {
      return false;
    }
  };
  /** 这个目录被整棵读下去时会不会读到凭据：它是导演数据目录或项目（有 .env 时）的上级，或者自己顶层就有 .env。 */
  const containsSecrets = (dir: string): boolean =>
    (scope.agentDir !== '' && inside(scope.agentDir, dir)) || (inside(scope.workdir, dir) && envFilesIn(scope.workdir)) || envFilesIn(dir);
  const { recursive, implicitCwd } = recursiveReader(words);
  const runs = findRuns(words);
  if (implicitCwd && containsSecrets(scope.workdir)) {
    // grep -r / rg 没写路径时读当前目录。第一个非选项参数一般是模式（写了 -e / -f 时不是）；后面有一个是
    // 存在的路径就算写了路径（那些路径下面逐个查）。认不出时按读当前目录算。
    const operands = words.slice(1).filter((w) => !w.startsWith('-'));
    const patternGiven = words.some((w) => /^(-e|-f|--regexp|--file)(=|$)/.test(w));
    const paths = patternGiven ? operands : operands.slice(1);
    const exists = (w: string) => {
      const e = expandHome(w);
      return e !== null && fs.existsSync(path.resolve(scope.workdir, e));
    };
    if (!paths.some(exists)) ask = true;
  }

  for (const [i, word] of words.entries()) {
    // 参数里带空白：sh -c '…'、python3 -c "…" 里的命令再拆一遍。
    if (/\s/.test(word) && depth < 3) {
      const nested = checkWords(shellWords(word), scope, depth + 1);
      if (nested?.kind === 'deny') return nested;
      if (nested?.kind === 'ask') ask = true;
    }
    if (i === 0) continue;
    for (const raw of candidates(word)) {
      const expanded = expandHome(raw);
      if (expanded === null) {
        ask = true;
        continue;
      }
      const abs = path.resolve(scope.workdir, expanded);
      if (globChars.test(expanded)) {
        // 通配符：能匹配到凭据（或落在导演数据目录里）就拒绝；会被整棵读的再问一次。
        const globPath = (p: string) => process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p;
        const patterns = [globRegExp(globPath(abs)), globRegExp(globPath(scope.realish(abs)))];
        const secrets = [
          ...(scope.agentDir !== '' ? [scope.agentDir, path.join(scope.agentDir, 'auth.json')] : []),
          ...listEnvFiles(scope.workdir),
          ...listEnvFiles(path.dirname(scope.realish(abs))),
        ];
        const hit = secrets.find((secret) => patterns.some((re) => re.test(globPath(secret))));
        if (hit !== undefined) return deny(isEnvFile(hit) ? EnvFileReason : AgentDirReason);
        if (isEnvFile(expanded)) return deny(EnvFileReason);
        if (scope.agentDir !== '' && inside(path.dirname(scope.realish(abs)), scope.agentDir)) return deny(AgentDirReason);
        if (recursive || runs) ask = true;
        continue;
      }
      const target = scope.realish(abs);
      if (isEnvFile(target) || isEnvFile(abs)) return deny(EnvFileReason);
      if (scope.agentDir !== '' && (inside(target, scope.agentDir) || inside(abs, scope.agentDir))) return deny(AgentDirReason);
      if ((recursive || runs) && isDir(target) && containsSecrets(target)) ask = true;
    }
  }
  return ask ? { kind: 'ask' } : null;
}

function deny(reason: string): SecretVerdict {
  return { kind: 'deny', reason };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listEnvFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => isEnvFile(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}
