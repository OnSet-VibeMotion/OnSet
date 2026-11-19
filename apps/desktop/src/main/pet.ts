import { app, BrowserWindow, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pluginWindows } from './pluginwindows';

/*
 * 桌宠：一个透明、无边框、置顶的小窗口，里面是一间等距线稿工作室：制作人（编排工具）、摄影（渲染器）、剪辑、配音各在各的位置，
 * 谁在干活谁就动起来。
 *
 * 状态不在这里算：主窗口的界面从会话事件推出（components/chat/crew.ts 的 crewState），经 onset:crew 发来，
 * 这里只记下最新的一份转给桌宠窗口；桌宠窗口刚载入时也补发一次。不装 hooks、不读 CLI 的记录文件。
 * 显示与否、位置记在 userData/pet.json，菜单「窗口 → 场记桌宠」开关。
 *
 * 桌宠上也能动手（PetCommand，经 onset:pet 发来）：答批准、点上一轮的选项、说一句、停下这一轮交给主窗口的对话，
 * 不抢焦点；点人或东西（open）先把主窗口叫到前面再切页。桌宠自己不调接口，会话、批准都只有主窗口一份。
 */

/**
 * 窗口大小：用户拖右下角的把手改，记在 pet.json。缺省比最早的小卡片大一些，放得下选中人的状态面板与环形菜单；
 * 最小是工作室画布 400×326 加上卡片的边与底下一行。不用系统的可调大小：透明窗口在有的平台上开了它会出问题，
 * 而且 e2e 按「能不能调大小」认主窗口。
 */
const defaultSize = { width: 640, height: 500 };
const minSize = { width: 424, height: 368 };
const maxSize = { width: 1400, height: 1000 };

interface PetPrefs {
  visible: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
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
    return { visible: parsed.visible !== false, x: num(parsed.x), y: num(parsed.y), width: num(parsed.width), height: num(parsed.height) };
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

function sizeOf(prefs: PetPrefs): { width: number; height: number } {
  return {
    width: Math.min(maxSize.width, Math.max(minSize.width, prefs.width ?? defaultSize.width)),
    height: Math.min(maxSize.height, Math.max(minSize.height, prefs.height ?? defaultSize.height)),
  };
}

/** 上次的位置还在某块屏幕里就用它，否则放到主屏右下角。 */
function placement(prefs: PetPrefs): { x: number; y: number } {
  const { width, height } = sizeOf(prefs);
  if (prefs.x !== undefined && prefs.y !== undefined) {
    const inside = screen.getAllDisplays().some(({ workArea: a }) => prefs.x! >= a.x && prefs.y! >= a.y && prefs.x! + width <= a.x + a.width && prefs.y! + height <= a.y + a.height);
    if (inside) return { x: prefs.x, y: prefs.y };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height - 24 };
}

/** 主窗口：除桌宠与插件网页窗口之外的那一个。 */
export function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((win) => win !== pet && !pluginWindows.has(win) && !win.isDestroyed());
}

/** 用户选的是显示还是收起（菜单的勾）。 */
export function petPreferred(): boolean {
  return readPrefs().visible;
}

/**
 * 建桌宠窗口。后台运行（端到端测试）时照样建、照样收状态，只是永远不显示，不抢开发者的屏幕。
 * `url` 是界面的地址（onset://app/pet），`preload` 与主窗口共用。
 */
