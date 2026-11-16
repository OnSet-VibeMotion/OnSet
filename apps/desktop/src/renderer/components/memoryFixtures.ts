/*
 * 记忆页、进化页与考试对照的组件测试共用的 /api/memory 数据（只给 *.test.tsx 用）。
 * 形状照后端 packages/engine/src/studio/memory.ts 的 memoryAPI：一场考过的试，同一个镜头带与不带「hold-readable」这条经验各渲染一次，
 * 对照组查出 2 处阅读时间问题，试用组通过。字段都按 types.ts 定类型，后端改了形状这里的类型检查会先报。
 */
import type { ExamCell, ExamProgress, ExamResult, MemoryRow, MemoryState, RecallResponse } from '../types';

/** 后端 memory.CheckerLabels / EventLabels / featureDescriptions 里用得到的几条。 */
export const memoryLabels: NonNullable<MemoryState['labels']> = {
  checks: { 'reads.duration': '文字停留太短，读不完', 'reads.binding': '文字和口播对不上', 'frames.blank': '有空白画面' },
  events: { snapshot: '存档', consolidate: '整理' },
  features: { 'text-heavy': '字多的镜头' },
};

export function lesson(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    name: 'hold-readable',
    description: '画面上的字要停够时间再换',
    status: 'active',
    kind: 'lesson',
    applies_when: {},
    checked_by: ['reads.duration'],
    from_episodes: ['ep-x'],
    verified_by: ['exam-0001'],
    body: '每段文字停稳后至少留够读完的时间。\n\n反例：\n    停 10 帧就换\n\n正例：\n    停到读完\n',
    examinable: true,
    ...over,
  };
}

/** 考试里的一格；视频地址与后端一样带上题目、工具、组别与轮次。 */
export function examCell(arm: ExamCell['arm'], passed: boolean, over: Partial<ExamCell> = {}): ExamCell {
  const query = new URLSearchParams({ question: 'q1', renderer: 'claude', arm, repeat: String(over.repeat ?? 1) });
  return {
    question: 'q1',
    holdout: false,
    renderer: 'claude',
    arm,
    repeat: 1,
    outcome: passed ? 'succeeded' : 'verification_failed',
    passed,
    problems: passed ? 0 : 2,
    checks: passed ? [] : ['reads.duration', 'reads.duration'],
    seconds: 60,
    preview_video: { url: `/api/memory/exams/exam-0001/video?${query}`, source_project: 'demo' },
    audio_unavailable: '此题的来源配音暂时不可用，请检查原项目是否仍在、口播时间是否已改变。',
    ...over,
  };
}

export function exam(over: Partial<ExamResult> = {}): ExamResult {
  return {
    id: 'exam-0001',
    created_at: '2026-11-12T07:17:11Z',
    trials: ['hold-readable'],
    renderers: ['claude'],
    questions: [{ id: 'q1', holdout: false, scene_id: 'scene-001', episode: '' }],
    cells: [examCell('control', false), examCell('trial', true)],
    verdict: { pass: true, invalid: false, needs_human: false, control_score: -2, trial_score: 10, reasons: [] },
    applied: 'promoted',
    snapshot: 1,
    ...over,
  };
}

export function memoryState(over: Partial<MemoryState> = {}): MemoryState {
  return {
    enabled: true,
    dir: '/tmp/memory',
    project: 'demo',
    pinned: 0,
    budget: 1200,
    renderer: 'claude',
    status: { snapshot: 1, counts: {}, drift: [], weak: [], suspect: [], retest: [], episodes: 0, pending_failures: 0 },
    memories: [],
    timeline: [],
    exams: [],
    exam_progress: [],
    snapshots: [],
    runs: [],
    runs_all: [],
    pending: [],
    labels: memoryLabels,
    ...over,
  };
}

/** 进行中的一场考试（memory.examProgress 的 JSON）。 */
export function examProgress(over: Partial<ExamProgress> = {}): ExamProgress {
  const now = '2026-11-12T07:20:00Z';
  return {
    id: 'exam-0001',
    created_at: now,
    updated_at: now,
    status: 'running',
    trials: [{ name: 'hold-readable', description: '画面上的字要停够时间再换', checks: ['reads.duration'] }],
    questions: [{ id: 'q1', scene_id: 'scene-001', holdout: false, text: '这道题考字幕阅读时间' }],
    cells: (['control', 'trial'] as const).map((arm) => ({ question: 'q1', renderer: 'claude', arm, repeat: 1, status: arm === 'control' ? 'running' : 'queued' })),
    ...over,
  };
}

export function recall(items: RecallResponse['recall']['items'] = []): RecallResponse {
  return {
    recall: { snapshot: 1, renderer: 'claude', features: [], budget: 1200, used: 0, max_lessons: 3, items, omitted: [] },
    reasons: [],
    section: '',
  };
}

/** 学习关系页（/api/learning）没有数据时的样子。 */
export const emptyLearning = { relations: [], proposals: [], verdicts: 0, exemplars: 0, thresholds: { matches: 3, rate: 0.6 } };
