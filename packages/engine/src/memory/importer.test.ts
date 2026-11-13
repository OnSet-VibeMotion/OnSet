import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attemptLog, attemptToJSON, newAttempt, OutcomeSucceeded, OutcomeVerificationFailed, type Attempt } from '../scene';
import { marshal } from '../gojson';
import { passed, SourceRender, type Episode } from './episode';
import { runReport } from './report';
import { newStore, tempDir, writeSceneDir } from './testsupport';

function writeAttemptFile(file: string, a: Attempt): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, marshal(attemptToJSON(a)));
}

describe('importer', () => {
  // 最早的尝试算首次，其余算重试；重复导入跳过。
  it('TestImportProjectOrdersAttemptsAndDedupes', () => {
    const store = newStore();
    const root = path.join(tempDir(), 'demo');
    const s = writeSceneDir(path.join(root, 'scenes', 'scene-001'), 'scene-001', '中文', '');
    writeAttemptFile(
      path.join(s.directory, 'attempts', 'attempt-01', 'render-scene-001.attempt.json'),
      newAttempt({
        renderer: 'claude',
        started_at: '2026-10-01T00:00:00Z',
        outcome: OutcomeVerificationFailed,
        problems: ['源码不确定：index.html:3 [raf] 使用了 requestAnimationFrame：x', '总帧数不符：期望 30 帧，逐帧解码实测 31 帧'],
        checks: ['determinism.raf', 'output.frames'],
      }),
    );
    writeAttemptFile(attemptLog(s), newAttempt({ renderer: 'claude', model: 'claude-opus-5-5', started_at: '2026-10-01T01:00:00Z', outcome: OutcomeSucceeded }));
    const result = store.importProject(root, {});
    expect([result.attempts, result.failures, result.run]).toEqual([2, 1, 'import:demo']);
    let first: Episode | null = null;
    let second: Episode | null = null;
    for (const e of store.episodes()) {
      if (passed(e)) second = e;
      else if (e.source === SourceRender) first = e;
    }
    // 顺序或校验器不对。
    expect(first!.retry).toBe(false);
    expect(second!.retry).toBe(true);
    expect(first!.checks).toEqual(['determinism.raf', 'output.frames']);
    expect(second!.model).toBe('claude-opus-5-5');
    const again = store.importProject(root, {});
    // 重复导入应当跳过。
    expect(again.attempts).toBe(0);
    expect(again.skipped).toBe(2);
    const runs = runReport(store.episodes());
    // 导入的批次。
    expect(runs.length).toBe(1);
    expect(runs[0].pass_rate).toBe(0);
    expect(runs[0].retries).toBe(1);
  });
});