export function createPet(options: { url: string; preload: string; background: boolean; onVisibility: (visible: boolean) => void }): void {
  onVisibility = options.onVisibility;
  const prefs = readPrefs();
  const at = placement(prefs);
  const size = sizeOf(prefs);
  pet = new BrowserWindow({
    width: size.width,
    height: size.height,
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
    // 桌宠不在前台时第一下点击就要落到按钮上（答批准、点选项），不能只用来把窗口变成键盘窗口。
    acceptFirstMouse: true,
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
  pet.webContents.on('did-finish-load', () => pet?.webContents.send('onset:crew', latest));
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

/**
 * 拖窗口：当桌宠的插件页面在沙箱 iframe 里，那一块不是窗口的拖动区域，页面里的拖动脚本报「开始」「结束」，
 * 这里在两者之间跟着鼠标挪窗口（按开始时鼠标在窗口里的位置）。结束报不来时 20 秒后自己停。
 */
let dragTimer: ReturnType<typeof setInterval> | null = null;

function startDrag(): void {
  if (!pet || pet.isDestroyed()) return;
  stopDrag();
  const [wx, wy] = pet.getPosition();
  const c = screen.getCursorScreenPoint();
  const offset = { x: c.x - wx, y: c.y - wy };
  const started = Date.now();
  dragTimer = setInterval(() => {
    if (!pet || pet.isDestroyed() || Date.now() - started > 20_000) return stopDrag();
    const p = screen.getCursorScreenPoint();
    pet.setPosition(p.x - offset.x, p.y - offset.y);
  }, 16);
}

/** 改大小：按住右下角把手时跟着鼠标改宽高（左上角不动），限在最小与最大之间。 */
function startResize(): void {
  if (!pet || pet.isDestroyed()) return;
  stopDrag();
  const [w0, h0] = pet.getSize();
  const c0 = screen.getCursorScreenPoint();
  const started = Date.now();
  dragTimer = setInterval(() => {
    if (!pet || pet.isDestroyed() || Date.now() - started > 30_000) return stopDrag();
    const c = screen.getCursorScreenPoint();
    const width = Math.min(maxSize.width, Math.max(minSize.width, w0 + c.x - c0.x));
    const height = Math.min(maxSize.height, Math.max(minSize.height, h0 + c.y - c0.y));
    pet.setSize(width, height);
  }, 16);
}

function stopDrag(): void {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  // 程序挪、改的窗口不一定发 moved / resized：拖完自己记下位置与大小。
  if (pet && !pet.isDestroyed()) {
    const [x, y] = pet.getPosition();
    const [width, height] = pet.getSize();
    writePrefs({ ...readPrefs(), x, y, width, height });
  }
}

export function installPetIPC(): void {
  // 主窗口的界面报来工作室此刻的状态（null 是没有打开项目）。
  ipcMain.on('onset:crew', (_event, state: unknown) => {
    latest = state ?? null;
    if (pet && !pet.isDestroyed()) pet.webContents.send('onset:crew', latest);
    syncVisibility();
  });
  // 桌宠窗口里的动作（renderer/components/chat/crew.ts 的 PetCommand）。
  ipcMain.on('onset:pet', (event, raw: unknown) => {
    if (!pet || event.sender !== pet.webContents) return;
    const command = petCommand(raw);
    if (!command) return;
    if (command.kind === 'hide') return setPetVisible(false);
    // 要打字时把桌宠设成键盘窗口：它是不激活应用的面板，盖在别的应用上也能直接打字。
    if (command.kind === 'type') return pet.focus();
    if (command.kind === 'drag') return command.phase === 'start' ? startDrag() : stopDrag();
    if (command.kind === 'resize') return command.phase === 'start' ? startResize() : stopDrag();
    const win = mainWindow();
    if (!win) return;
    if (command.kind === 'focus' || command.kind === 'open') {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (command.kind !== 'focus') win.webContents.send('onset:pet-command', command);
  });
}

type PetCommand =
  | { kind: 'focus' | 'hide' | 'type' | 'stop' }
  | { kind: 'drag' | 'resize'; phase: 'start' | 'end' }
  | { kind: 'open'; page: string; target?: string }
  | { kind: 'answer'; id: string; decision: 'allow' | 'always' | 'deny' }
  | { kind: 'say'; text: string };

/** 桌宠发来的动作只认这几种形状，别的丢掉（旧写法的 'focus' / 'hide' 字符串照认）。 */
function petCommand(raw: unknown): PetCommand | null {
  if (raw === 'focus' || raw === 'hide') return { kind: raw };
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  switch (r.kind) {
    case 'focus':
    case 'hide':
    case 'type':
    case 'stop':
      return { kind: r.kind };
    case 'open': {
      const page = str(r.page, 64);
      if (!page) return null;
      const target = str(r.target, 512);
      return target ? { kind: 'open', page, target } : { kind: 'open', page };
    }
    case 'drag':
    case 'resize':
      return r.phase === 'start' || r.phase === 'end' ? { kind: r.kind, phase: r.phase } : null;
    case 'answer': {
      const id = str(r.id, 128);
      const decision = r.decision;
      if (!id || (decision !== 'allow' && decision !== 'always' && decision !== 'deny')) return null;
      return { kind: 'answer', id, decision };
    }
    case 'say': {
      const text = typeof r.text === 'string' ? r.text.trim().slice(0, 4000) : '';
      return text ? { kind: 'say', text } : null;
    }
    default:
      return null;
  }
}
