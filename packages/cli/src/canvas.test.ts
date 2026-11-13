import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';
import { describe, expect, it } from 'vitest';
import * as preset from '@am/engine/preset';
import {
  canvasPicker,
  isTerminal,
  maxStyleBriefRunes,
  pickerUpdate,
  pickerView,
  resolveCanvas,
  resolveStyle,
  resolveStyleBrief,
  stylePicker,
  type PickerKey,
} from './canvas';

const sink = { write: () => {} };
const start = { cursor: 0, confirmed: false, aborted: false };
const count = preset.all().length;

describe('canvas', () => {
  it('accepts a known id', async () => {
    expect((await resolveCanvas('vertical-9x16', undefined, sink)).canvas.heightPx).toBe(1920);
  });

  it('rejects an unknown id and lists every preset', async () => {
    const err = await resolveCanvas('square-1x1', undefined, sink).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    for (const id of preset.ids()) expect((err as Error).message).toContain(id);
  });

  // /dev/null 是字符设备但不是终端：误认成交互会掉进读不到按键的选择框。
  it('rejects /dev/null, regular files and undefined as terminals', () => {
    const fd = fs.openSync(os.devNull, 'r');
    expect(isTerminal({ isTTY: tty.isatty(fd) })).toBe(false);
    fs.closeSync(fd);
    expect(isTerminal(undefined)).toBe(false);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-cli-')), 'stdin');
    fs.writeFileSync(file, '');
    expect(isTerminal({ isTTY: false })).toBe(false);
  });

  // 非交互且未传 --canvas 时，错误必须点名 --canvas。
  it('fails closed without a terminal', async () => {
    await expect(resolveCanvas('', { isTTY: false }, sink)).rejects.toThrow('非交互环境');
  });

  it('starts on the default preset', () => {
    expect(canvasPicker().choices[start.cursor].id).toBe(preset.defaultPreset().id);
  });

  it('moves and selects', () => {
    let m = pickerUpdate(start, count, 'down');
    expect(m.cursor).toBe(1);
    m = pickerUpdate(m, count, 'enter');
    expect(m.confirmed).toBe(true);
    expect(canvasPicker().choices[m.cursor].id).toBe('vertical-9x16');
  });

  it('supports vim keys', () => {
    const m = pickerUpdate(start, count, { rune: 'j' });
    expect(m.cursor).toBe(1);
    expect(pickerUpdate(m, count, { rune: 'k' }).cursor).toBe(0);
  });

  it('clamps at the boundaries', () => {
    expect(pickerUpdate(start, count, 'up').cursor).toBe(0);
    expect(pickerUpdate({ ...start, cursor: count - 1 }, count, 'down').cursor).toBe(count - 1);
  });

  // Ctrl+C / Esc / q 必须走取消路径，不能被当成选中默认值。
  it('aborts', () => {
    for (const key of ['ctrl-c', 'esc', { rune: 'q' }] as PickerKey[]) {
      const m = pickerUpdate(start, count, key);
      expect(m.aborted && !m.confirmed).toBe(true);
    }
  });

  it('marks the cursor and lists every preset', () => {
    const view = pickerView(canvasPicker(), 1);
    for (const p of preset.all()) expect(view).toContain(p.label);
    expect(view).toContain('❯ ' + preset.all()[1].label);
  });
});

describe('style', () => {
  it('accepts a known id', () => {
    expect(resolveStyle(preset.allStyles()[1].id).id).toBe(preset.allStyles()[1].id);
  });

  it('rejects an unknown id and lists the choices', () => {
    expect(() => resolveStyle('no-such-style')).toThrow(preset.defaultStyle().id);
  });

  it('defaults to the custom draft without --style', () => {
    expect(resolveStyle('').id).toBe(preset.CustomStyle.id);
  });

  it('accepts the custom flag', () => {
    expect(resolveStyle(preset.CustomStyleFlag).id).toBe(preset.CustomStyle.id);
  });

  it('offers custom first in the picker', () => {
    expect(stylePicker().choices[0].id).toBe(preset.CustomStyle.id);
  });

  it('resolves the style brief', () => {
    const builtin = preset.defaultStyle();
    expect(() => resolveStyleBrief(builtin, 'x', '')).toThrow('只能与 --style custom 一起使用');
    expect(resolveStyleBrief(builtin, '', '')).toBe('');
    expect(() => resolveStyleBrief(preset.CustomStyle, 'a', 'b')).toThrow('只能二选一');
    expect(resolveStyleBrief(preset.CustomStyle, '  暖色胶片  ', '')).toBe('暖色胶片');
    expect(() => resolveStyleBrief(preset.CustomStyle, '   ', '')).toThrow('风格描述不能为空');
    expect(() => resolveStyleBrief(preset.CustomStyle, '字'.repeat(maxStyleBriefRunes + 1), '')).toThrow('风格描述过长');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-cli-')), 'brief.md');
    fs.writeFileSync(file, '文件里的描述\n');
    expect(resolveStyleBrief(preset.CustomStyle, '', file)).toBe('文件里的描述');
    expect(() => resolveStyleBrief(preset.CustomStyle, '', file + '.missing')).toThrow('no such file or directory');
    expect(resolveStyleBrief(preset.CustomStyle, '', '')).toBe(preset.AutomaticStyleBrief);
  });
});
