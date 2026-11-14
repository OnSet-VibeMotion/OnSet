import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeServiceInfo,
  defaultDir,
  deleteService,
  effectiveModel,
  hasService,
  keyStorage,
  listServiceModels,
  listServices,
  normalizeBaseURL,
  parseResolvedService,
  Presets,
  resolveService,
  saveService,
  servicesFile,
  setActiveService,
  useKeyCodec,
  useService,
  type KeyCodec,
} from './index';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-director-'));
});
afterEach(() => {
  useKeyCodec(null);
  useService(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 假的 safeStorage：反转再 base64，够证明文件里没有明文。 */
function fakeCodec(available = true): KeyCodec {
  return {
    available: () => available,
    encrypt: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64'),
    decrypt: (cipher: string) => [...Buffer.from(cipher, 'base64').toString('utf8')].reverse().join(''),
  };
}

const deepseek = { name: '', preset: 'deepseek', protocol: 'openai', base_url: 'https://api.deepseek.com/', model: 'deepseek-v4-pro', vision: false };

describe('director services', () => {
  it('lives in the user data dir, overridable by ONSET_AGENT_DIR', () => {
    expect(defaultDir({ HOME: '/h' })).toBe(path.join('/h', '.local', 'share', 'onset', 'agent'));
    expect(defaultDir({ HOME: '/h', ONSET_AGENT_DIR: '/x' })).toBe('/x');
    expect(defaultDir({})).toBe('');
  });

  it('saves services owner-only, makes the first one active and never lists keys back', () => {
    const agent = path.join(dir, 'agent');
    expect(hasService(agent)).toBe(false);
    const a = saveService(agent, { ...deepseek, key: ' sk-1 ' });
    const b = saveService(agent, { name: '本机', protocol: 'openai', base_url: 'http://localhost:11434/v1', model: 'qwen3', vision: true });
    const listed = listServices(agent);
    expect(listed.active).toBe(a);
    expect(listed.services.map((s) => [s.name, s.base_url, s.has_key, s.preset])).toEqual([
      ['DeepSeek', 'https://api.deepseek.com', true, 'deepseek'],
      ['本机', 'http://localhost:11434/v1', false, ''],
    ]);
    expect(JSON.stringify(listed)).not.toContain('sk-1');
    if (process.platform !== 'win32') expect(fs.statSync(servicesFile(agent)).mode & 0o777).toBe(0o600);

    // 改的时候不填 key：保留原来的。
    saveService(agent, { ...deepseek, id: a, model: 'deepseek-v4-flash' });
    expect(resolveService(agent)).toMatchObject({ id: a, model: 'deepseek-v4-flash', key: 'sk-1', vision: false });
    setActiveService(agent, b);
    expect(activeServiceInfo(agent)?.name).toBe('本机');
    expect(resolveService(agent)).toMatchObject({ id: b, key: '' });
    // 删掉在用的那套：改用剩下的。
    deleteService(agent, b);
    expect(listServices(agent).active).toBe(a);
    deleteService(agent, a);
    expect(hasService(agent)).toBe(false);
    expect(resolveService(agent)).toBeNull();
  });

  it('rejects malformed input', () => {
    const agent = path.join(dir, 'agent');
    expect(() => saveService(agent, { ...deepseek, base_url: 'ftp://x' })).toThrow(/http/);
    expect(() => saveService(agent, { ...deepseek, base_url: 'not a url' })).toThrow(/网址/);
    expect(() => saveService(agent, { ...deepseek, protocol: 'gemini' })).toThrow(/协议/);
    expect(() => saveService(agent, { ...deepseek, model: '' })).toThrow(/模型名/);
    expect(() => saveService(agent, { ...deepseek, key: 'a b' })).toThrow(/空白/);
    expect(() => saveService(agent, { ...deepseek, id: 's-nope' })).toThrow(/没有这套/);
    expect(() => setActiveService(agent, 's-nope')).toThrow(/没有这套/);
    expect(normalizeBaseURL(' https://x.com/v1// ')).toBe('https://x.com/v1');
  });

  it('falls back to an owner-only plaintext file without a codec', () => {
    const agent = path.join(dir, 'agent');
    saveService(agent, { ...deepseek, key: 'sk-plain' });
    expect(fs.readFileSync(servicesFile(agent), 'utf8')).toContain('"key": "sk-plain"');
    expect(keyStorage().encrypted).toBe(false);
    expect(keyStorage().note).toMatch(/明文/);
    useKeyCodec(fakeCodec(false));
    expect(keyStorage().note).toMatch(/钥匙串/);
  });

  it('encrypts keys on disk with the injected codec and decrypts them for the Director', () => {
    const agent = path.join(dir, 'agent');
    // 先有一项明文（注入 codec 之前写的），注入后再写一项：两项都加密落盘。
    const old = saveService(agent, { ...deepseek, key: 'sk-old' });
    useKeyCodec(fakeCodec());
    expect(keyStorage()).toEqual({ encrypted: true });
    const kimi = saveService(agent, { name: 'Kimi', protocol: 'openai', base_url: 'https://api.moonshot.cn/v1', model: 'kimi-k3', vision: true, key: 'sk-secret' });
    const text = fs.readFileSync(servicesFile(agent), 'utf8');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('sk-old');
    expect(resolveService(agent)?.key).toBe('sk-old');
    expect(resolveService(agent, kimi)?.key).toBe('sk-secret');
    expect(listServices(agent).services.every((s) => s.has_key)).toBe(true);
    // 没有 codec 的进程（终端里的 onset run）解不开：当作没有服务，不把密文当 key。
    useKeyCodec(null);
    expect(resolveService(agent, old)).toBeNull();
  });

  it('uses the service handed down by the parent instead of the file', () => {
    const agent = path.join(dir, 'agent');
    saveService(agent, { ...deepseek, key: 'sk-file' });
    const handed = parseResolvedService({ id: 'x', name: 'h', protocol: 'anthropic', base_url: 'https://a', model: 'm', vision: true, key: 'sk-handed' });
    expect(parseResolvedService({ base_url: '' })).toBeNull();
    useService(handed);
    expect(resolveService(agent)).toMatchObject({ protocol: 'anthropic', key: 'sk-handed' });
    useService(null);
    expect(resolveService(agent)?.key).toBe('sk-file');
  });

  it('takes the model override over the service model', () => {
    expect(effectiveModel('', { model: 'a' })).toBe('a');
    expect(effectiveModel(' b ', { model: 'a' })).toBe('b');
    expect(effectiveModel('', null)).toBe('');
  });

  it('presets are complete and unique', () => {
    expect(new Set(Presets.map((p) => p.id)).size).toBe(Presets.length);
    for (const p of Presets) {
      expect(normalizeBaseURL(p.baseURL), p.id).toBe(p.baseURL);
      expect(p.model, p.id).not.toBe('');
      expect(p.keyURL, p.id).toMatch(/^https:\/\//);
    }
  });

  it('lists models from the service in both protocols', async () => {
    const seen: Record<string, string | undefined>[] = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'] as string | undefined });
      if (req.url === '/v1/models' || req.url === '/x/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect(await listServiceModels({ protocol: 'openai', base_url: base + '/x', key: 'k1' })).toEqual(['a', 'b']);
      expect(await listServiceModels({ protocol: 'anthropic', base_url: base, key: 'k2' })).toEqual(['a', 'b']);
      await expect(listServiceModels({ protocol: 'openai', base_url: base + '/nope', key: '' })).rejects.toThrow(/404/);
      expect(seen.slice(0, 2)).toEqual([
        { url: '/x/models', auth: 'Bearer k1', xkey: undefined },
        { url: '/v1/models', auth: undefined, xkey: 'k2' },
      ]);
    } finally {
      server.close();
    }
  });
});
