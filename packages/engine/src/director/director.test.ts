import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authFile, configuredProviders, defaultDir, keyStorage, loadKeys, pickModel, providerOf, Providers, setProviderKey, useKeyCodec, useKeys, type KeyCodec } from './index';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-director-'));
});
afterEach(() => {
  useKeyCodec(null);
  useKeys(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 假的 safeStorage：反转再 base64，够证明文件里没有明文。 */
function fakeCodec(available = true): KeyCodec & { calls: number } {
  const c = {
    calls: 0,
    available: () => available,
    encrypt: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64'),
    decrypt: (cipher: string) => {
      c.calls++;
      return [...Buffer.from(cipher, 'base64').toString('utf8')].reverse().join('');
    },
  };
  return c;
}

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

  it('falls back to an owner-only plaintext file without a codec', () => {
    const agent = path.join(dir, 'agent');
    setProviderKey(agent, 'deepseek', 'sk-plain');
    expect(loadKeys(agent)).toEqual({ deepseek: 'sk-plain' });
    expect(keyStorage().encrypted).toBe(false);
    expect(keyStorage().note).toMatch(/明文/);
  });

  it('encrypts keys on disk with the injected codec and decrypts them for the Director', () => {
    const agent = path.join(dir, 'agent');
    // 先有一项明文（注入 codec 之前写的），注入后再写一项：两项都加密落盘。
    setProviderKey(agent, 'moonshotai-cn', 'sk-old');
    const codec = fakeCodec();
    useKeyCodec(codec);
    expect(keyStorage()).toEqual({ encrypted: true });
    setProviderKey(agent, 'deepseek', 'sk-secret');
    const text = fs.readFileSync(authFile(agent), 'utf8');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('sk-old');
    expect(JSON.parse(text).deepseek).toEqual({ type: 'api_key', enc: codec.encrypt('sk-secret') });
    if (process.platform !== 'win32') expect(fs.statSync(authFile(agent)).mode & 0o777).toBe(0o600);
    expect(configuredProviders(agent)).toEqual(['deepseek', 'moonshotai-cn']);
    expect(loadKeys(agent)).toEqual({ deepseek: 'sk-secret', 'moonshotai-cn': 'sk-old' });
    // 没有 codec 的进程（终端里的 am run）解不开：当作没填，不把密文当 key。
    useKeyCodec(null);
    expect(loadKeys(agent)).toEqual({});
    expect(configuredProviders(agent)).toEqual(['deepseek', 'moonshotai-cn']);
  });

  it('stores plaintext and says so when the codec is unavailable', () => {
    const agent = path.join(dir, 'agent');
    useKeyCodec(fakeCodec(false));
    setProviderKey(agent, 'deepseek', 'sk-1');
    expect(JSON.parse(fs.readFileSync(authFile(agent), 'utf8')).deepseek).toEqual({ type: 'api_key', key: 'sk-1' });
    expect(keyStorage().encrypted).toBe(false);
    expect(keyStorage().note).toMatch(/钥匙串/);
  });

  it('uses keys handed down by the parent instead of the file', () => {
    const agent = path.join(dir, 'agent');
    setProviderKey(agent, 'deepseek', 'sk-file');
    useKeys({ openai: 'sk-handed' });
    expect(loadKeys(agent)).toEqual({ openai: 'sk-handed' });
    useKeys(null);
    expect(loadKeys(agent)).toEqual({ deepseek: 'sk-file' });
  });
});
