import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newAttempt, OutcomeSucceeded } from '../scene';
import { examProgress } from './exam';
import { SourceRender } from './episode';
import { StatusTrial } from './memory';
import { writeJSON } from './io';
import { failingAttempt, lesson, newStore, tempDir, writeSceneDir } from './testsupport';

function fixture() {
  const store = newStore();
  const project = tempDir();
  const sc = writeSceneDir(path.join(project, 'scenes', 'scene-001'), 'scene-001', '考试口播', '');
  const ep = store.recordAttempt(sc, failingAttempt('codex', 'determinism.raf'), { source: SourceRender });
  const m = lesson('no-raf', StatusTrial, null, 'determinism.raf');
  m.from_episodes = [ep.id];
  store.write(m);
  return { store, opts: { renderers: ['codex'], budget: 1500, workspace: path.join(project, 'production', 'memory-exams') } };
}

describe('exam progress and failure boundaries', () => {
  it('persists questions and queued/running/completed cells before judging', async () => {
    const { store, opts } = fixture();
    let calls = 0;
    const result = await store.exam({ ...opts, run: async () => {
      const [progress] = examProgress(store);
      expect(progress.status).toBe('running');
      expect(progress.questions[0].text).toBe('考试口播');
      expect(progress.trials[0].checks).toEqual(['determinism.raf']);
      expect(progress.cells.map((c) => c.status)).toEqual(calls++ === 0 ? ['running', 'queued'] : ['completed', 'running']);
      expect(store.exams()).toHaveLength(0);
      expect(store.find('no-raf')?.status).toBe(StatusTrial);
      return calls === 1 ? failingAttempt('codex', 'determinism.raf') : newAttempt({ outcome: OutcomeSucceeded });
    } });
    expect(result.applied).toBe('promoted');
    expect(examProgress(store)[0].status).toBe('completed');
    expect(examProgress(store)[0].cells.every((c) => c.finished_at && c.result)).toBe(true);
  });

  it('does not dispatch queued cells or change memories after cancellation', async () => {
    const { store, opts } = fixture();
    const controller = new AbortController();
    let calls = 0;
    await expect(store.exam({ ...opts, signal: controller.signal, run: async () => {
      calls++;
      controller.abort();
      return newAttempt({ outcome: OutcomeSucceeded });
    } })).rejects.toThrow('考试已取消');
    expect(calls).toBe(1);
    expect(examProgress(store)[0].status).toBe('cancelled');
    expect(examProgress(store)[0].cells[1].status).toBe('cancelled');
    expect(store.find('no-raf')?.status).toBe(StatusTrial);
    expect(store.exams()).toHaveLength(0);
  });

  it.each(['runner', 'post-check'])('keeps %s exceptions invalid and waits for all parallel cells', async (where) => {
    const { store, opts } = fixture();
    if (where === 'post-check') {
      const m = store.find('no-raf')!;
      m.checked_by = ['frames.blank'];
      store.write(m);
    }
    let finished = 0;
    const result = await store.exam({ ...opts, jobs: 2, run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished++;
      if (where === 'runner') throw new Error('工具崩溃');
      return newAttempt({ outcome: OutcomeSucceeded });
    }, postCheck: () => { throw new Error('补查崩溃'); } });
    expect(finished).toBe(2);
    expect(result.verdict.invalid).toBe(true);
    expect(result.applied).toBe('none');
    expect(result.cells?.every((c) => c.invalid)).toBe(true);
    expect(store.find('no-raf')?.status).toBe(StatusTrial);
    expect(examProgress(store)[0].status).toBe('completed');
  });

  it('reads old result-only exams without inventing running progress', () => {
    const { store } = fixture();
    fs.mkdirSync(path.join(store.dir, 'exams', 'exam-0001'), { recursive: true });
    expect(examProgress(store)).toEqual([]);
  });

  it('shows a dead owner as interrupted without changing memory or inventing a score', () => {
    const { store, opts } = fixture();
    writeJSON(path.join(store.dir, 'exams', 'exam-0001', 'progress.json'), {
      id: 'exam-0001', pid: 12345, status: 'running', workspace: opts.workspace,
      trials: [], questions: [], cells: [{ status: 'running' }, { status: 'queued' }],
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    try {
      const [p] = examProgress(store);
      expect(p.status).toBe('failed');
      expect(p.cells.map((c) => c.status)).toEqual(['cancelled', 'cancelled']);
      expect(store.exams()).toHaveLength(0);
      expect(store.find('no-raf')?.status).toBe(StatusTrial);
    } finally { kill.mockRestore(); }
  });
});
