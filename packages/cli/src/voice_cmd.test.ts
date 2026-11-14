import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allOps } from './ops/op';
import { Buffer, hasFfmpeg, run, setenv, tempDir } from './testutil';

describe('voice ops', () => {
  it('gives the orchestrator list, get, save and default, but no way to delete a voice', () => {
    const names = allOps().map((op) => op.name).filter((name) => name.startsWith('voice_'));
    expect(names.sort()).toEqual(['voice_default', 'voice_get', 'voice_list', 'voice_save']);
  });

  it('voice_get without a default voice says how to get one', async () => {
    setenv('ONSET_VOICES_DIR', tempDir());
    const out = new Buffer();
    expect(await run(['voice', 'get'], out)).toBe(1);
    expect(out.text).toContain('voice_save()');
  });
});

describe.skipIf(!hasFfmpeg)('voice ops with real ffmpeg', () => {
  it('saves a project clip into the user library and hands back what Breeze needs to clone it', async () => {
    const library = tempDir();
    setenv('ONSET_VOICES_DIR', library);
    const project = tempDir();
    fs.mkdirSync(path.join(project, 'production', 'audio'), { recursive: true });
    const clip = path.join(project, 'production', 'audio', 'try-2.wav');
    expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=5', clip]).status).toBe(0);
    fs.writeFileSync(path.join(project, 'production', 'audio', 'try-text.txt'), '今天我们来聊聊，它为什么改变了整个行业。\n');
    process.chdir(project);

    const saved = new Buffer();
    expect(await run(['voice', 'save', '沉稳男声', '--audio', 'production/audio/try-2.wav', '--text-file', 'production/audio/try-text.txt'], saved), saved.text).toBe(0);
    expect(saved.text).toContain('是默认音色');

    const got = new Buffer();
    expect(await run(['voice', 'get'], got), got.text).toBe(0);
    expect(got.text).toContain(path.join(library, '沉稳男声', 'reference.wav'));
    expect(got.text).toContain('文字稿：今天我们来聊聊，它为什么改变了整个行业。');

    const both = new Buffer();
    expect(await run(['voice', 'save', 'x', '--audio', 'production/audio/try-2.wav'], both)).toBe(1);
    expect(both.text).toContain('text 与 text_file 要给且只给一个');
  });
});
