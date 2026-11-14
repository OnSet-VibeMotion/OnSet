import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import { ffmpeg, hasFfmpeg } from '../mediaprobe/testutil';
import { DirEnv, ReferenceFile, defaultDir, defaultName, get, list, remove, save, setDefault, validName } from './index';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-voice-'));

/** 现场生成一段正弦波当「录音」（双声道 44.1kHz MP3，存进去要转成 24kHz 单声道 WAV）。 */
function tone(seconds: number): string {
  const file = path.join(tempDir(), 'take.mp3');
  ffmpeg('-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}:sample_rate=44100`, '-ac', '2', file);
  return file;
}

describe('voice library', () => {
  it('lives in the user data dir, overridable by ONSET_VOICES_DIR', () => {
    expect(defaultDir({ HOME: '/h' })).toBe(path.join('/h', '.local/share/onset/voices'));
    expect(defaultDir({ HOME: '/h', XDG_DATA_HOME: '/x' })).toBe(path.join('/x', 'onset/voices'));
    expect(defaultDir({ HOME: '/h', [DirEnv]: '/v' })).toBe('/v');
    expect(defaultDir({})).toBe('');
  });

  it('accepts Chinese names but nothing that could escape or hide the directory', () => {
    for (const ok of ['沉稳男声', 'host-2', 'Me_1']) expect(validName(ok), ok).toBe(true);
    for (const bad of ['', '.hidden', '_x', '../up', 'a/b', 'a b', 'x'.repeat(41)]) expect(validName(bad), bad).toBe(false);
  });

  it('is empty and reports what exists when a voice is missing', () => {
    const root = tempDir();
    expect(list(root)).toEqual([]);
    expect(defaultName(root)).toBe('');
    expect(() => get(root, '老周')).toThrow('音色库还是空的');
  });
});

describe.skipIf(!hasFfmpeg)('voice library with real ffmpeg', () => {
  it('stores a 24kHz mono reference, makes the first voice the default and refuses silent overwrite', async () => {
    const root = path.join(tempDir(), 'voices');
    const env = envMap();
    const saved = await save(root, { name: '沉稳男声', audio: tone(6), text: '  一九七二年，这台计算机第一次跑通了完整的程序。 ', source: 'designed', instruction: '三十多岁男性', env });
    expect(saved.is_default).toBe(true);
    expect(saved.text).toBe('一九七二年，这台计算机第一次跑通了完整的程序。');
    expect(saved.audio).toBe(path.join(root, '沉稳男声', ReferenceFile));
    expect(saved.duration_seconds).toBeGreaterThan(5.9);
    // RIFF 头里的采样率与声道数：24000 Hz、单声道。
    const header = fs.readFileSync(saved.audio).subarray(0, 44);
    expect(header.readUInt16LE(22)).toBe(1);
    expect(header.readUInt32LE(24)).toBe(24000);

    await expect(save(root, { name: '沉稳男声', audio: tone(5), text: '换一段', source: 'designed', env })).rejects.toThrow('已经有「沉稳男声」');
    const second = await save(root, { name: '我的声音', audio: tone(4), text: '大家好', source: 'recorded', env });
    expect(second.is_default).toBe(false);
    expect(list(root).map((v) => v.name)).toEqual(['沉稳男声', '我的声音']);

    setDefault(root, '我的声音');
    expect(list(root)[0].name).toBe('我的声音');
    const replaced = await save(root, { name: '沉稳男声', audio: tone(8), text: '换一段', source: 'designed', overwrite: true, env });
    expect(replaced.text).toBe('换一段');
    expect(replaced.duration_seconds).toBeGreaterThan(7.9);
    // 换进去时不留临时目录与旧目录。
    expect(fs.readdirSync(root).sort()).toEqual(['library.json', '我的声音', '沉稳男声'].sort());

    remove(root, '我的声音');
    expect(defaultName(root)).toBe('沉稳男声');
    remove(root, '沉稳男声');
    expect(defaultName(root)).toBe('');
    expect(fs.existsSync(path.join(root, 'library.json'))).toBe(false);
  });

  it('rejects clips too short or too long to clone from, leaving nothing behind', async () => {
    const root = path.join(tempDir(), 'voices');
    const env = envMap();
    await expect(save(root, { name: 'short', audio: tone(1), text: '短', source: 'recorded', env })).rejects.toThrow('3 到 30 秒');
    await expect(save(root, { name: 'long', audio: tone(31), text: '长', source: 'recorded', env })).rejects.toThrow('3 到 30 秒');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
