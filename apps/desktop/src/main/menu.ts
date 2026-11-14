import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { mainWindow } from './pet';

/**
 * 原生菜单。菜单项只发「做什么」给当前窗口的界面（onset:menu），界面用它已有的状态与接口去做：
 * 新建、切页这些逻辑只在界面里有一份，菜单不另写。选目录用系统对话框，选好后把路径一并发过去。
 */
export type MenuAction = { type: 'new' } | { type: 'home' } | { type: 'open'; path: string } | { type: 'step'; index: number } | { type: 'settings' } | { type: 'panel' } | { type: 'reveal' };

/** 菜单动作发给客户端窗口；焦点在桌宠上时也发给主窗口。 */
function target(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  return focused && focused === mainWindow() ? focused : mainWindow();
}

function send(action: MenuAction): void {
  const win = target();
  win?.webContents.send('onset:menu', action);
}

async function openFolder(): Promise<void> {
  const win = target();
  const options = { title: '打开项目文件夹', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (!result.canceled && result.filePaths[0]) send({ type: 'open', path: result.filePaths[0] });
}

/** 桌宠的开关：菜单「窗口 → 场记桌宠」，勾选状态随显示与否重建菜单。 */
export interface PetMenu {
  visible: boolean;
  toggle: (visible: boolean) => void;
}

export function installMenu(pet?: PetMenu): void {
  const steps = ['口播稿', '分镜', '镜头', '成片', '发布'];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于片场' },
              { type: 'separator' },
              { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => send({ type: 'settings' }) },
              { type: 'separator' },
              { role: 'hide', label: '隐藏' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出片场' },
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
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(pet
          ? ([
              { type: 'separator' },
              { label: '场记桌宠', type: 'checkbox', checked: pet.visible, click: (item) => pet.toggle(item.checked) },
            ] as MenuItemConstructorOptions[])
          : []),
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform === 'win32') {
    for (const win of BrowserWindow.getAllWindows()) {
      // 菜单收进顶栏的入口，Alt 也不再唤回一条系统菜单栏；快捷键仍由原菜单登记。
      win.setAutoHideMenuBar(false);
      win.setMenuBarVisibility(false);
    }
  }
  app.setAboutPanelOptions({ applicationName: '片场', copyright: '把文章做成竖屏动画视频' });
}
