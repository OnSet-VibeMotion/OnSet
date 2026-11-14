import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Buffer, run, setenv, tempDir } from './testutil';
import * as song from '@am/engine/song';

it('song platform guide and configure', async () => {
  setenv('FAL_KEY', 'do-not-print-this');
  let out = new Buffer();
  let err = new Buffer();
  expect(await run(['song', 'providers', 'fal'], out, err), err.text).toBe(0);
  expect(out.text).not.toContain('do-not-print-this');
  expect(out.text).toContain('AM_PASSTHROUGH_ENV');
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'song.yaml'), song.DefaultConfig);
  out = new Buffer();
  err = new Buffer();
  expect(await run(['song', 'configure', '--project-root', root, '--provider', 'elevenlabs'], out, err), err.text).toBe(0);
  const c = song.loadConfig(root);
  expect(c.provider).toBe('elevenlabs');
  expect(out.text).toContain('ELEVENLABS_API_KEY');
});

it('mureka and lyria CLI setup', async () => {
  for (const tc of [
    { provider: 'mureka', key: 'MUREKA_API_KEY', model: 'mureka-9.5' },
    { provider: 'lyria', key: 'GEMINI_API_KEY', model: 'lyria-3.5' },
  ]) {
    setenv(tc.key, 'private-value-not-for-output');
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'song.yaml'), song.DefaultConfig);
    const out = new Buffer();
    const err = new Buffer();
    expect(await run(['song', 'configure', '--project-root', root, '--provider', tc.provider], out, err), err.text).toBe(0);
    expect(out.text).not.toContain('private-value-not-for-output');
    expect(out.text).toContain(tc.key);
    expect(out.text).toContain('AM_PASSTHROUGH_ENV');
    expect(song.loadConfig(root).model).toBe(tc.model);
  }
});

it('manual handoff CLI', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'song.yaml'), song.DefaultConfig);
  fs.writeFileSync(path.join(root, 'lyrics.txt'), '太阳照着水面\n水汽升上蓝天');
  let out = new Buffer();
  for (const args of [
    ['song', 'configure', '--provider', 'manual', '--project-root', root],
    ['song', 'handoff', '--project-root', root],
  ]) {
    out = new Buffer();
    const err = new Buffer();
    expect(await run(args, out, err), err.text).toBe(0);
  }
  expect(out.text).toContain('太阳照着水面');
  expect(out.text).toContain('等待用户提供音频');
});
