import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import { design, designStatus, get, getDraft, save, SampleText } from './index';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-voice-design-'));

describe('voice design', () => {
  it('is only possible on Apple Silicon, and says Breeze is missing on an empty machine', () => {
    expect(designStatus({ HOME: tempDir() }, 'linux', 'x64')).toMatchObject({ ready: false, supported: false });
    const empty = designStatus({ HOME: tempDir(), PATH: '/usr/bin:/bin', ONSET_BIN_DIR: tempDir() }, 'darwin', 'arm64');
    expect(empty).toMatchObject({ ready: false, supported: true });
    expect(empty.problem).toContain('Breeze');
  });

  it('reads the sample in ten seconds or so, which fits a 3–30 s reference clip', () => {
    // 按每秒 4.5 字估算。
    const seconds = [...SampleText].length / 4.5;
    expect(seconds).toBeGreaterThan(5);
    expect(seconds).toBeLessThan(25);
  });

  it('refuses draft ids that could reach outside the drafts folder', () => {
    const root = tempDir();
    for (const id of ['../library', 'd-xyz', '', 'd-0123456789ab/../../x']) expect(() => getDraft(root, id)).toThrow('没有这段试听');
  });

  it('asks for a description before running anything', async () => {
    await expect(design(tempDir(), { instruction: '  ', env: {} })).rejects.toThrow('先写一句描述');
  });
});

// 真的跑一次本机 Breeze（几十秒、要 4.6 GB 模型）：ONSET_TEST_BREEZE=1 时才跑，用开发机上 onset setup 装好的那一份。
describe.skipIf(process.env.ONSET_TEST_BREEZE !== '1')('RealBreeze voice design', () => {
  it('designs a take that can be saved into the library as a cloneable voice', async () => {
    const env = envMap();
    if (process.platform !== 'win32') delete env.ONSET_BIN_DIR;
    const root = tempDir();
    const draft = await design(root, { instruction: '三十多岁的男性，声音沉稳清晰，语气平静、真诚', env });
    expect(fs.statSync(draft.audio).size).toBeGreaterThan(10000);
    expect(getDraft(root, draft.id).text).toBe(SampleText);
    const saved = await save(root, { name: '设计的声音', audio: draft.audio, text: draft.text, source: 'designed', instruction: draft.instruction, env });
    expect(get(root, '设计的声音').duration_seconds).toBe(saved.duration_seconds);
  }, 300_000);
});
