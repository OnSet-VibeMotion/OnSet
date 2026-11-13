import { app, BrowserWindow, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/*
 * 桌宠：一个透明、无边框、置顶的小窗口，里面是一间 2.5D 像素工作室：导演（编排工具）、摄影（渲染器）、剪辑、配音各在各的位置，
 * 谁在干活谁就动起来。
 *
 * 状态不在这里算：主窗口的界面从会话事件推出（components/chat/crew.ts 的 crewState），经 am:crew 发来，
 * 这里只记下最新的一份转给桌宠窗口；桌宠窗口刚载入时也补发一次。不装 hooks、不读 CLI 的记录文件。
 * 显示与否、位置记在 userData/pet.json，菜单「窗口 → 场记桌宠」开关。
 */

/** 窗口大小：工作室 384×264（128×88 格，每格 3 像素）加上卡片的边、底下一行小字与四周的阴影。 */
const width = 408;
const height = 308;

interface PetPrefs {
  visible: boolean;
  x?: number;
  y?: number;
}

let pet: BrowserWindow | null = null;
let latest: unknown = null;
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
  // 浮在普通窗口之上，切桌面、别的应用全屏时也在。
  pet.setAlwaysOnTop(true, 'floating');
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pet.webContents.on('did-finish-load', () => pet?.webContents.send('am:crew', latest));
  if (!options.background && prefs.visible) pet.once('ready-to-show', () => pet?.showInactive());
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

/** 显示或收起桌宠，记住选择。 */
export function setPetVisible(visible: boolean): void {
  writePrefs({ ...readPrefs(), visible });
  if (pet && !pet.isDestroyed()) {
    if (visible) pet.showInactive();
    else pet.hide();
  }
  onVisibility(visible);
}

export function installPetIPC(): void {
  // 主窗口的界面报来小人此刻的状态（null 是没有进行中的一轮）。
  ipcMain.on('am:crew', (_event, state: unknown) => {
    latest = state ?? null;
    if (pet && !pet.isDestroyed()) pet.webContents.send('am:crew', latest);
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
