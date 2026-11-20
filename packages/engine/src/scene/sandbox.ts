/**
 * 渲染器的系统沙箱（macOS 的 sandbox-exec，Seatbelt）：边界是目录，不是命令白名单。
 *
 * 命令白名单管不住脚本：放行 python3 就等于放行它读写任何文件。渲染器又确实需要跑自己写的小脚本
 * （裁图、量像素、看上一次的末帧），白名单下这些全被拒、白白耗掉几轮（2026-11 实测 qoder 一个镜头 41 次调用里 6 次被拒）。
 * 所以在进程外面套一层系统沙箱，它对渲染器和它起的每一个子进程都生效：
 *
 * - 写：只有镜头目录、临时目录与渲染工具自己的状态目录（会话、日志）。
 * - 读：家目录里只有本项目、渲染工具自己的目录、onset 的数据目录、~/Library（系统框架与字体要读）
 *   与工具所在的目录；别的项目、~/.ssh、~/.aws 这些都读不到。任何 `.env` 与制作人的凭据目录一律不能读。
 * - 网络不限：模型服务、字体与 CDN 都要连。
 *
 * 规则按真实路径匹配，所以镜头目录里指向技能的符号链接（stageRendererSkills）只能读、改不了真文件。
 * 2026-11 实测在这层沙箱里 `hyperframes render`（借客户端 Chromium）照常出片。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../envutil';

/** 系统自带的 sandbox-exec；只有 macOS 有。 */
export const SandboxExec = '/usr/bin/sandbox-exec';

export function sandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && fs.existsSync(SandboxExec);
}

/**
 * 渲染器自己要不要按命令白名单拦：套了系统沙箱时不拦（边界由沙箱管）；Windows 没有系统沙箱，
 * 用户定的是全放开、安全先放下（2026-11），也不拦。其余平台照旧拦。
 */
export function rendererUnfiltered(sandboxed: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return sandboxed || platform === 'win32';
}

export interface SandboxPaths {
  /** 镜头目录：唯一能写的项目目录。 */
  sceneDir: string;
  /** 项目根：技能、整片风格、字幕都在这里，整个能读。 */
  projectRoot: string;
  env: Record<string, string | undefined>;
  /** 渲染工具自己的状态目录（会话、日志、缓存），要能读写，例如 ~/.qoder-cn。 */
  toolStateDirs: string[];
  /** 渲染工具在家目录根上写的状态文件（~/.claude.json 与它的临时文件、备份），按前缀放行读写。 */
  toolStateFiles?: string[];
  /** 不许读的目录：渲染工具的用户级技能与插件（只让它看见镜头自己的那几个技能）。 */
  hiddenDirs?: string[];
  /** 另外要能读的目录：渲染工具、onset 运行时、浏览器所在的地方。 */
  readDirs: string[];
  /** 试镜仅能读自己的冻结输入、明确列出的技能/资源与运行配置。 */
  isolatedProject?: { readDirs: string[]; readFiles: string[] };
}

/** 真实路径：/var 是 /private/var 的链接，Seatbelt 按真实路径匹配。不存在的照原样。 */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function quote(p: string): string {
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => p !== '' && p !== '/').map(real))].sort();
}

/**
 * 家目录里的 PATH 项（asdf、~/.local/bin……）连同它的上一层：渲染器跑的命令从这里来，读不到就起不来。
 * 要上一层是因为版本管理器的 shim 只是转一道（~/.asdf/shims/codex → ~/.asdf/installs/nodejs/…），
 * ~/.local/bin/claude 指向 ~/.local/share/claude/versions/…（2026-11 实测）。家目录本身不算。
 */
function homePathEntries(env: SandboxPaths['env'], home: string): string[] {
  const out: string[] = [];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const resolved = real(dir);
    if (!resolved.startsWith(home + path.sep)) continue;
    out.push(resolved);
    const parent = path.dirname(resolved);
    if (parent !== home) out.push(parent);
  }
  return out;
}

/** 家目录根上几个工具要读的配置文件：asdf 按它选版本，git、npm 读自己的配置。 */
const homeConfigFiles = ['.tool-versions', '.asdfrc', '.gitconfig', '.npmrc'];

