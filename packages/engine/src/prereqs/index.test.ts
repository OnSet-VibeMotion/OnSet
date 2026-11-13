import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BreezeTTS2, QwenForcedAligner, defaultTTSProvider } from '../config/providers';
import { check, items, selection } from './index';

describe('prereqs', () => {
  it('lists skills, the CLI, the beat environment and every film-style source, in preparation order', () => {
    const ids = items().map((item) => item.id);
    expect(ids.slice(0, 5)).toEqual(['skills', 'cli', 'browser', 'ffmpeg', 'beat']);
    expect(ids).toContain('styles:lemo-opuscar');
  });

  it('reports nothing ready in an empty home, without touching the network', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-'));
    // PATH 只留系统目录：开发机上 Homebrew 的 ffmpeg 会让 ffmpeg 一项直接就绪。
    const status = check({ HOME: home, PATH: '/usr/bin:/bin' });
    expect(status.every((s) => !s.ready)).toBe(true);
    expect(status.filter((s) => s.required).map((s) => s.id)).toEqual(['skills', 'cli', 'browser', 'ffmpeg']);
    for (const s of status) expect(s.location.startsWith(home), `${s.id}: ${s.location}`).toBe(true);
  });

  it('treats the browser bundled with the desktop client as ready', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-'));
    const browser = path.join(home, 'am-browser');
    fs.writeFileSync(browser, '#!/bin/sh\n', { mode: 0o755 });
    const status = check({ HOME: home, PATH: process.env.PATH ?? '', AM_BROWSER: browser });
    expect(status.find((s) => s.id === 'browser')).toMatchObject({ ready: true, location: browser });
  });

  it('finds a headless shell downloaded by HyperFrames', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-'));
    const platformDir = { arm64: 'chrome-headless-shell-mac-arm64', x64: 'chrome-headless-shell-mac-x64' }[process.arch as 'arm64' | 'x64'];
    if (process.platform !== 'darwin' || !platformDir) return;
    const binary = path.join(home, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell', 'mac_arm-152.0.7977.30', platformDir, 'chrome-headless-shell');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'x');
    const status = check({ HOME: home, PATH: process.env.PATH ?? '' });
    expect(status.find((s) => s.id === 'browser')).toMatchObject({ ready: true, location: binary });
  });

  it('lists the voice and alignment tools the project uses', () => {
    const ids = items({ tts: 'edge', align: 'funasr' }).map((item) => item.id);
    expect(ids).toContain('tts:edge');
    expect(ids).toContain('align:funasr');
    expect(ids.filter((id) => id.startsWith('tts:'))).toHaveLength(1);
  });

  it('picks tools from the project config, then the environment, then the defaults', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-project-'));
    fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\nTTS_PROVIDER=tencent\nALIGN_PROVIDER=funasr\n');
    expect(selection({ HOME: project }, project)).toEqual({ tts: 'tencent', align: 'funasr' });
    expect(selection({ TTS_PROVIDER: 'edge', ALIGN_PROVIDER: 'mlx' })).toEqual({ tts: 'edge', align: 'mlx' });
    expect(selection({ TTS_PROVIDER: 'nope' }).tts).toBe(defaultTTSProvider());
  });

  it('counts a voice tool installed by am in its own bin directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-'));
    const bin = path.join(home, '.local', 'share', 'am', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'mmx'), '#!/bin/sh\n', { mode: 0o755 });
    const status = check({ HOME: home, PATH: '/usr/bin:/bin' }, { tts: 'minimax', align: 'funasr' });
    expect(status.find((s) => s.id === 'tts:minimax')).toMatchObject({ ready: true, location: path.join(bin, 'mmx') });
    expect(status.find((s) => s.id === 'align:funasr')).toMatchObject({ ready: false, location: bin });
  });

  it('counts the MLX aligner as ready only once its model is downloaded too', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-'));
    const data = path.join(home, '.local', 'share', 'am');
    fs.mkdirSync(path.join(data, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(data, 'bin', 'mlx_audio.stt.generate'), '#!/bin/sh\n', { mode: 0o755 });
    const pick = { tts: 'minimax', align: 'mlx' };
    const env = { HOME: home, PATH: '/usr/bin:/bin' };
    expect(check(env, pick).find((s) => s.id === 'align:mlx')?.ready).toBe(false);
    const model = path.join(data, 'models', 'mlx-community__Qwen3-ForcedAligner-0.6B-8bit');
    fs.mkdirSync(model, { recursive: true });
    for (const f of QwenForcedAligner.files) fs.writeFileSync(path.join(model, f.path), Buffer.alloc(f.path === 'model.safetensors' ? 0 : f.size));
    // 大文件还没下完（大小不对）：仍然不算就绪。
    expect(check(env, pick).find((s) => s.id === 'align:mlx')?.ready).toBe(false);
    fs.truncateSync(path.join(model, 'model.safetensors'), QwenForcedAligner.files.find((f) => f.path === 'model.safetensors')!.size);
    expect(check(env, pick).find((s) => s.id === 'align:mlx')?.ready).toBe(true);
  });

  it('counts Breeze TTS 2 as ready only once its model is downloaded too, subdirectories included', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-'));
    const data = path.join(home, '.local', 'share', 'am');
    fs.mkdirSync(path.join(data, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(data, 'bin', 'mlx_audio.tts.generate'), '#!/bin/sh\n', { mode: 0o755 });
    const pick = { tts: 'breeze', align: 'funasr' };
    const env = { HOME: home, PATH: '/usr/bin:/bin' };
    const model = path.join(data, 'models', 'mlx-community__Breeze-TTS-2-mlx-8bit');
    expect(check(env, pick).find((s) => s.id === 'tts:breeze')).toMatchObject({ ready: false, location: model });
    // 只铺好顶层文件、缺 audio_tokenizer/ 下的编解码器：仍然不算就绪。
    for (const f of BreezeTTS2.files.filter((f) => !f.path.includes('/'))) {
      fs.mkdirSync(path.dirname(path.join(model, f.path)), { recursive: true });
      fs.writeFileSync(path.join(model, f.path), '');
      fs.truncateSync(path.join(model, f.path), f.size);
    }
    expect(check(env, pick).find((s) => s.id === 'tts:breeze')?.ready).toBe(false);
    for (const f of BreezeTTS2.files.filter((f) => f.path.includes('/'))) {
      fs.mkdirSync(path.dirname(path.join(model, f.path)), { recursive: true });
      fs.writeFileSync(path.join(model, f.path), '');
      fs.truncateSync(path.join(model, f.path), f.size);
    }
    expect(check(env, pick).find((s) => s.id === 'tts:breeze')?.ready).toBe(true);
  });
});
