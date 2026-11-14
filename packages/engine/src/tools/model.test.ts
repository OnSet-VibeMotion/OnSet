import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredModel, detectModel } from './index';

const testdata = path.join(import.meta.dirname, '..', 'agentrun', 'testdata');

describe('model', () => {
  // 用真实录制的流核对模型名的读取位置。
  it('detect model from recorded streams', () => {
    const cases: Record<string, string> = { claude: 'claude-opus-5-5', qoder: 'DeepSeek-Flash', codebuddy: 'hy3', codex: '', opencode: '' };
    for (const [tool, want] of Object.entries(cases)) {
      let got = '';
      for (const line of fs.readFileSync(path.join(testdata, tool + '-1.jsonl'), 'utf8').split('\n')) {
        const model = detectModel(tool, line);
        if (model !== '' && got === '') got = model;
      }
      expect(got, tool).toBe(want);
    }
  });

  it('configured model reads codex top level only', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-tools-'));
    fs.writeFileSync(path.join(home, 'config.toml'), '# 注释\nmodel = "gpt-6-astra"  # 默认\nmodel_reasoning_effort = "medium"\n[profiles.fast]\nmodel = "other"\n');
    expect(configuredModel('codex', { CODEX_HOME: home })).toBe('gpt-6-astra');
    fs.writeFileSync(path.join(home, 'config.toml'), '[profiles.fast]\nmodel = "other"\n');
    // 表里的 model 不是默认模型。
    expect(configuredModel('codex', { CODEX_HOME: home })).toBe('');
    // 只有 codex 读配置。
    expect(configuredModel('claude', { HOME: home })).toBe('');
  });
});
