// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, reply } from '../testing';
import type { Audition, AuditionContestant, Scene } from '../types';
import { AuditionTab } from './Audition';
import { AuditionProgress } from './AuditionActivity';

// 试镜页：评判之前只看得到 A、B（选手是谁由后端 audition.blindJSON 藏起来），选完才揭晓是谁。
// 评判写进 audition.json 与记忆库的评判记录、人评考试让经验生效，由 packages/engine/src/studio/auditions.test.ts
// 与 packages/engine/src/audition/learning.test.ts 钉着；这里看页面守不守盲评、点了发什么、揭晓后怎么说。

const scene: Scene = { id: 'scene-001', directory: 'scenes/scene-001', duration_seconds: 1, output: 'out.mp4', exists: true, stale: false, attempts: 0 };

function contestant(id: string, slot: string, renderer: string, model: string, role: AuditionContestant['role'] = ''): AuditionContestant {
  return {
    slot,
    renderer,
    model,
    actual_model: model,
    status: 'done',
    outcome: 'succeeded',
    output: `production/studio/auditions/${id}/${slot}/out.mp4`,
    seconds: 42,
    usage: { input_tokens: 120000, output_tokens: 8000 },
    problems: null,
    checks: null,
    error: '',
    designer: '',
    designer_model: '',
    role,
  };
}

/** 后端 blindJSON：评判之前，除了老师（参照），每位只给 slot、status、outcome、output。 */
function blind(a: Audition): Audition {
  return {
    ...a,
    blind: true,
    verdict: null,
    exam: a.exam ? { ...a.exam, applied: '' } : a.exam,
    contestants: a.contestants.map((c) => (c.role === 'reference' ? c : { slot: c.slot, status: c.status, outcome: c.outcome, output: c.output })),
  };
}

function setup(full: Audition, judged: Audition) {
  const api = mockApi({
    '/api/auditions': { auditions: [blind(full)] },
    '/api/auditions/recommend': { recommendations: [] },
    [`/api/auditions/${full.id}/activity`]: { contestants: [] },
    [`POST /api/auditions/${full.id}/vote`]: () => {
      api.set('/api/auditions', { auditions: [judged] });
      return judged;
    },
  });
  const run = vi.fn();
  const view = render(<AuditionTab scene={scene} scenes={[scene]} version={1} busy="" run={run} />);
  return { api, run, ...view };
}

