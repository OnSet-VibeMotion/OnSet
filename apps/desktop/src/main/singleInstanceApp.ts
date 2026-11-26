/**
 * 单实例锁的 Electron 主进程接入（纯判断逻辑在 singleInstance.ts）。
 * 拿到锁后监听 second-instance，并在 macOS activate 时复用同一套陈旧构建检测：
 * 同构建仅置前窗口，不同路径或磁盘包已替换时切到新实例。
 */
import { app, type BrowserWindow, dialog } from 'electron';
import {
  captureExplicitRelaunchEnv,
  currentInstanceIdentity,
  decideSecondInstance,
  decorateStaleStartError,
  type InstanceIdentity,
  isBundleStaleOnDisk,
  parseIncomingIdentity,
  readBundleSignature,
  sanitizeRelaunchEnv,
} from './singleInstance';

export interface SingleInstanceHandle {
  identity: InstanceIdentity;
  /** macOS 从 Finder/Dock 重新激活已运行应用时检查磁盘包是否已被替换；正在切换退出时返回 true。 */
  checkStaleOnActivate(): boolean;
  wrapStartResponse(pathname: string, response: Response): Promise<Response>;
}

/** 尝试申请单实例锁：拿不到则退出当前进程并返回 null；拿到则接管 second-instance 与 activate 陈旧检测。 */
export function acquireSingleInstance(opts: {
  mainFile: string;
  background: boolean;
  mainWindow: () => BrowserWindow | undefined;
  activeWork: () => { project: string; holder: string }[];
}): SingleInstanceHandle | null {
  // 必须在 app.whenReady() 自动写入 ONSET_ASSETS_DIR / ONSET_SELF 等变量之前快照外部显式覆盖。
  const explicitEnv = captureExplicitRelaunchEnv(process.env);
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
  let dismissedSignature = '';
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
    sanitizeRelaunchEnv(process.env, explicitEnv);
    app.relaunch({ execPath: target.execPath, args: target.args });
    app.quit();
  };

  /** 统一处理 second-instance 与 macOS activate 的陈旧构建检查；触发切换退出时返回 true。 */
  const handleCheck = (incoming: InstanceIdentity | null, source: 'second-instance' | 'activate'): boolean => {
    const onDiskSignature = readBundleSignature(identity.bundlePath);
    const decision = decideSecondInstance({
      self: identity,
      incoming,
      onDiskSignature,
      activeWork: opts.activeWork(),
      background: opts.background,
    });
    if (decision.kind === 'switch') {
      switchTo(decision.target);
      return true;
    }
    const win = source === 'second-instance' ? focusMain() : opts.mainWindow();
    if (decision.kind !== 'confirm_switch' || confirming) return false;
    if (source === 'activate' && onDiskSignature !== '' && dismissedSignature === onDiskSignature) return false;
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
        else if (onDiskSignature !== '') dismissedSignature = onDiskSignature;
      })
      .finally(() => {
        confirming = false;
      });
    return false;
  };

  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    handleCheck(parseIncomingIdentity(additionalData), 'second-instance');
  });

  return {
    identity,
    checkStaleOnActivate: () => handleCheck(null, 'activate'),
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
