// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, reply } from '../testing';
import type { ExamResult, MemoryRow, MemoryState, Scene } from '../types';
import { MemoryTab } from './Memory';
import { exam, examCell, examProgress, lesson, memoryState, recall } from './memoryFixtures';

// 记忆页：页头三步讲清记忆在做什么，下面是要求、经验、考试与重考。数据来自 /api/memory 与 /api/memory/recall。

const scene: Scene = { id: 'scene-001', directory: 'scenes/scene-001', duration_seconds: 1, output: 'out.mp4', exists: false, stale: false, attempts: 0 };

function setup(state: MemoryState, routes: Record<string, unknown> = {}) {
  const api = mockApi({ '/api/memory': state, '/api/memory/recall': recall(), ...routes });
  const run = vi.fn();
  const view = render(<MemoryTab scene={scene} version={1} run={run} />);
  return { api, run, ...view };
}

const flow = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.memory-flow li')];

/** /api/memory/applications 的回答（studio/memory.ts 的 memoryApplicationsAPI）。 */
function applications(matches: { scene_id: string; text: string; source_scene?: boolean }[]) {
  return {
    name: 'hold-readable',
    status: 'dormant',
    enabled: true,
    scanned: matches.length,
    unreadable: 0,
    matches: matches.map((m) => ({ renderer: 'claude', model: '', selected: true, features: [], keywords: [], global: true, omit_reason: '', source_scene: false, ...m })),
  };
}

afterEach(() => vi.useRealTimers());

