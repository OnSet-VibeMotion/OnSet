import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';
import { describe, expect, it } from 'vitest';
import * as preset from '@onset/engine/preset';
import {
  canvasPicker,
  isTerminal,
  pickerUpdate,
  pickerView,
  resolveCanvas,
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
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-cli-')), 'stdin');
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
