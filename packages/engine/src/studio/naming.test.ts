import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ledger from '../ledger';
import { cleanName, namingPrompt, recordNamingUsage, suggestName } from './naming';

describe('naming', () => {
  it('cleans the answer into a folder name', () => {
    expect(cleanName('复利的魔法')).toBe('复利的魔法');
    expect(cleanName('好的。\n\n项目名：《复利：时间的魔法》')).toBe('复利-时间的魔法');
    expect(cleanName('**AI Agent 入门**')).toBe('AI-Agent-入门');
    expect(cleanName('```\n左手/右手 经济学\n```')).toBe('左手-右手-经济学');
    expect(cleanName('一二三四五六七八九十一二三四五六七八九十多出来')).toBe('一二三四五六七八九十一二三四五六七八九十');
    expect(cleanName('。。。')).toBe('');
  });

  it('asks about the content, not the request, and carries file excerpts', () => {
    const prompt = namingPrompt({ message: '我想做一个这个内容的视频', files: [{ name: 'a.md', text: '复利是利滚利' }, { name: 'b.pdf', text: '' }] });
    expect(prompt).toContain('用户的原话：\n我想做一个这个内容的视频\n');
    expect(prompt).toContain('素材「a.md」的开头：\n复利是利滚利');
    expect(prompt).toContain('素材「b.pdf」（读不出文字，只有文件名）');
  });

  it('records the naming usage into the new project once', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-naming-test-'));
    recordNamingUsage('unknown', project);
    expect(fs.existsSync(ledger.projectFile(project))).toBe(false);
  });

  it('names with the chosen tool and books the call into the new project', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-naming-bin-'));
    const fake = path.join(bin, 'claude');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `printf '{"type":"system","subtype":"init","session_id":"s1","model":"claude-test"}\\n'`,
        `printf '{"type":"assistant","message":{"content":[{"type":"text","text":"项目名：《复利的魔法》"}]}}\\n'`,
        `printf '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":3,"output_tokens":2},"num_turns":1}\\n'`,
        '',
      ].join('\n'),
    );
    fs.chmodSync(fake, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = bin + path.delimiter + saved;
    try {
      const result = await suggestName('claude', { message: '我想做一个这个内容的视频', files: [] });
      expect(result.name).toBe('复利的魔法');
      expect(result.token).not.toBe('');
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-naming-project-'));
      recordNamingUsage(result.token, project);
      recordNamingUsage(result.token, project);
      const entries = ledger.read(ledger.projectFile(project)) ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0].tool).toBe('claude');
      expect(entries[0].status).toBe('succeeded');
    } finally {
      process.env.PATH = saved;
    }
  });

  it('returns no name when the tool is missing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-naming-path-'));
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      const result = await suggestName('claude', { message: '讲讲复利', files: [] });
      expect(result.name).toBe('');
      expect(result.error).toBeTruthy();
    } finally {
      process.env.PATH = saved;
    }
  });
});
