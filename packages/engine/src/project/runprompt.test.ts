// 移植自 internal/project/runprompt_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductionPrompt, runPrompt } from './runprompt';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-project-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runPrompt', () => {
  it('reads default and override', () => {
    const root = tempDir();
    expect(() => runPrompt(root, '')).toThrow('PROMPT.md');
    fs.writeFileSync(path.join(root, 'PROMPT.md'), 'default');
    let got = runPrompt(root, '');
    expect(got.prompt.toString()).toBe('default');
    expect(got.path).toBe(path.join(root, 'PROMPT.md'));
    const custom = path.join(root, 'custom.md');
    fs.writeFileSync(custom, 'custom');
    got = runPrompt(root, custom);
    expect(got.prompt.toString()).toBe('custom');
    expect(got.path).toBe(custom);
  });

  // 还没有定稿字幕时默认走完整制作。
  it('starts from article without transcript', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'PROMPT.md'), 'from-srt');
    fs.writeFileSync(path.join(root, ProductionPrompt), 'from-article');
    const got = runPrompt(root, '');
    expect(got.prompt.toString()).toBe('from-article');
    expect(path.basename(got.path)).toBe(ProductionPrompt);
    fs.writeFileSync(path.join(root, 'transcription.srt'), '1\n');
    expect(runPrompt(root, '').prompt.toString()).toBe('from-srt');
  });
});
