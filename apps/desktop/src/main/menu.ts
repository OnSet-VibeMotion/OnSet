import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * 原生菜单。菜单项只发「做什么」给当前窗口的界面（am:menu），界面用它已有的状态与接口去做：
 * 新建、切页这些逻辑只在界面里有一份，菜单不另写。选目录用系统对话框，选好后把路径一并发过去。
 */
export type MenuAction = { type: 'new' } | { type: 'home' } | { type: 'open'; path: string } | { type: 'step'; index: number } | { type: 'settings' } | { type: 'panel' } | { type: 'reveal' };

function send(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send('am:menu', action);
}

async function openFolder(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const options = { title: '打开项目文件夹', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (!result.canceled && result.filePaths[0]) send({ type: 'open', path: result.filePaths[0] });
}

export function installMenu(): void {
  const steps = ['口播稿', '分镜', '镜头', '成片', '发布'];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 ArticleToMotion' },
              { type: 'separator' },
              { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => send({ type: 'settings' }) },
              { type: 'separator' },
              { role: 'hide', label: '隐藏' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 ArticleToMotion' },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建项目', accelerator: 'CmdOrCtrl+N', click: () => send({ type: 'new' }) },
        { label: '打开项目文件夹…', accelerator: 'CmdOrCtrl+O', click: () => void openFolder() },
        { label: '在 Finder 中显示项目', accelerator: 'Alt+CmdOrCtrl+R', click: () => send({ type: 'reveal' }) },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '视图',
      submenu: [
        { label: '首页', accelerator: 'CmdOrCtrl+0', click: () => send({ type: 'home' }) },
        ...steps.map((label, index) => ({ label, accelerator: `CmdOrCtrl+${index + 1}`, click: () => send({ type: 'step', index }) })),
        { label: '显示或收起画面', accelerator: 'CmdOrCtrl+\\', click: () => send({ type: 'panel' }) },
        { type: 'separator' },
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({ applicationName: 'ArticleToMotion', copyright: '把文章做成竖屏动画视频' });
}
