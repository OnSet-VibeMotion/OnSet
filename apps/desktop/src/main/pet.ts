import { app, BrowserWindow, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/*
 * 桌宠：一个透明、无边框、置顶的小窗口，里面是一间等距线稿工作室：导演（编排工具）、摄影（渲染器）、剪辑、配音各在各的位置，
 * 谁在干活谁就动起来。
 *
 * 状态不在这里算：主窗口的界面从会话事件推出（components/chat/crew.ts 的 crewState），经 am:crew 发来，
 * 这里只记下最新的一份转给桌宠窗口；桌宠窗口刚载入时也补发一次。不装 hooks、不读 CLI 的记录文件。
 * 显示与否、位置记在 userData/pet.json，菜单「窗口 → 场记桌宠」开关。
 */

/** 窗口大小：工作室画布 400×326 加上卡片的边、底下一行小字与四周的阴影。 */
const width = 424;
const height = 368;

interface PetPrefs {
  visible: boolean;
  x?: number;
  y?: number;
}

let pet: BrowserWindow | null = null;
let latest: unknown = null;
/** 后台运行（端到端测试）时永远不显示。 */
let hidden = false;
let onVisibility: (visible: boolean) => void = () => {};

function prefsFile(): string {
  return path.join(app.getPath('userData'), 'pet.json');
}

function readPrefs(): PetPrefs {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as Partial<PetPrefs>;
    return { visible: parsed.visible !== false, x: num(parsed.x), y: num(parsed.y) };
  } catch {
    return { visible: true };
  }
}

function writePrefs(prefs: PetPrefs): void {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2) + '\n');
  } catch {
    // 记不下位置不影响使用。
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

/** 上次的位置还在某块屏幕里就用它，否则放到主屏右下角。 */
function placement(prefs: PetPrefs): { x: number; y: number } {
  if (prefs.x !== undefined && prefs.y !== undefined) {
    const inside = screen.getAllDisplays().some(({ workArea: a }) => prefs.x! >= a.x && prefs.y! >= a.y && prefs.x! + width <= a.x + a.width && prefs.y! + height <= a.y + a.height);
    if (inside) return { x: prefs.x, y: prefs.y };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height - 24 };
}

/** 主窗口：除桌宠之外的那一个。 */
export function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((win) => win !== pet && !win.isDestroyed());
}

/** 用户选的是显示还是收起（菜单的勾）。 */
export function petPreferred(): boolean {
  return readPrefs().visible;
}

/**
 * 建桌宠窗口。后台运行（端到端测试）时照样建、照样收状态，只是永远不显示，不抢开发者的屏幕。
 * `url` 是界面的地址（am://app/pet），`preload` 与主窗口共用。
 */
export function createPet(options: { url: string; preload: string; background: boolean; onVisibility: (visible: boolean) => void }): void {
  onVisibility = options.onVisibility;
  const prefs = readPrefs();
  const at = placement(prefs);
  pet = new BrowserWindow({
    width,
    height,
    x: at.x,
    y: at.y,
    // macOS 上做成不抢焦点的面板（NSPanel）：只有面板能在应用仍是普通应用（有 Dock 图标）时盖在别的应用的全屏上。
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '场记',
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: !options.background,
    },
  });
  // 浮在普通窗口之上，切桌面、别的应用全屏时也在（后者靠上面的面板类型）。
  // skipTransformProcessType 不能去掉：带 visibleOnFullScreen 时 Electron 默认把整个应用改成辅助程序
  // （UIElement），Dock 图标与 ⌘Tab 里的入口一起消失（实测）。
  pet.setAlwaysOnTop(true, 'floating');
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  pet.webContents.on('did-finish-load', () => pet?.webContents.send('am:crew', latest));
  hidden = options.background;
  pet.once('ready-to-show', syncVisibility);
  pet.on('moved', () => {
    if (!pet) return;
    const [x, y] = pet.getPosition();
    writePrefs({ ...readPrefs(), x, y });
  });
  pet.on('closed', () => {
    pet = null;
  });
  void pet.loadURL(options.url);
}

/**
 * 桌宠只在打开了项目时出现：工作室画的是这个项目的摄制组，首页、新手引导这些地方没有可画的。
 * 主窗口的对话在项目里时一直报状态（没有进行中的一轮也报「待命」），离开项目时报 null。
 */
function syncVisibility(): void {
  if (!pet || pet.isDestroyed()) return;
  const show = !hidden && readPrefs().visible && latest !== null;
  if (show && !pet.isVisible()) pet.showInactive();
  if (!show && pet.isVisible()) pet.hide();
}

/** 显示或收起桌宠，记住选择。 */
export function setPetVisible(visible: boolean): void {
  writePrefs({ ...readPrefs(), visible });
  syncVisibility();
  onVisibility(visible);
}

export function installPetIPC(): void {
  // 主窗口的界面报来工作室此刻的状态（null 是没有打开项目）。
  ipcMain.on('am:crew', (_event, state: unknown) => {
    latest = state ?? null;
    if (pet && !pet.isDestroyed()) pet.webContents.send('am:crew', latest);
    syncVisibility();
  });
  // 桌宠窗口里的按钮：双击回到客户端、收起桌宠。
  ipcMain.on('am:pet', (_event, action: unknown) => {
    if (action === 'hide') setPetVisible(false);
    if (action === 'focus') {
      const win = mainWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}
