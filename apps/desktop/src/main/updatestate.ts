/**
 * 客户端更新的状态与说法（纯函数，不碰 Electron，单测在 updatestate.test.ts）。接 electron-updater 的在 updater.ts。
 * 界面拿到的形状与 renderer/types.ts 的 UpdateState 一致，改一处要改另一处。
 */

/** 发布在哪：与 package.json 的 build.publish 一致。 */
export const ReleaseOwner = 'OnSet-VibeMotion';
export const ReleaseRepo = 'OnSet';
export const ReleasesURL = `https://github.com/${ReleaseOwner}/${ReleaseRepo}/releases/latest`;

/** 启动后多久第一次检查、之后多久查一次。 */
export const FirstCheckDelayMs = 30_000;
export const CheckIntervalMs = 6 * 60 * 60 * 1000;

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** 现在这一版。 */
  current: string;
  /** 有新版本时：新版本号、更新说明（纯文字）、发布时间。 */
  version: string;
  notes: string;
  released_at: string;
  /** 下载进度（0–100）与速度。 */
  percent: number;
  transferred: number;
  total: number;
  bytes_per_second: number;
  /** 出错时给人看的一句话。 */
  error: string;
  /** 不检查更新的原因（status 为 disabled）。 */
  disabled_reason: string;
  /** 最近一次检查完的时间。 */
  checked_at: string;
  /** 手动下载的地方：自动更新用不了时给用户的退路。 */
  release_url: string;
}

export function initialState(current: string, disabledReason: string): UpdateState {
  return {
    status: disabledReason === '' ? 'idle' : 'disabled',
    current,
    version: '',
    notes: '',
    released_at: '',
    percent: 0,
    transferred: 0,
    total: 0,
    bytes_per_second: 0,
    error: '',
    disabled_reason: disabledReason,
    checked_at: '',
    release_url: ReleasesURL,
  };
}

/**
 * 不检查更新的原因，空是要检查：开发时（没打包）、端到端测试（后台运行）、显式关掉（ONSET_DISABLE_UPDATE=1）、
 * 没有安装包的平台。
 */
export function disabledReason(opts: { packaged: boolean; platform: string; env: Record<string, string | undefined> }): string {
  if (opts.env.ONSET_DISABLE_UPDATE === '1') return '这台电脑关掉了自动更新（ONSET_DISABLE_UPDATE=1）';
  if (opts.env.ONSET_DESKTOP_BACKGROUND === '1') return '测试运行时不检查更新';
  if (!opts.packaged) return '开发版不检查更新';
  if (opts.platform !== 'darwin' && opts.platform !== 'win32') return '这个平台还没有安装包，请到发布页看看';
  return '';
}

/** 版本号带预发布标记（1.2.0-beta.1）的客户端也收预发布版，正式版只收正式版。 */
export function wantsPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/** electron-updater 的更新说明：GitHub 给的是 HTML，可能是字符串或按版本的数组。转成纯文字，过长截断。 */
export function notesText(notes: unknown, max = 2000): string {
  let raw = '';
  if (typeof notes === 'string') raw = notes;
  else if (Array.isArray(notes)) raw = notes.map((n) => (n && typeof n === 'object' && typeof (n as { note?: unknown }).note === 'string' ? (n as { note: string }).note : '')).join('\n\n');
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 出错时给人看的话：连不上、没签名、发布页上缺文件，其余照原话。 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split('\n')[0].trim();
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|net::ERR_|socket hang up|timed? ?out/i.test(raw)) {
    return '连不上更新服务器。可以在「网络与更新」里填代理或换一个更新地址，再点「检查更新」。';
  }
  if (/code ?signature|not signed|SecCodeCheckValidity|ShipIt|Squirrel/i.test(raw)) {
    return '这份片场没有签名，不能自动安装更新，请到发布页下载新版本。';
  }
  if (/\b404\b|Cannot find .*latest|No published versions|Unable to find latest version/i.test(raw)) {
    return '发布页上还没有这一版的更新文件，请稍后再试，或到发布页下载。';
  }
  if (/sha512 checksum mismatch|checksum/i.test(raw)) return '下载的文件和发布页上的校验值对不上，已经丢掉，请重试。';
  return first.length > 300 ? first.slice(0, 300) + '…' : first;
}

/** 重启装更新会打断的事：写锁的持有者（一轮对话、渲染……）按项目列成一句一项。 */
export function busyLines(work: { project: string; holder: string }[]): string[] {
  return work.map((w) => {
    const name = w.project.split(/[\\/]/).filter(Boolean).pop() ?? w.project;
    return `${name}：${w.holder}`;
  });
}