function regexQuote(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/** 生成 sandbox-exec 的规则文本（SBPL）。后写的规则优先，所以先整体禁止，再逐项放开，最后再收回凭据。 */
export function sandboxProfile(p: SandboxPaths): string {
  const home = real(p.env.HOME ?? '');
  const data = dataDir(p.env);
  const tmp = unique([p.env.TMPDIR ?? '', '/private/tmp', '/private/var/folders']);
  // HyperFrames 渲染要读写自己的缓存（~/.cache/hyperframes），读不到就直接 EPERM 退出（实测）。
  const caches = home ? [path.join(home, '.cache', 'hyperframes')] : [];
  const writable = unique([p.sceneDir, ...tmp, ...p.toolStateDirs, ...caches]);
  const readable = unique([
    p.projectRoot,
    ...p.toolStateDirs,
    ...caches,
    data,
    home ? path.join(home, 'Library') : '',
    ...p.readDirs,
    ...(home ? homePathEntries(p.env, home) : []),
    ...(home ? homeConfigFiles.map((f) => path.join(home, f)) : []),
  ]);
  // 家目录根上的状态文件按前缀放行（~/.claude.json 写的时候先写 ~/.claude.json.tmp.… 再改名）。
  const stateFiles = (p.toolStateFiles ?? []).filter((f) => f !== '').map((f) => `  (regex #"^${regexQuote(path.join(home || path.dirname(f), path.basename(f)))}")`);
  const secrets = unique([data ? path.join(data, 'agent') : '', p.env.ONSET_AGENT_DIR ?? '']);
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...writable.map((d) => `  (subpath ${quote(d)})`),
    ...stateFiles,
    '  (regex #"^/dev/"))',
  ];
  if (home) {
    lines.push(`(deny file-read-data (subpath ${quote(home)}))`, '(allow file-read-data', ...readable.map((d) => `  (subpath ${quote(d)})`), ...stateFiles, ')');
  }
  // 渲染工具的用户级技能与插件：读不到就不会出现在它的技能列表里，渲染器只看见镜头自己的那几个（stageRendererSkills）。
  const hidden = unique(p.hiddenDirs ?? []);
  if (hidden.length > 0) lines.push('(deny file-read-data', ...hidden.map((d) => `  (subpath ${quote(d)})`), ')');
  if (p.isolatedProject) {
    // 即使项目位于可写的临时目录、工具目录里，也要最后收紧；真实路径同时挡住绕向其他选手的软链接。
    lines.push(`(deny file-read-data file-write* (subpath ${quote(real(p.projectRoot))}))`);
    lines.push('(allow file-read-data', ...unique([p.sceneDir, ...p.isolatedProject.readDirs]).map(d => `  (subpath ${quote(d)})`),
      ...unique(p.isolatedProject.readFiles).map(f => `  (literal ${quote(f)})`), ')');
    lines.push(`(allow file-write* (subpath ${quote(real(p.sceneDir))}))`);
  }
  // 凭据最后收回。读要写成 file-read-data：Seatbelt 里同一路径上更具体的操作压过 file-read*，
  // 写成 file-read* 的话前面放开项目目录的 allow file-read-data 照样让 .env 读得到（实测）。
  lines.push('(deny file-read-data file-write*', '  (regex #"/\\.env$")', '  (regex #"/\\.env\\.[^/]*$")', ...secrets.map((d) => `  (subpath ${quote(d)})`), ')');
  return lines.join('\n') + '\n';
}

/** 渲染工具在家目录里的东西：要能读写的状态目录与根上的状态文件，要藏起来的用户级技能与插件。 */
export interface RendererHome {
  state: string[];
  files: string[];
  hidden: string[];
}

/**
 * 各家渲染工具在家目录里的落点（2026-11 实测）。技能的发现位置：claude 读 .claude/skills，codex 读 .agents/skills 与
 * .codex/skills，codebuddy 读 .codebuddy/skills，opencode 读 .agents/skills、.claude/skills、.opencode/skill(s)，qoder 读
 * .qoder-cn/skills（国际版 .qoder/skills）与 .agents/skills；家目录里的这些一律藏起来，镜头要用的技能由 stageRendererSkills 链进镜头目录。
 */
export function rendererHome(tool: string, home: string): RendererHome {
  const h = (...p: string[]) => path.join(home, ...p);
  const agents = h('.agents', 'skills');
  switch (tool) {
    case 'claude':
      return { state: [h('.claude')], files: [h('.claude.json')], hidden: [h('.claude', 'skills'), h('.claude', 'plugins'), agents] };
    case 'codex':
      return { state: [h('.codex')], files: [], hidden: [h('.codex', 'skills'), h('.codex', 'plugins'), agents] };
    case 'codebuddy':
      return { state: [h('.codebuddy')], files: [h('.codebuddy.json')], hidden: [h('.codebuddy', 'skills'), h('.codebuddy', 'plugins'), agents] };
    case 'opencode':
      return {
        state: [h('.local', 'share', 'opencode'), h('.local', 'state', 'opencode'), h('.cache', 'opencode'), h('.config', 'opencode')],
        files: [],
        hidden: [h('.config', 'opencode', 'skills'), h('.config', 'opencode', 'skill'), h('.claude', 'skills'), agents],
      };
    // mcode 的数据目录 ~/.minimax 放登录态、会话、sqlite 与后台任务日志，要写；用户级技能与插件藏起来，.builtin-skills 是它自带的，
    // 照常可读。启动时对数据目录本身加锁（同级的 ~/.minimax.lock），写不了就报 agent_name_conflict_migration_failed:lock（0.6.12 实测）。
    case 'mcode':
      return { state: [h('.minimax')], files: [h('.minimax.lock')], hidden: [h('.minimax', 'skills'), h('.minimax', 'plugins'), agents] };
    // 国内版的状态在 ~/.qoder-cn，国际版在 ~/.qoder；两版共用 .qoder/skills 的写法，两边都放行、都藏技能。
    case 'qoder':
    case 'qoder-intl':
      return { state: [h('.qoder-cn'), h('.qoder')], files: [], hidden: [h('.qoder-cn', 'skills'), h('.qoder', 'skills'), agents] };
    // Antigravity CLI（agy，1.5.13 实测）：状态、会话、日志与 MCP schema 缓存在 ~/.gemini/antigravity-cli，
    // 全局配置在 ~/.gemini/config；隐藏用户级技能、插件与全局 mcp_config.json，避免渲染器带上用户的个人 MCP 与技能。
    case 'agy':
      return {
        state: [h('.gemini', 'antigravity-cli')],
        files: [],
        hidden: [h('.gemini', 'skills'), h('.gemini', 'config', 'skills'), h('.gemini', 'config', 'plugins'), h('.gemini', 'config', 'mcp_config.json'), agents],
      };
    default:
      return { state: [], files: [], hidden: [] };
  }
}

/** 把渲染器的命令行套进沙箱。argv[0] 要已经是绝对路径（lookPath 之后）。 */
export function sandboxed(argv: string[], profile: string): string[] {
  return [SandboxExec, '-p', profile, ...argv];
}
