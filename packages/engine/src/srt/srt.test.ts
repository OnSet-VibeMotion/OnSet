import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCues, readSpan } from './index';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-srt-'));

function write(body: string): string {
  const file = path.join(temp(), 'transcription.srt');
  fs.writeFileSync(file, body);
  return file;
}

describe('readSpan', () => {
  it('covers first start to last end', () => {
    const span = readSpan(
      write(`1
00:00:01,500 --> 00:00:04,333
第一句

2
00:00:04,333 --> 00:00:09,000
第二句
`),
    );
    expect(span.cues).toBe(2);
    expect(Math.abs(span.startSeconds - 1.5)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(span.endSeconds - 9.0)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(span.seconds() - 7.5)).toBeLessThanOrEqual(1e-9);
  });

  // 条目乱序时按出现顺序取首尾会得到偏小甚至为负的跨度。取最小开始与最大结束才是对的。
  it('uses min/max, not file order', () => {
    const span = readSpan(
      write(`1
00:00:10,000 --> 00:00:12,000
后面的句子写在了前面

2
00:00:01,000 --> 00:00:03,000
前面的句子写在了后面
`),
    );
    expect(Math.abs(span.seconds() - 11.0)).toBeLessThanOrEqual(1e-9);
  });

  it('accepts dot as millisecond separator', () => {
    const span = readSpan(write('1\n00:00:00.000 --> 00:00:02.500\n从 VTT 转过来的\n'));
    expect(Math.abs(span.seconds() - 2.5)).toBeLessThanOrEqual(1e-9);
  });

  // ",5" 是 500 毫秒，不是 5 毫秒。左补零会把跨度算错两个数量级。
  it('pads short milliseconds on the right', () => {
    const span = readSpan(write('1\n00:00:00,0 --> 00:00:01,5\n短毫秒\n'));
    expect(Math.abs(span.seconds() - 1.5)).toBeLessThanOrEqual(1e-9);
  });

  it('handles hours and long files', () => {
    const span = readSpan(write('1\n01:02:03,004 --> 01:02:04,000\n一小时后\n'));
    expect(Math.abs(span.startSeconds - 3723.004)).toBeLessThanOrEqual(1e-6);
  });

  describe('rejects bad input', () => {
    const cases: Record<string, string> = {
      没有时间码: '1\n就是一段文字\n',
      空文件: '',
      跨度为零: '1\n00:00:02,000 --> 00:00:02,000\n零长度\n',
      分钟超出范围: '1\n00:99:00,000 --> 00:99:01,000\n非法\n',
    };
    for (const [name, body] of Object.entries(cases)) {
      it(name, () => {
        expect(() => readSpan(write(body))).toThrow();
      });
    }
    it('missing file', () => {
      expect(() => readSpan(path.join(temp(), '缺失.srt'))).toThrow(/^无法读取字幕：open .*: no such file or directory$/);
    });
  });

  // 序号、文本和空行都不该干扰解析，文本里出现的类时间码字样也不该被当成时间码。
  it('ignores non-timecode lines', () => {
    const span = readSpan(
      write(`1
00:00:00,000 --> 00:00:05,000
这句台词里提到了 00:10:00,000 --> 00:20:00,000 这样的写法

2
00:00:05,000 --> 00:00:06,000
结束
`),
    );
    expect(Math.abs(span.seconds() - 6.0)).toBeLessThanOrEqual(1e-9);
  });
});

describe('readCues', () => {
  it('parses text and keeps file order', () => {
    const file = path.join(temp(), 'voice.srt');
    fs.writeFileSync(file, '﻿7\n00:00:00,500 --> 00:00:02,000\n第一行\n第二行\n\n3\n00:00:02.3 --> 00:00:04,100\nsecond\n');
    const cues = readCues(file);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ index: 1, start_seconds: 0.5, end_seconds: 2, text: '第一行\n第二行' });
    // 序号按出现顺序，毫秒右补零。
    expect(cues[1].index).toBe(2);
    expect(cues[1].start_seconds).toBe(2.3);
    expect(cues[1].text).toBe('second');
  });

  it('rejects bad input', () => {
    const dir = temp();
    for (const [name, body] of Object.entries({
      'empty.srt': 'no timecodes here\n',
      'reverse.srt': '1\n00:00:02,000 --> 00:00:01,000\nx\n',
      'badclock.srt': '1\n00:61:00,000 --> 00:62:00,000\nx\n',
    })) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      expect(() => readCues(file), name).toThrow();
    }
    expect(() => readCues(path.join(dir, 'missing.srt'))).toThrow();
  });

  it('keeps zero-length cues', () => {
    const file = path.join(temp(), 'align.srt');
    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:01,000\n，\n');
    const cues = readCues(file);
    expect(cues).toHaveLength(1);
    expect(cues[0].start_seconds).toBe(cues[0].end_seconds);
  });
});
