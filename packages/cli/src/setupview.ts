/**
 * onset setup 的终端界面：每项前置资源一行，状态图标、名字、版本、进展对齐成列。终端里原地重画（转圈图标与计时）；
 * 不是终端（管道、CI）时每次状态或阶段变化打一行，不重画。git / npm 的原始输出不上屏，写进日志文件。
 */
import os from 'node:os';
import type { Out } from './cobra';

export enum ViewState {
  Pending,
  Running,
  /** 本来就已就绪 */
  Ready,
  /** 这次装好 */
  Done,
  Failed,
}

export interface ViewItem {
  name: string;
  version: string;
  state: ViewState;
  detail: string;
  started: number;
  ended: number;
  /** 非终端模式下上一次打出的行，避免重复 */
  lastPrinted: string;
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class SetupView {
  readonly items: ViewItem[];
  private drawn = 0;
  private frame = 0;
  private timer?: NodeJS.Timeout;
  readonly color: boolean;

  constructor(
    private readonly out: Out,
    names: string[],
    versions: string[],
    /** 输出是不是终端：往 process.stdout 写时传 process.stdout.isTTY；测试与管道里是 false。 */
    readonly tty = false,
  ) {
    this.color = this.tty && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
    this.items = names.map((name, i) => ({ name, version: versions[i], state: ViewState.Pending, detail: '', started: 0, ended: 0, lastPrinted: '' }));
  }

  /** 开始重画（终端里每 100 毫秒一次）。 */
  start(): void {
    if (!this.tty) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.redraw();
    }, 100);
  }

  /** 停止重画并画最后一次。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.tty) this.redraw();
  }

  /** 改一项的状态与进展说明。 */
  set(index: number, state: ViewState, detail: string): void {
    const item = this.items[index];
    if (state === ViewState.Running && item.state !== ViewState.Running) item.started = Date.now();
    if ((state === ViewState.Done || state === ViewState.Failed) && item.ended === 0) item.ended = Date.now();
    item.state = state;
    item.detail = detail;
    if (this.tty) {
      this.redraw();
      return;
    }
    const line = this.line(index);
    if (line !== item.lastPrinted) {
      item.lastPrinted = line;
      this.out.write(line + '\n');
    }
  }

  /** 标成「本来就已就绪」，不在屏幕上打行（onset setup 开头先标好已就绪的项）。 */
  markReady(index: number): void {
    this.items[index].state = ViewState.Ready;
  }

  /** 只改进展说明（进行中的阶段）。 */
  detail(index: number, detail: string): void {
    this.set(index, this.items[index].state, detail);
  }

  private redraw(): void {
    let b = this.drawn > 0 ? `\x1b[${this.drawn}A` : '';
    for (let i = 0; i < this.items.length; i++) b += '\r\x1b[K' + this.line(i) + '\n';
    this.drawn = this.items.length;
    this.out.write(b);
  }

  /** 列宽：名字与版本按显示宽度（中文算两列）补齐。 */
  widths(): [number, number] {
    let name = 0;
    let version = 0;
    for (const item of this.items) {
      name = Math.max(name, displayWidth(item.name));
      version = Math.max(version, displayWidth(item.version));
    }
    return [name, version];
  }

  line(index: number): string {
    const item = this.items[index];
    const [nameWidth, versionWidth] = this.widths();
    let icon = '';
    let detail = '';
    switch (item.state) {
      case ViewState.Pending:
        icon = this.paint('2', '·');
        detail = this.paint('2', '等待');
        break;
      case ViewState.Running:
        icon = this.paint('36', this.tty ? spinnerFrames[this.frame % spinnerFrames.length] : '›');
        detail = item.detail;
        if (this.tty) detail += '  ' + this.paint('2', clock(Date.now() - item.started));
        break;
      case ViewState.Ready:
        icon = this.paint('32', '✓');
        detail = this.paint('2', '已就绪');
        break;
      case ViewState.Done:
        icon = this.paint('32', '✓');
        detail = '完成 ' + this.paint('2', '· ' + clock(item.ended - item.started));
        break;
      case ViewState.Failed:
        icon = this.paint('31', '✗');
        detail = this.paint('31', '失败');
        break;
    }
    let version = pad(item.version, versionWidth);
    if (versionWidth > 0) version = this.paint('2', version) + '  ';
    return '  ' + icon + ' ' + pad(item.name, nameWidth) + '  ' + version + detail;
  }

  paint(code: string, text: string): string {
    return this.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  }
}

/** 把耗时（毫秒）写成 m:ss，按秒四舍五入（Go 的 Duration.Round 远离零取整）。 */
export function clock(ms: number): string {
  const seconds = Math.floor(Math.abs(ms) / 1000 + 0.5) * Math.sign(ms || 1);
  return `${Math.trunc(seconds / 60)}:${String(Math.abs(seconds % 60)).padStart(2, '0')}`;
}

export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}＀-￯　-〿]/u;

/** 终端里的显示宽度：中日韩字符与全角符号占两列。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += wide.test(ch) ? 2 : 1;
  return width;
}

/** 文本最后 n 行非空行。 */
export function tailLines(text: string, n: number): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i].replace(/[ \t]+$/, '');
    if (line.trim() !== '') out.unshift(line);
  }
  return out;
}

/** 把家目录换成 ~，路径短一些。 */
export function homeShort(path: string): string {
  const home = os.homedir();
  return home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
}
