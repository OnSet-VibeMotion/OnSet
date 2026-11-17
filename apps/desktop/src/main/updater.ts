/**
 * 客户端自动更新：electron-updater 读 GitHub Releases 上的 latest-mac.yml / latest.yml（release.yml 生成）。
 * macOS 用 Squirrel.Mac，要求应用签名并公证（发布流程已经接上）；Windows 是未签名的 NSIS，不设 publisherName 就不校验签名。
 *
 * - 只检查、不自动下载：发现新版本先告诉用户，用户点「下载」才下，下完点「重启并安装」。下载后等用户明确选择安装。
 * - 启动 30 秒后查一次，之后每 6 小时一次；下载中、下好了不再查。
 * - 联网：设置里的 NETWORK_PROXY 设在 electron-updater 自己的会话上，没填跟系统代理；UPDATE_FEED_URL 填了改用 generic 地址（镜像）。
 * - 重启前先看有没有正在跑的对话、渲染（Server.activeWork），有就把会打断的事交给界面问用户，用户确认了才装。
 * 开发版、端到端测试（ONSET_DESKTOP_BACKGROUND=1）与 ONSET_DISABLE_UPDATE=1 时不接 electron-updater，状态是 disabled。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import * as config from '@onset/engine/config';
import { proxyRules } from './network';
import { busyLines, CheckIntervalMs, disabledReason, errorText, FirstCheckDelayMs, initialState, notesText, ReleaseOwner, ReleaseRepo, wantsPrerelease, type UpdateState } from './updatestate';

export type UpdateAction = 'check' | 'download' | 'install' | 'open-release';

export interface UpdaterOptions {
  /** 正在跑的、重启会打断的事。 */
  activeWork: () => { project: string; holder: string }[];
}

let state: UpdateState;
let downloading = false;

function publish(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('onset:update', state);
  }
}

/** 每次检查前现读设置：改了代理、更新地址不用重启。 */
async function configure(): Promise<void> {
  const env = process.env;
  const proxy = config.machineSetting(env, 'NETWORK_PROXY', config.parseConfFile);
  await autoUpdater.netSession.setProxy(proxy === '' ? { mode: 'system' } : { proxyRules: proxyRules(proxy) });
  const feed = config.machineSetting(env, 'UPDATE_FEED_URL', config.parseConfFile);
  autoUpdater.setFeedURL(feed === '' ? { provider: 'github', owner: ReleaseOwner, repo: ReleaseRepo } : { provider: 'generic', url: feed });
}

async function check(): Promise<void> {
  if (downloading || ['checking', 'downloading', 'downloaded', 'installing', 'disabled'].includes(state.status)) return;
  publish({ status: 'checking', version: '', error: '' });
  try {
    await configure();
    await autoUpdater.checkForUpdates();
  } catch (err) {
    publish({ status: 'error', error: errorText(err), checked_at: new Date().toISOString() });
  }
}

async function download(): Promise<void> {
  if (downloading || (state.status !== 'available' && !(state.status === 'error' && state.version !== ''))) return;
  downloading = true;
  let verified = false;
  publish({ status: 'checking', error: '' });
  try {
    await configure();
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) return;
    verified = true;
    publish({ status: 'downloading', percent: 0, transferred: 0, total: 0, bytes_per_second: 0, error: '' });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    publish({ status: 'error', version: verified ? state.version : '', error: errorText(err) });
  } finally {
    downloading = false;
  }
}

export function installUpdater(opts: UpdaterOptions): void {
  const reason = disabledReason({ packaged: app.isPackaged, platform: process.platform, env: process.env });
  state = initialState(app.getVersion(), reason);

  ipcMain.handle('onset:update-state', () => state);
  ipcMain.handle('onset:update-action', async (_event, action: UpdateAction, force?: boolean) => {
    switch (action) {
      case 'check':
        await check();
        return { ok: true };
      case 'download':
        void download();
        return { ok: true };
      case 'open-release':
        await shell.openExternal(state.release_url);
        return { ok: true };
      case 'install': {
        if (state.status !== 'downloaded') return { ok: false, busy: [] };
        const busy = busyLines(opts.activeWork());
        if (busy.length > 0 && force !== true) return { ok: false, busy };
        // 关窗、走 before-quit / will-quit（停掉进行中的对话与任务、关插件网页），再由 Squirrel / NSIS 换上新版本并重新打开。
        publish({ status: 'installing', error: '' });
        setImmediate(() => {
          try { autoUpdater.quitAndInstall(false, true); }
          catch (err) { publish({ status: 'error', version: '', error: errorText(err) }); }
        });
        return { ok: true };
      }
    }
    return { ok: false };
  });
  if (reason !== '') return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = wantsPrerelease(app.getVersion());
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    publish({ status: 'available', version: info.version, notes: notesText(info.releaseNotes), released_at: info.releaseDate ?? '', checked_at: new Date().toISOString(), error: '' });
  });
  autoUpdater.on('update-not-available', () => {
    publish({ status: 'latest', version: '', checked_at: new Date().toISOString(), error: '' });
  });
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    publish({ status: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total, bytes_per_second: p.bytesPerSecond });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    publish({ status: 'downloaded', version: info.version, percent: 100, error: '' });
  });
  autoUpdater.on('error', (err: Error) => {
    // 下载中途出错：保留版本号，界面给「重试下载」；检查出错由 check() 的 catch 记。
    if (state.status === 'installing') {
      publish({ status: 'error', version: '', error: errorText(err) });
      return;
    }
    if (state.status === 'downloading' || state.status === 'checking') publish({ status: 'error', error: errorText(err) });
  });

  const first = setTimeout(() => void check(), FirstCheckDelayMs);
  const every = setInterval(() => void check(), CheckIntervalMs);
  first.unref?.();
  every.unref?.();
  app.on('will-quit', () => {
    clearTimeout(first);
    clearInterval(every);
  });
}
