import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as song from '../song';
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
    // 内置的歌曲讲解插件把它那一节接在制作提示词后面（老项目的提示词里本来就有，不重复）。
    expect(got.prompt.toString().startsWith('from-article\n\n## 歌曲讲解分支\n')).toBe(true);
    expect(path.basename(got.path)).toBe(ProductionPrompt);
    fs.writeFileSync(path.join(root, 'transcription.srt'), '1\n');
    expect(runPrompt(root, '').prompt.toString()).toBe('from-srt');
  });

  // 歌曲项目不论用哪份提示词开工，都要带上歌曲模式的必要契约（客户端的「开始制作」走这里）。
  it('always adds the song contract in song projects', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'song.yaml'), song.DefaultConfig);
    fs.writeFileSync(path.join(root, 'PROMPT-SONG.md'), 'SONG-PROMPT');
    const custom = path.join(root, 'custom.md');
    fs.writeFileSync(custom, 'CUSTOM-PROMPT');
    for (const override of ['', custom]) {
      const body = runPrompt(root, override).prompt.toString();
      expect(body).toContain('歌曲模式必要契约');
      expect(body).toContain('不得代替用户选择');
      expect(body).toContain(override === '' ? 'SONG-PROMPT' : 'CUSTOM-PROMPT');
    }
  });
});