describe('记忆页', () => {
  it('页头三步讲清记忆在做什么，并能记下一条要求', async () => {
    const preference: MemoryRow = { ...lesson(), name: 'pace-slow', kind: 'preference', description: '节奏慢一点，每个画面多停一秒', checked_by: [], from_episodes: [], verified_by: [], body: '节奏慢一点，每个画面多停一秒' };
    const { api, container } = setup(memoryState(), {
      'POST /api/memory/actions/remember': () => {
        api.set('/api/memory', memoryState({ memories: [preference] }));
        return { message: '已记下：节奏慢一点，每个画面多停一秒' };
      },
    });
    await screen.findByText('scene-001 · 0 条');
    const steps = flow(container);
    expect(steps).toHaveLength(3);
    expect(steps[0].textContent).toContain('记下的问题');
    expect(steps[1].textContent).toContain('整理成的提醒');
    expect(steps[2].querySelector('strong')!.textContent).toBe('0');
    expect(steps[2].querySelector('small')!.textContent).toBe('scene-001 · 0 条');
    // 页头照实说：成片确认可用后才整理，经验要考试才带进渲染。
    const head = container.querySelector('.memory-head')!.textContent;
    expect(head).toContain('这一版可用');
    expect(head).toContain('考过了');
    // 没有失败时不出「记下的问题」一节，渲染日志收在「高级」里。
    expect(container.querySelector('.memory-problems')).toBeNull();
    expect(container.querySelector('.memory-advanced')!.hasAttribute('open')).toBe(false);

    await userEvent.type(screen.getByRole('textbox', { name: '偏好内容' }), '节奏慢一点，每个画面多停一秒');
    await userEvent.click(screen.getByRole('button', { name: '记住' }));
    expect(api.calls.find((c) => c.path === '/api/memory/actions/remember')?.body).toEqual({ note: '节奏慢一点，每个画面多停一秒', global: false });
    await screen.findByText('节奏慢一点，每个画面多停一秒', { selector: '.memory-card .memory-desc' });
    expect(flow(container)[1].textContent).toContain('你的要求 1');
    expect(api.unmatched).toEqual([]);
  });

  it('召回轮询慢或暂时出错时留着上一次的条数', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let calls = 0;
    let release: (() => void) | null = null;
    const { container } = setup(memoryState(), {
      '/api/memory/recall': () => {
        calls++;
        if (calls === 1) return recall([{ name: 'one-rule', kind: 'lesson', description: '会带上的提醒', score: 1, chars: 6 }]);
        return new Promise((resolve) => {
          release = () => resolve(reply(503, { message: '暂时不可用' }));
        });
      },
    });
    const count = () => flow(container)[2];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(count().querySelector('strong')!.textContent).toBe('1');
    // 第二次请求一直不回：数字不跳回「…」。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(calls).toBe(2);
    expect(count().querySelector('strong')!.textContent).toBe('1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(count().querySelector('strong')!.textContent).toBe('1');
    // 请求失败：仍显示上次的条数，并注明没更新。
    await act(async () => {
      release!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(count().textContent).toContain('上次结果，暂未更新');
    expect(count().querySelector('strong')!.textContent).toBe('1');
  });

  it('停用的经验能查适用镜头并重考，不会因此重新生效；迁移验证只交所选的新镜头', async () => {
    const { api, run, container } = setup(memoryState({ memories: [lesson({ status: 'dormant' })], exams: [exam()] }), {
      '/api/memory/applications': applications([{ scene_id: 'scene-001', text: 'hello' }]),
    });
    await userEvent.click(within(await screen.findByRole('region', { name: '重考入口' })).getByRole('button', { name: '查看并重考' }));
    const retired = container.querySelector<HTMLDetailsElement>('.memory-retired')!;
    expect(retired.open).toBe(true);
    const card = within(retired.querySelector<HTMLElement>('.memory-card')!);
    expect(card.getByRole('button', { name: '重新考试' })).toBeTruthy();
    await userEvent.click(card.getByRole('button', { name: '查找适用镜头' }));
    const results = await waitForResults(retired);
    expect(results.textContent).toContain('scene-001');
    expect(results.textContent).toContain('试用时能召回');
    expect(api.calls.find((c) => c.path === '/api/memory/applications')?.query.get('name')).toBe('hold-readable');
    await userEvent.click(card.getByRole('button', { name: '用所选 1 个镜头重新考试' }));
    expect(run).toHaveBeenCalledWith('/api/memory/actions/exam', { renderers: ['claude'], scenes: ['scene-001'], name: 'hold-readable' });
    // 没有调用任何改经验状态的接口（promote / reject / retire 都经 run）。
    expect(run).toHaveBeenCalledTimes(1);

    // 迁移验证：来源镜头不能选，只交所选的新镜头。
    run.mockClear();
    api.set('/api/memory/applications', applications([
      { scene_id: 'scene-001', text: '来源镜头', source_scene: true },
      { scene_id: 'scene-002', text: '新的镜头' },
    ]));
    await userEvent.click(card.getByRole('button', { name: '查找适用镜头' }));
    await screen.findByText('新的镜头');
    await userEvent.click(card.getByRole('checkbox', { name: '仅验证所选新镜头' }));
    const rows = [...retired.querySelectorAll<HTMLElement>('.memory-application-results li')];
    expect(rows[0].querySelector('input')!.disabled).toBe(true);
    expect(rows[1].querySelector('input')!.checked).toBe(true);
    await userEvent.click(card.getByRole('button', { name: '用所选 1 个镜头重新考试' }));
    expect(run).toHaveBeenCalledWith('/api/memory/actions/exam', { renderers: ['claude'], scenes: ['scene-002'], holdout_only: true, name: 'hold-readable' });
  });

  it('试用中的经验在自己的卡片上也能单独考', async () => {
    const { run } = setup(memoryState({ memories: [lesson({ status: 'trial', verified_by: [] })], exams: [exam()] }));
    await userEvent.click(await screen.findByRole('button', { name: '只考这条' }));
    expect(run).toHaveBeenCalledWith('/api/memory/actions/exam', { renderers: ['claude'], trial: 'hold-readable' });
  });

  it('最近考试结果：人工验收、不完整的题与两组满分都照实说', async () => {
    const accepted = exam({
      cells: [examCell('control', false, { incomplete: true }), examCell('trial', true)],
      verdict: { pass: false, invalid: false, needs_human: true, control_score: -2, trial_score: 10, reasons: ['检查依据不完整，原始备注保留'] },
      applied: 'none',
      human_acceptance: { id: 'a1', name: 'hold-readable', description: '画面上的字要停够时间再换', question_ids: ['q1'], accepted_at: '2026-11-13T02:00:00Z', note: '用户认可', user_statement: '进化完成了' },
    });
    const later: ExamResult = { ...accepted, id: 'exam-0002', human_acceptance: undefined };
    const first = setup(memoryState({ memories: [lesson()], exams: [accepted, later] }));
    // 验收过的那一场不是最后一场时单独挂在上面。
    expect((await screen.findByRole('region', { name: '人工验收结论' })).textContent).toContain('人工验收通过');
    expect(first.container.querySelector('.memory-tab')!.textContent).toContain('检查依据不完整');
    const recent = screen.getByRole('region', { name: '最近考试结果' });
    expect(recent.textContent).toContain('本题结果不完整，不能比较');
    expect(recent.textContent).not.toContain('带上后少了');
    first.unmount();

    // 两组都满分：不说成改善。
    const tie = exam({
      cells: [examCell('control', true), examCell('trial', true)],
      verdict: { pass: false, invalid: false, needs_human: false, control_score: 10, trial_score: 10, reasons: ['总分没有提高'] },
      applied: 'none',
    });
    setup(memoryState({ memories: [lesson()], exams: [tie] }));
    const latest = await screen.findByRole('region', { name: '最近考试结果' });
    expect(latest.querySelector('.exam-review-heading')!.textContent).toContain('未发现额外改善');
    expect(latest.querySelector('.exam-no-gain')!.textContent).toContain('重复相同满分题不能增加改善证据');
  });

  it('带上经验后问题变多时，最近考试结果先摆出那一题，两边都是可播放的画面', async () => {
    const worse = exam({
      cells: [examCell('control', true), examCell('trial', false, { problems: 1, checks: ['reads.duration'] })],
      verdict: { pass: false, invalid: false, needs_human: false, control_score: 10, trial_score: -1, reasons: ['带上后多了一处阅读时间问题'] },
      applied: 'none',
    });
    setup(memoryState({ memories: [lesson()], exams: [worse] }), { '/api/memory/recall': recall([{ name: 'hold-readable', kind: 'lesson', description: '画面上的字要停够时间再换', score: 1, chars: 12 }]) });
    const recent = await screen.findByRole('region', { name: '最近考试结果' });
    expect(recent.textContent).toContain('带上后多了 1 处问题');
    expect(recent.querySelectorAll('video[controls]')).toHaveLength(2);
    await screen.findByText('scene-001 · 1 条');
  });

  it('考试进度跟着刷新，考完出现结果，能展开看每一次实际带入了什么', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const progress = examProgress();
    const { api } = setup(memoryState({ memories: [lesson({ status: 'trial', verified_by: [] })], exam_progress: [progress] }));
    const panel = await screen.findByRole('region', { name: '考试进度' });
    expect(panel.textContent).toContain('已完成 0 / 2 组');
    expect(panel.textContent).toContain('这道题考字幕阅读时间');
    expect(panel.textContent).toContain('画面上的字要停够时间再换');
    expect(panel.textContent).toContain('等待空位');

    const next = examProgress();
    next.cells[0] = { ...next.cells[0], status: 'completed', result: examCell('control', true, { problems: 0 }) };
    next.cells[1] = { ...next.cells[1], status: 'running' };
    api.set('/api/memory', memoryState({ memories: [lesson({ status: 'trial', verified_by: [] })], exam_progress: [next] }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await screen.findByText(/已完成 1 \/ 2 组/);

    api.set('/api/memory', memoryState({ memories: [lesson()], exams: [exam()], exam_progress: [] }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    const recent = await screen.findByRole('region', { name: '最近考试结果' });
    expect(screen.queryByRole('region', { name: '考试进度' })).toBeNull();
    expect(recent.textContent).toContain('画面上的字要停够时间再换');
    expect(recent.querySelectorAll('video[controls]')).toHaveLength(2);
    const summary = within(recent).getByText('第 1 次 · 查看问题', { exact: true });
    await userEvent.click(summary);
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(true);
    expect(summary.parentElement!.textContent).toContain('实际带入：无');
  });
});

async function waitForResults(root: HTMLElement): Promise<HTMLElement> {
  await screen.findByText(/已检查当前项目/);
  return root.querySelector<HTMLElement>('.memory-application-results')!;
}
