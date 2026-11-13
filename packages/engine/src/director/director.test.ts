import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authFile, configuredProviders, defaultDir, pickModel, providerOf, Providers, setProviderKey } from './index';

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

  it('picks the written model, else the first configured provider’s default', () => {
    expect(pickModel('a/b', [])).toBe('a/b');
    expect(pickModel('', ['moonshotai-cn', 'deepseek'])).toBe(Providers.find((p) => p.id === 'deepseek')!.defaultModel);
    expect(pickModel('', [])).toBe('');
    expect(providerOf('openrouter/anthropic/x')).toBe('openrouter');
    for (const p of Providers) expect(p.defaultModel === '' || providerOf(p.defaultModel) === p.id, p.id).toBe(true);
  });
});
