// 画幅与风格的选择。移植自 internal/cli/canvas.go 与 style.go。
import fs from 'node:fs';
import * as preset from '@am/engine/preset';
import { goPathError } from '@am/engine/fsutil';
import type { Out } from './cobra';

/** Go 的 %-Ns：按码点数在右侧补空格。 */
export function padRight(s: string, width: number): string {
  const n = [...s].length;
  return n >= width ? s : s + ' '.repeat(width - n);
}

/** 供错误信息与选择框共用的可读清单。 */
export function canvasOptions(): string {
  return preset
    .all()
    .map((p) => `  ${padRight(p.id, 16)}${p.label}`)
    .join('\n');
}

/** 一个可读按键的输入端。测试里用假的；实际是 process.stdin。 */
export interface Input {
  isTTY?: boolean;
  fd?: number;
}

/**
 * 判断输入是不是真正的交互终端。不能只看是不是字符设备：/dev/null 也是字符设备，
 * `am init < /dev/null` 会被误判成交互，绕过失败关闭直接掉进选择框，而选择框在没有 TTY 时读不到按键。
 */
export function isTerminal(input: Input | undefined): boolean {
  return Boolean(input && input.isTTY);
}

/**
 * 决定本次 init 使用哪套画幅预设。未显式传入且不在终端里时直接报错，不静默取默认值：
 * 画幅一旦选错，整个项目的排版基准、安全区和成片规格都是错的，而这在 init 当下不会有任何症状。
 */
export async function resolveCanvas(flag: string, stdin: Input | undefined, stdout: Out): Promise<preset.Preset> {
  if (flag !== '') {
    const p = preset.byID(flag);
    if (!p) throw new Error(`未知画幅 ${JSON.stringify(flag)}，可选：\n${canvasOptions()}`);
    return p;
  }
  if (!isTerminal(stdin)) throw new Error(`非交互环境必须显式传入 --canvas，可选：\n${canvasOptions()}`);
  return runPicker(canvasPicker(), '画幅', stdout);
}

export interface Picker<T> {
  title: string;
  choices: T[];
  label: (choice: T) => string;
}

/** 选择框的画面，与 Go 版 choicePicker.View 逐字一致。 */
export function pickerView<T>(picker: Picker<T>, cursor: number): string {
  let b = picker.title + '\n\n';
  picker.choices.forEach((choice, i) => {
    b += (i === cursor ? '❯ ' : '  ') + picker.label(choice) + '\n';
  });
  return b + '\n↑/↓ 移动　Enter 确认　Esc 取消\n';
}

export interface PickerState {
  cursor: number;
  confirmed: boolean;
  aborted: boolean;
}

/** 选择框的按键：方向键、回车、取消键，或一个可打印字符。 */
export type PickerKey = 'up' | 'down' | 'enter' | 'ctrl-c' | 'esc' | { rune: string };

/** 按键状态机，对应 Go 版 choicePicker.Update：↑↓ / k j 移动并夹在两端，Enter 确认，Esc / Ctrl-C / q 取消。 */
export function pickerUpdate(state: PickerState, count: number, key: PickerKey): PickerState {
  const up = () => ({ ...state, cursor: Math.max(0, state.cursor - 1) });
  const down = () => ({ ...state, cursor: Math.min(count - 1, state.cursor + 1) });
  if (key === 'up') return up();
  if (key === 'down') return down();
  if (key === 'enter') return { ...state, confirmed: true };
  if (key === 'ctrl-c' || key === 'esc') return { ...state, aborted: true };
  if (key.rune === 'k') return up();
  if (key.rune === 'j') return down();
  if (key.rune === 'q') return { ...state, aborted: true };
  return state;
}

function decodeKey(chunk: string): PickerKey {
  if (chunk === '\x1b[A') return 'up';
  if (chunk === '\x1b[B') return 'down';
  if (chunk === '\r' || chunk === '\n') return 'enter';
  if (chunk === '\x03') return 'ctrl-c';
  if (chunk === '\x1b') return 'esc';
  return { rune: chunk };
}

