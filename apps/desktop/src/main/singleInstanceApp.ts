/**
 * 单实例锁的 Electron 主进程接入（纯判断逻辑在 singleInstance.ts）。
 * 拿到锁后监听 second-instance：同构建仅置前窗口，不同路径或磁盘包已替换时切到新实例。
 */
import { app, type BrowserWindow, dialog } from 'electron';
import {
  currentInstanceIdentity,
  decideSecondInstance,
  decorateStaleStartError,
  type InstanceIdentity,
  isBundleStaleOnDisk,
  parseIncomingIdentity,
  readBundleSignature,
} from './singleInstance';

export interface SingleInstanceHandle {
  identity: InstanceIdentity;
  wrapStartResponse(pathname: string, response: Response): Promise<Response>;
}

/** 尝试申请单实例锁：拿不到则退出当前进程并返回 null；拿到则接管 second-instance。 */
export function acquireSingleInstance(opts: {
  mainFile: string;
  background: boolean;
  mainWindow: () => BrowserWindow | undefined;
  activeWork: () => { project: string; holder: string }[];
}): SingleInstanceHandle | null {
  const identity = currentInstanceIdentity({
    execPath: process.execPath,
    appPath: app.getAppPath(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    mainFile: opts.mainFile,
  });
  if (!app.requestSingleInstanceLock(identity)) {
    app.quit();
    return null;
  }

  let switching = false;
  let confirming = false;
  const focusMain = () => {
    const win = opts.mainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return win;
  };
  const switchTo = (target: { execPath: string; args: string[] }) => {
    if (switching) return;
    switching = true;
    app.relaunch({ execPath: target.execPath, args: target.args });
    app.quit();
  };

  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    const decision = decideSecondInstance({
      self: identity,
      incoming: parseIncomingIdentity(additionalData),
      onDiskSignature: readBundleSignature(identity.bundlePath),
      activeWork: opts.activeWork(),
      background: opts.background,
    });
    if (decision.kind === 'switch') {
      switchTo(decision.target);
      return;
    }
    const win = focusMain();
    if (decision.kind !== 'confirm_switch' || confirming) return;
    confirming = true;
    const messageBoxOpts = {
      type: 'question' as const,
      buttons: ['留在当前窗口', '停止任务并切换'],
      defaultId: 0,
      cancelId: 0,
      title: '切换到新打开的片场',
      message: '检测到另一版本或已更新的片场客户端',
      detail: `${decision.reason}。当前有进行中的任务：\n- ${decision.busy.join('\n- ')}\n\n切换会停止这些任务并重启到刚打开的片场。`,
    };
    const box = win ? dialog.showMessageBox(win, messageBoxOpts) : dialog.showMessageBox(messageBoxOpts);
    void box
      .then(({ response }) => {
        if (response === 1) switchTo(decision.target);
      })
      .finally(() => {
        confirming = false;
      });
  });

  return {
    identity,
    async wrapStartResponse(pathname: string, response: Response): Promise<Response> {
      if (pathname !== '/api/production/start' || response.ok || !isBundleStaleOnDisk(identity)) return response;
      const body = decorateStaleStartError(await response.text(), true);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}
