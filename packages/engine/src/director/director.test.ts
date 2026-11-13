import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authFile, configuredProviders, defaultDir, modelVision, pickModel, providerOf, Providers, setProviderKey } from './index';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-director-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('director credentials', () => {
  it('lives in the user data dir, overridable by AM_AGENT_DIR', () => {
    expect(defaultDir({ HOME: '/h' })).toBe(path.join('/h', '.local', 'share', 'am', 'agent'));
    expect(defaultDir({ HOME: '/h', AM_AGENT_DIR: '/x' })).toBe('/x');
    expect(defaultDir({})).toBe('');
  });

  it('writes keys owner-only and never lists them back', () => {
    const agent = path.join(dir, 'agent');
    setProviderKey(agent, 'deepseek', ' sk-1 ');
    setProviderKey(agent, 'moonshotai-cn', 'sk-2');
    expect(configuredProviders(agent)).toEqual(['deepseek', 'moonshotai-cn']);
    expect(JSON.parse(fs.readFileSync(authFile(agent), 'utf8')).deepseek).toEqual({ type: 'api_key', key: 'sk-1' });
    if (process.platform !== 'win32') expect(fs.statSync(authFile(agent)).mode & 0o777).toBe(0o600);
    setProviderKey(agent, 'deepseek', '');
    expect(configuredProviders(agent)).toEqual(['moonshotai-cn']);
    expect(() => setProviderKey(agent, '../x', 'k')).toThrow(/服务商/);
    expect(() => setProviderKey(agent, 'deepseek', 'a b')).toThrow(/空白/);
  });

  it('picks the written model, else a configured provider whose default can read images, else the first one', () => {
    const model = (id: string) => Providers.find((p) => p.id === id)!.defaultModel;
    expect(pickModel('a/b', [])).toBe('a/b');
    // 写了模型就用写的，哪怕它看不了图。
    expect(pickModel('deepseek/deepseek-v4-pro', ['moonshotai-cn'])).toBe('deepseek/deepseek-v4-pro');
    // DeepSeek 排第一但推荐模型看不了图：有能读图的就挑它，按 Providers 的顺序。
    expect(pickModel('', ['moonshotai-cn', 'deepseek'])).toBe(model('moonshotai-cn'));
    expect(pickModel('', ['openai', 'deepseek', 'anthropic'])).toBe(model('anthropic'));
    // 都看不了图：退回第一家。
    expect(pickModel('', ['zai-coding-cn', 'deepseek'])).toBe(model('deepseek'));
    expect(pickModel('', ['zai-coding-cn'])).toBe(model('zai-coding-cn'));
    // 不在表里的服务商不参与。
    expect(pickModel('', ['x-unknown'])).toBe('');
    expect(pickModel('', [])).toBe('');
    expect(providerOf('openrouter/anthropic/x')).toBe('openrouter');
    for (const p of Providers) expect(p.defaultModel === '' || providerOf(p.defaultModel) === p.id, p.id).toBe(true);
  });

  it('knows which models cannot read images, and nothing about the rest', () => {
    expect(modelVision('deepseek/deepseek-v4-pro')).toBe(false);
    expect(modelVision('zai-coding-cn/glm-5.3')).toBe(false);
    expect(modelVision('moonshotai-cn/kimi-k3')).toBeUndefined();
    // 目录里查不到、服务商不在表里、没写服务商：都按不知道，不提示。
    expect(modelVision('deepseek/deepseek-v9')).toBeUndefined();
    expect(modelVision('x-other/deepseek-v4-pro')).toBeUndefined();
    expect(modelVision('deepseek-v4-pro')).toBeUndefined();
    // 推荐模型的标记与表一致。
    for (const p of Providers) expect(modelVision(p.defaultModel) !== false, p.id).toBe(p.vision);
  });
});
