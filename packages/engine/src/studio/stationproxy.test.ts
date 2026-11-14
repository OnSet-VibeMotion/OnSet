import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recordInstalled } from '../flow/installed';
import { runUserOp } from './tasks';
import { startStudio, tempDir } from './testsupport';
import { gitProxy, stationDownloadEnv } from './stationproxy';

describe('station download proxy', () => {
  it('uses the first system/PAC route, including remote DNS for SOCKS5', () => {
    expect(gitProxy('PROXY 127.0.0.1:7897; DIRECT')).toBe('http://127.0.0.1:7897');
    expect(gitProxy('HTTPS proxy.example:8443')).toBe('https://proxy.example:8443');
    expect(gitProxy('PROXY proxy.example:80')).toBe('http://proxy.example:80');
    expect(gitProxy('SOCKS5 [::1]:1080')).toBe('socks5h://[::1]:1080');
    expect(gitProxy('SOCKS proxy.example:1080')).toBe('socks4://proxy.example:1080');
    for (const route of ['DIRECT; PROXY proxy.example:8080', '', 'PROXY invalid', 'PROXY user:password@proxy.example:8080', 'PROXY proxy.example:8080/path']) expect(gitProxy(route)).toBe('');
  });

  it('resolves the plugin URL and only sets the worker proxy environment', async () => {
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:7897');
    const env = { PATH: '/tools', NO_PROXY: 'localhost' };
    expect(await stationDownloadEnv('github:someone/plugin#v1', env, resolve)).toEqual({ https_proxy: 'http://127.0.0.1:7897' });
    expect(resolve).toHaveBeenCalledWith('https://github.com/someone/plugin.git');
    expect(env).toEqual({ PATH: '/tools', NO_PROXY: 'localhost' });
  });

  it('keeps explicit proxies and does not resolve local sources or non-download operations', async () => {
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:7897');
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'ALL_PROXY']) {
      expect(await stationDownloadEnv('github:someone/plugin', { [key]: 'http://explicit:8080' }, resolve)).toEqual({});
    }
    for (const source of ['', `link:${process.cwd()}`, 'file:///repo', 'git@example.com:owner/repo']) expect(await stationDownloadEnv(source, {}, resolve)).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
    expect(await stationDownloadEnv('github:someone/plugin', {})).toEqual({});
    expect(await stationDownloadEnv('github:someone/plugin', {}, async () => 'DIRECT')).toEqual({});
  });

  it('hands the resolved proxy to add/update workers, leaving other workers unchanged', async () => {
    for (const key of Object.keys(process.env).filter(key => /^(https?|all)_proxy$/i.test(key))) vi.stubEnv(key, '');
    const root = tempDir();
    const worker = path.join(root, 'worker.cjs');
    fs.writeFileSync(worker, `process.stdout.write('\\u0000am-result '+JSON.stringify({ok:true,exit_code:0,data:{proxy:process.env.https_proxy||''}})+'\\n');`);
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:7897');
    const s = startStudio({ executable: worker, stationProxy: resolve, configPath: path.join(root, 'projects.json') });
    try {
      const run = (name: string, params: Record<string, unknown>) => runUserOp(s, new AbortController().signal, name, params);
      expect((await run('station_add', { source: 'github:someone/plugin' })).data).toEqual({ proxy: 'http://127.0.0.1:7897' });
      recordInstalled(process.env.ONSET_STATIONS_DIR!, { id: 'some-plugin', source: 'github:someone/plugin#main', version: '1', commit: 'abc', digest: '', role: { flow: false, replaces: '', after: '', nodes: false } });
      expect((await run('station_update', { id: 'some-plugin' })).data).toEqual({ proxy: 'http://127.0.0.1:7897' });
      expect((await run('station_remove', { id: 'some-plugin' })).data).toEqual({ proxy: '' });
      expect((await run('station_add', { source: `link:${root}` })).data).toEqual({ proxy: '' });
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      s.shutdown();
      vi.unstubAllEnvs();
    }
  });
});
