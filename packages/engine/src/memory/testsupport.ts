// 本包测试共用的辅助，对应 memory_test.go 里的包级辅助（writeSceneDir、lesson、newStore、failingAttempt）。
// 不从 index.ts 导出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { load, newAttempt, OutcomeVerificationFailed, type Attempt, type Scene } from '../scene';
import { newApplies, newMemory, type Memory, type Status } from './memory';
import { open, type Store } from './store';

/** t.TempDir()：测试结束时删掉。 */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-memory-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeSceneDir(dir: string, id: string, text: string, prompt: string): Scene {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:03,000\n字幕\n');
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    `{"id":"${id}","duration_seconds":3,"output":"out.mp4","transcript":"transcript.srt","text":"${text}"}`,
  );
  if (prompt !== '') fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  return load(dir);
}

export function lesson(name: string, status: Status, features: string[] | null, ...checks: string[]): Memory {
  return newMemory({
    kind: 'lesson',
    name,
    description: '描述 ' + name,
    status,
    applies_when: newApplies({ features: features ?? [] }),
    checked_by: checks.length > 0 ? checks : null,
    from_episodes: ['ep-x'],
    body: '规则正文。\n\n反例：\n    坏写法\n\n正例：\n    好写法',
  });
}

/** 记忆库建在临时目录里，时钟每次调用走一秒。 */
export function newStore(): Store {
  const store = open(tempDir());
  let tick = Date.UTC(2026, 10, 2, 10, 0, 0);
  store.now = () => {
    tick += 1000;
    return new Date(tick);
  };
  return store;
}

export function failingAttempt(renderer: string, ...checks: string[]): Attempt {
  return newAttempt({ renderer, outcome: OutcomeVerificationFailed, problems: checks.map((c) => '问题 ' + c), checks });
}
