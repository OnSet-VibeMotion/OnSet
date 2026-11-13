import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureFFmpeg, ensureTool, ensureUV, ffmpegStatus, mirrored, pipIndexURL, sha256File, uvStatus } from './index';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-toolinstall-'));
}

describe('toolinstall', () => {
  it('rewrites only GitHub URLs to the mirror', () => {
    const env = { AM_GITHUB_MIRROR: 'https://ghfast.top/https://github.com' };
    expect(mirrored('https://github.com/a/b/releases/download/x/y.gz', env)).toBe('https://ghfast.top/https://github.com/a/b/releases/download/x/y.gz');
    expect(mirrored('https://example.com/y.gz', env)).toBe('https://example.com/y.gz');
    expect(mirrored('https://github.com/a/b', {})).toBe('https://github.com/a/b');
  });

  it('counts tools in am\'s own bin directory as installed, without PATH', () => {
    const home = tempDir();
    const bin = path.join(home, '.local', 'share', 'am', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const env = { HOME: home, PATH: '/nonexistent' };
    expect(ffmpegStatus(env)).toEqual({ ok: false, where: bin });
    for (const name of ['ffmpeg', 'ffprobe', 'uv']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
    expect(ffmpegStatus(env)).toEqual({ ok: true, where: path.join(bin, 'ffmpeg') });
    expect(uvStatus(env)).toEqual({ ok: true, where: path.join(bin, 'uv') });
  });

  it('takes the Python package index from pip.conf so uv uses the same mirror', () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, '.pip'));
    fs.writeFileSync(path.join(home, '.pip', 'pip.conf'), '[global]\nindex-url = https://mirrors.aliyun.com/pypi/simple/\n');
    expect(pipIndexURL({ HOME: home })).toBe('https://mirrors.aliyun.com/pypi/simple/');
    expect(pipIndexURL({ HOME: home, PIP_INDEX_URL: 'https://x/simple' })).toBe('https://x/simple');
    expect(pipIndexURL({ HOME: tempDir() })).toBe('');
  });

  it('does nothing when the tools are already on PATH', async () => {
    const dir = tempDir();
    for (const name of ['ffmpeg', 'ffprobe']) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
    await expect(ensureFFmpeg({ env: { HOME: tempDir(), PATH: dir } })).resolves.toBe(path.join(dir, 'ffmpeg'));
  });
});

// 真实下载：联网，CI 不跑。改了下载表或安装方式后在本机跑一遍：
//   AM_TEST_TOOL_DOWNLOAD=1 npx vitest run --root packages/engine src/toolinstall -t RealToolDownload
describe.runIf(process.env.AM_TEST_TOOL_DOWNLOAD === '1' && process.platform === 'darwin')('RealToolDownload', () => {
  it('downloads ffmpeg, ffprobe and uv that run', async () => {
    const env = { HOME: tempDir(), PATH: '/usr/bin:/bin', ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}) };
    const ffmpeg = await ensureFFmpeg({ env });
    expect(spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout).toContain('libx264');
    expect(spawnSync(path.join(path.dirname(ffmpeg), 'ffprobe'), ['-version'], { encoding: 'utf8' }).status).toBe(0);
    const uv = await ensureUV({ env });
    expect(spawnSync(uv, ['--version'], { encoding: 'utf8' }).stdout).toMatch(/^uv 0\./);
  }, 900_000);
});

// 真实安装配音工具：联网，CI 不跑。AM_TEST_NPM_CLI 指向一份 npm 的 npm-cli.js（模拟客户端自带的 npm）。
//   AM_TEST_TOOL_DOWNLOAD=1 AM_TEST_NPM_CLI=… npx vitest run --root packages/engine src/toolinstall -t RealVoiceTools
describe.runIf(process.env.AM_TEST_TOOL_DOWNLOAD === '1' && Boolean(process.env.AM_TEST_NPM_CLI))('RealVoiceTools', () => {
  it('installs an npm tool and a Python tool without Node or Python on PATH', async () => {
    const env = { HOME: tempDir(), PATH: '/usr/bin:/bin', AM_NPM_CLI: process.env.AM_TEST_NPM_CLI!, ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}) };
    const mmx = await ensureTool({ kind: 'npm', package: 'mmx-cli', version: '1.0.28', bins: ['mmx'] }, { env });
    expect(spawnSync(mmx, ['--version'], { encoding: 'utf8', env }).status).toBe(0);
    const edge = await ensureTool({ kind: 'uv-tool', package: 'edge-tts', version: '7.3.1', bins: ['edge-tts'] }, { env });
    expect(spawnSync(edge, ['--help'], { encoding: 'utf8', env }).status).toBe(0);
  }, 900_000);
});

describe('sha256File', () => {
  it('hashes by streaming, so files over 2 GiB (Breeze TTS 2 weights) do not hit the Buffer limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-sha-'));
    const file = path.join(dir, 'big.bin');
    // 稀疏文件：不占磁盘，readFileSync 会因超过 2 GiB 直接抛错。
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 2 ** 31 + 1);
    expect(() => fs.readFileSync(file)).toThrow(/2 GiB/);
    const small = path.join(dir, 'small.txt');
    fs.writeFileSync(small, 'abc');
    expect(await sha256File(small)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