const card = (container: HTMLElement, slot: string) => container.querySelector<HTMLElement>(`.audition-card[data-slot="${slot}"]`)!;
const buttons = (root: Element, text: string) => [...root.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('试镜页', () => {
  it('显示可操作的服务错误与已保留视频说明', () => {
    render(<AuditionProgress disconnected={false} activity={{ slot: 'C', state: 'failed', current: '模型额度不足', hint: '先补足该工具的可用额度。已有视频已保留，重试时先做本机验收。', step_count: 0, steps: [] }} />);
    expect(screen.getByRole('status', { name: '选手 C 的制作进度' }).textContent).toBe('模型额度不足');
    expect(screen.getByText(/已有视频已保留/)).toBeTruthy();
  });

  it('只重试失败或中断的选手，忙时说明原因，并在任务结束后重新读取过程', async () => {
    const id = 'audition-20261117-085722';
    const full: Audition = {
      id, created_at: '', scene_id: scene.id, scene_dir: scene.directory, features: [], with_memory: true,
      blind: true, verdict: null, adopted: null,
      contestants: [{ ...contestant(id, 'A', 'claude', 'secret'), outcome: 'failed', output: '' }, contestant(id, 'B', 'codex', 'secret')],
    };
    const { api, run, container, rerender } = setup(full, full);
    const retry = await screen.findByRole('button', { name: '重试 A' });
    expect(card(container, 'B').querySelector('[aria-label="重试 B"]')).toBeNull();
    rerender(<AuditionTab scene={scene} scenes={[scene]} version={1} busy="其余选手仍在试镜" run={run} />);
    expect(retry.hasAttribute('disabled')).toBe(true);
    expect(card(container, 'A').textContent).toContain('任务结束后可重试');
    rerender(<AuditionTab scene={scene} scenes={[scene]} version={1} busy="" run={run} />);
    await userEvent.click(retry);
    expect(run).toHaveBeenCalledWith(`/api/auditions/${id}/retry`, { slot: 'A' });
    api.set(`/api/auditions/${id}/activity`, { contestants: [{ slot: 'A', state: 'done', current: '已完成', steps: [], step_count: 0 }] });
    api.set('/api/auditions', { auditions: [blind({ ...full, contestants: full.contestants.map(c => ({ ...c, outcome: 'succeeded' })) })] });
    rerender(<AuditionTab scene={scene} scenes={[scene]} version={2} busy="" run={run} />);
    await screen.findByText('已完成');
    expect(screen.queryByRole('button', { name: '重试 A' })).toBeNull();
    expect(api.unmatched).toEqual([]);
  });

  it('显示每位选手当前动作并刷新过程，结束后保留记录', async () => {
    const id = 'audition-20261117-085722';
    const full: Audition = {
      id, created_at: '2026-11-17T00:00:00Z', scene_id: scene.id, scene_dir: scene.directory,
      features: [], with_memory: true, blind: true, verdict: null, adopted: null,
      contestants: [
        { ...contestant(id, 'A', 'claude', 'secret'), status: 'running', output: '', outcome: '' },
        { ...contestant(id, 'B', 'codex', 'secret'), status: 'pending', output: '', outcome: '' },
      ],
    };
    const rows = [
      { slot: 'A', state: 'running', current: '取帧与编码', phase: 'render', step_count: 2, steps: [{ label: '编写画面与动画', state: 'done' }, { label: '取帧与编码', state: 'running' }] },
      { slot: 'B', state: 'pending', current: '等待上场', phase: 'render', step_count: 0, steps: [] },
    ];
    const api = mockApi({ '/api/auditions': { auditions: [blind(full)] }, '/api/auditions/recommend': { recommendations: [] }, [`/api/auditions/${id}/activity`]: { contestants: rows } });
    vi.useFakeTimers();
    try {
      const { container, unmount } = render(<AuditionTab scene={scene} scenes={[scene]} version={1} busy="试镜中" run={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole('status', { name: '选手 A 的制作进度' })).toBeTruthy();
      expect(card(container, 'A').textContent).toContain('取帧与编码');
      expect(card(container, 'B').textContent).toContain('等待上场');
      expect(container.textContent).not.toContain('secret');
      fireEvent.click(screen.getByText('查看过程 · 2 步'));
      expect(card(container, 'A').querySelector('details')?.open).toBe(true);
      expect(card(container, 'A').textContent).toContain('编写画面与动画');
      api.set(`/api/auditions/${id}/activity`, reply(500, { message: 'temporary' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(card(container, 'A').textContent).toContain('进度连接中断');
      expect(card(container, 'A').textContent).toContain('取帧与编码');
      api.set(`/api/auditions/${id}/activity`, { contestants: [{ ...rows[0], state: 'waiting', current: '等待模型响应' }, rows[1]] });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(card(container, 'A').textContent).toContain('等待模型响应');
      expect(card(container, 'A').textContent).not.toContain('进度连接中断');
      api.set(`/api/auditions/${id}/activity`, { contestants: rows.map(r => ({ ...r, state: 'done', current: '已完成', steps: r.steps.map(step => ({ ...step, state: 'done' })) })) });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(card(container, 'A').textContent).toContain('已完成');
      expect(card(container, 'A').querySelector('details')?.open).toBe(true);
      const count = api.count(`/api/auditions/${id}/activity`);
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(api.count(`/api/auditions/${id}/activity`)).toBe(count);
      unmount();
    } finally {
      vi.useRealTimers();
    }
    expect(api.unmatched).toEqual([]);
  });

  it('评判之前看不出是谁、不能采用；选完揭晓是谁，并能换进镜头', async () => {
    const id = 'audition-20261114-153012';
    const full: Audition = {
      id,
      created_at: '2026-11-14T07:30:12Z',
      scene_id: 'scene-001',
      scene_dir: 'scenes/scene-001',
      features: [],
      with_memory: true,
      blind: false,
      contestants: [contestant(id, 'A', 'claude', 'secret-model-one'), contestant(id, 'B', 'codex', 'secret-model-two')],
      verdict: null,
      adopted: null,
      exam: null,
    };
    const judged: Audition = { ...full, verdict: { kind: 'winner', winner: 'B', note: '节奏更稳', at: '2026-11-14T08:00:00Z' } };
    const { api, run, container } = setup(full, judged);
    await screen.findByText('看完了？选出你觉得最好的一份。');
    expect(container.querySelectorAll('.audition-card')).toHaveLength(2);
    const page = container.querySelector('.audition')!;
    expect(page.textContent).not.toContain('secret-model');
    expect(page.textContent).not.toContain('codex');
    // 还没评判，不能采用。
    expect(buttons(page, '换进镜头')).toHaveLength(0);

    await userEvent.type(screen.getByRole('textbox', { name: '评判说明' }), '节奏更稳');
    await userEvent.click(buttons(card(container, 'B'), '选它')[0]);
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'winner', winner: 'B', note: '节奏更稳' });

    await screen.findByText('codex · secret-model-two');
    expect(card(container, 'B').querySelector('.audition-who')!.textContent).toBe('codex · secret-model-two');
    expect(card(container, 'B').querySelector('.audition-chip.on')!.textContent).toBe('你选的');
    expect(container.querySelector('.audition-verdict')!.textContent).toContain('节奏更稳');
    const adopt = buttons(card(container, 'B'), '换进镜头')[0];
    expect(adopt).toBeTruthy();
    await userEvent.click(adopt);
    expect(run).toHaveBeenCalledWith(`/api/auditions/${id}/adopt`, { slot: 'B' });
    expect(api.unmatched).toEqual([]);
  });

  it('人评考试公开老师、藏着哪份学生作品带了经验；选完说清经验生效，不能改判也不换进镜头', async () => {
    const id = 'audition-20261114-160000';
    const full: Audition = {
      id,
      created_at: '2026-11-14T08:00:00Z',
      scene_id: 'scene-001',
      scene_dir: 'scenes/scene-001',
      features: [],
      with_memory: true,
      blind: false,
      contestants: [contestant(id, 'A', 'codex', 'student', 'control'), contestant(id, 'B', 'codex', 'student', 'trial'), contestant(id, 'R', 'claude', 'teacher', 'reference')],
      verdict: null,
      adopted: null,
      exam: { relation: 'rel-1', student: 'codex/student', teacher: 'claude/teacher', lessons: ['layer-depth-first'], applied: '' },
    };
    const judged: Audition = {
      ...full,
      verdict: { kind: 'winner', winner: 'B', note: '', at: '2026-11-14T08:30:00Z' },
      exam: { ...full.exam!, applied: 'promoted' },
      exam_outcome: { applied: 'promoted', summary: '1 条经验生效' },
    };
    const { api, container } = setup(full, judged);
    const exam = await screen.findByText(/向 claude · teacher 学的 1 条经验/);
    expect(exam.closest('.audition-exam')).toBeTruthy();
    expect(card(container, 'R').querySelector('.audition-who')!.textContent).toBe('claude · teacher');
    expect(card(container, 'A').querySelector('.audition-who')).toBeNull();
    expect(container.querySelector('.audition')!.textContent).not.toContain('带经验');
    // 老师那份是参照，不能选。
    expect(buttons(card(container, 'R'), '选它')).toHaveLength(0);
    await userEvent.click(buttons(card(container, 'B'), '选它')[0]);
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'winner', winner: 'B', note: '' });

    await screen.findByText(/这些经验生效/);
    expect([...card(container, 'B').querySelectorAll('.audition-chip')].some((c) => c.textContent === '带经验')).toBe(true);
    expect(buttons(container.querySelector('.audition-verdict')!, '改判')).toHaveLength(0);
    expect(buttons(container, '换进镜头')).toHaveLength(0);
  });
});