/** 运行选择框并返回选中项；name 用于错误信息。 */
export function runPicker<T>(picker: Picker<T>, name: string, stdout: Out): Promise<T> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let state: PickerState = { cursor: 0, confirmed: false, aborted: false };
    let lines = 0;
    const draw = () => {
      if (lines) stdout.write(`\x1b[${lines}F\x1b[J`);
      const view = pickerView(picker, state.cursor);
      stdout.write(view);
      lines = view.split('\n').length - 1;
    };
    const finish = () => {
      stdin.off('data', onData);
      try {
        stdin.setRawMode?.(false);
      } catch {
        // 不是终端时 setRawMode 不可用。
      }
      stdin.pause();
      if (state.aborted || !state.confirmed) reject(new Error('已取消初始化'));
      else resolve(picker.choices[state.cursor]);
    };
    const onData = (chunk: Buffer) => {
      state = pickerUpdate(state, picker.choices.length, decodeKey(chunk.toString('utf8')));
      if (state.confirmed || state.aborted) finish();
      else draw();
    };
    try {
      stdin.setRawMode?.(true);
    } catch (err) {
      reject(new Error(`${name}选择框启动失败：${(err as Error).message}`));
      return;
    }
    stdin.resume();
    stdin.on('data', onData);
    draw();
  });
}

/** init 的风格选择框：自定义风格排第一。 */
export function stylePicker(): Picker<preset.Style> {
  return { title: '选择风格', choices: [preset.CustomStyle, ...preset.allStyles()], label: (s) => s.label };
}

/** init 的画幅选择框。 */
export function canvasPicker(): Picker<preset.Preset> {
  return { title: '选择画幅', choices: preset.all(), label: (p) => p.label };
}

// ---------------------------------------------------------------- style（移植自 style.go）

/** 旧版自定义风格描述的位置，供存量项目读取。 */
export const styleBriefPath = preset.CustomStyleBriefPath;

/** 描述会原样进入编排提示词，过长的粘贴多半是贴错了文件。 */
export const maxStyleBriefRunes = 4000;

/** 供错误信息与帮助文字共用的可读清单。自定义风格排在第一项：内置风格只作为旧版参数保留。 */
export function styleOptions(): string {
  const lines = [`  ${padRight(preset.CustomStyleFlag, 32)}${preset.CustomStyle.label}`];
  for (const s of preset.allStyles()) lines.push(`  ${padRight(s.id, 32)}${s.label}`);
  return lines.join('\n');
}

/** 决定本次 init 使用哪套风格。风格参数只为兼容旧版初始化流程；渲染提示词不会把它当作视觉要求。 */
export function resolveStyle(flag: string): preset.Style {
  if (flag === '' || flag === preset.CustomStyleFlag) return preset.CustomStyle;
  const s = preset.styleByID(flag);
  if (!s) throw new Error(`未知风格 ${JSON.stringify(flag)}，可选：\n${styleOptions()}`);
  return s;
}

export const defaultStyleBrief = preset.AutomaticStyleBrief;

/**
 * 取得自定义风格的文字描述；内置风格不接受描述。内置风格带描述直接报错而不是忽略：
 * 用户以为描述生效了，成片却还是原样的内置风格，这比一条报错更难发现。
 */
export function resolveStyleBrief(style: preset.Style, flag: string, file: string): string {
  if (style.id !== preset.CustomStyle.id) {
    if (flag !== '' || file !== '') throw new Error(`--style-brief / --style-brief-file 只能与 --style ${preset.CustomStyleFlag} 一起使用`);
    return '';
  }
  let raw: string;
  if (flag !== '' && file !== '') throw new Error('--style-brief 与 --style-brief-file 只能二选一');
  else if (flag !== '') raw = flag;
  else if (file !== '') {
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`读取风格描述文件失败：${goPathError('open', file, err)}`);
    }
  } else return defaultStyleBrief;
  const brief = raw.trim();
  if (brief === '') throw new Error('风格描述不能为空');
  const n = [...brief].length;
  if (n > maxStyleBriefRunes) throw new Error(`风格描述过长（${n} 字，上限 ${maxStyleBriefRunes}）`);
  return brief;
}

/** 写进项目的描述文件内容。 */
export function styleBriefDocument(brief: string): string {
  return (
    '# 旧版风格描述（兼容文件）\n\n' +
    '> 由旧版 `am init` 写入，仅供存量项目参考。新镜头的配色、字体、版式、材质与动效由镜头自行决定；改动本文件不会形成渲染要求。\n\n' +
    brief +
    '\n'
  );
}
