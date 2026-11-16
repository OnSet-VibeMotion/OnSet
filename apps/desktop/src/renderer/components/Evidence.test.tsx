// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../testing';
import type { ExamResult, MemoryState } from '../types';
import { EvidenceTab } from './Evidence';
import { emptyLearning, exam, examCell, examProgress, lesson, memoryState } from './memoryFixtures';

// 进化页：一场考过的试排成「同一个镜头带与不带一条经验」的两段画面、这条经验本身与考试结果。
// 数据全部来自 /api/memory（后端的拼装由 packages/engine/src/studio/memory.test.ts 钉着），这里只看页面怎么摆。

function setup(state: MemoryState) {
  const api = mockApi({ '/api/memory': state, '/api/learning': emptyLearning });
  const run = vi.fn();
  const onOpen = vi.fn();
  const view = render(<EvidenceTab version={1} run={run} onOpen={onOpen} />);
  return { api, run, onOpen, ...view };
}

const figures = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.evidence-figures li')];
const side = (container: HTMLElement, arm: 'control' | 'trial') => container.querySelector<HTMLElement>(`.evidence-side.${arm}`)!;

afterEach(() => vi.useRealTimers());

describe('进化页', () => {
  it('把一场考试的两组并排：问题数、结论、画面地址与这条经验', async () => {
    const { container, api } = setup(memoryState({ memories: [lesson()], exams: [exam()] }));
    await screen.findByText('同一个镜头，带与不带');
    const [before, verdict, tested] = figures(container);
    // 带上经验之前 2 处问题，之后 0 处；这条经验考过试、正在用。
    expect(before.querySelector('strong')!.textContent).toMatch(/2\s*→\s*0/);
    expect(verdict.textContent).toContain('考试通过');
    expect(verdict.textContent).toContain('1 个镜头 × 每组 1 次');
    expect(tested.querySelector('strong')!.textContent).toBe('1');
    // 两段画面都读得到：路径来自后端给的 preview_video。
    const control = side(container, 'control');
    const trial = side(container, 'trial');
    expect(control.querySelector('video')!.getAttribute('src')).toMatch(/\/api\/memory\/exams\/exam-0001\/video\?.*arm=control/);
    expect(trial.querySelector('video')!.getAttribute('src')).toMatch(/\/api\/memory\/exams\/exam-0001\/video\?.*arm=trial/);
    // 问题用大白话说，不露出校验器的编号。
    expect(control.textContent).toContain('查出 2 处问题');
    expect(control.textContent).toContain('文字停留太短，读不完 · 2 处');
    expect(control.textContent).not.toContain('reads.duration');
    expect(trial.textContent).toContain('没有查出问题');
    const lessonCard = container.querySelector('.evidence-lesson')!;
    expect(lessonCard.textContent).toContain('画面上的字要停够时间再换');
    expect(lessonCard.querySelector('.evidence-chip')!.textContent).toBe('正在用');
    const scope = container.querySelector('.evidence-scope')!.textContent;
    expect(scope).toContain('本场没有留出镜头');
    expect(scope).toContain('画面是否更好，要看人的对照评价');
    expect(api.unmatched).toEqual([]);
  });

  it('人工验收过的考试显示「进化完成」，同时保留机器检查不完整的原始备注', async () => {
    const accepted = exam({
      cells: [examCell('control', false, { incomplete: true }), examCell('trial', true)],
      verdict: { pass: false, invalid: false, needs_human: true, control_score: -2, trial_score: 10, reasons: ['检查依据不完整，原始备注保留'] },
      applied: 'none',
      human_acceptance: {
        id: 'acceptance-1',
        name: 'hold-readable',
        description: '画面上的字要停够时间再换',
        question_ids: ['q1'],
        accepted_at: '2026-11-13T02:00:00Z',
        note: '用户认可该镜头的观看效果',
        user_statement: '我认为这个已经属于进化完成了',
      },
      original_verdict: { pass: false, invalid: false, needs_human: true, control_score: -2, trial_score: 10, reasons: ['检查依据不完整，原始备注保留'] },
    });
    // 之后又考了一场（没有人工验收）：进化页仍先摆出验收过的那一场。
    const later: ExamResult = { ...accepted, id: 'exam-0002', human_acceptance: undefined, original_verdict: undefined };
    const { container } = setup(memoryState({ memories: [lesson()], exams: [accepted, later] }));
    await screen.findByText('同一个镜头，带与不带');
    const summary = container.querySelector('.evidence-figures')!.textContent;
    expect(summary).toContain('进化完成');
    expect(summary).toContain('检查依据不完整');
    const region = screen.getByRole('region', { name: '人工验收结论' });
    expect(region.textContent).toContain('exam-0001 · q1 · scene-001');
    expect(region.textContent).toContain('后续渲染符合适用条件的镜头会继续带上');
    expect(region.textContent).toContain('进化完成');
    expect(container.querySelector('.evidence')!.textContent).toContain('检查依据不完整，原始备注保留');
  });

  it('依据不完整时不当成「问题更少」：概要说暂不能比较，对照组不列问题', async () => {
    const incomplete = exam({ cells: [examCell('control', false, { incomplete: true }), examCell('trial', true)] });
    const { container } = setup(memoryState({ memories: [lesson()], exams: [incomplete] }));
    await screen.findByText('同一个镜头，带与不带');
    const summary = container.querySelector('.evidence-figures')!.textContent;
    expect(summary).toContain('检查依据不完整');
    expect(summary).toContain('暂不能比较');
    expect(side(container, 'control').textContent).not.toContain('文字停留太短，读不完');
  });

  it('两组都满分时照实说没有证明额外改善', async () => {
    const tie = exam({
      cells: [examCell('control', true), examCell('trial', true)],
      verdict: { pass: false, invalid: false, needs_human: false, control_score: 10, trial_score: 10, reasons: ['总分没有提高：对照 10.0，试用 10.0'] },
      applied: 'none',
    });
    const { container } = setup(memoryState({ memories: [lesson()], exams: [tie] }));
    await screen.findByText('同一个镜头，带与不带');
    expect(container.querySelector('.evidence-figures')!.textContent).toContain('未发现额外改善');
    expect(screen.getByText(/两组都通过了本场检查，尚未证明经验带来额外改善。/)).toBeTruthy();
  });

  it('能逐次看重复的对照，并列出无效的考试', async () => {
    const repeated = exam();
    repeated.cells.push(...repeated.cells.map((c) => ({ ...c, repeat: 2, passed: true, problems: 0, checks: [] })));
    const invalid = exam({
      id: 'exam-0002',
      applied: 'none',
      cells: repeated.cells.map((c) => ({ ...c, invalid: true, error: '作答工具崩溃' })),
      verdict: { pass: false, invalid: true, needs_human: false, control_score: 0, trial_score: 0, reasons: ['作答无效，不计成绩'] },
    });
    const { container } = setup(memoryState({ memories: [lesson()], exams: [repeated, invalid] }));
    await screen.findByText('同一个镜头，带与不带');
    const page = container.querySelector('.evidence')!;
    expect(page.textContent).toContain('exam-0002 · 考试无效');
    expect(page.textContent).toContain('作答工具崩溃');
    expect(side(container, 'control').textContent).toContain('查出 2 处问题');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '第几次重复' }), '2');
    expect(side(container, 'control').textContent).toContain('没有查出问题');
    expect(page.textContent).toContain('不能证明每条经验单独有效');
  });

  for (const status of ['rejected', 'trial'] as const) {
    it(`没留下或试用中的经验（${status}）有看得见的重考入口，点了只发考试请求、不改经验状态`, async () => {
      const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
      const { run } = setup(memoryState({ memories: [lesson({ status })], exams: [exam()] }));
      const entry = within(await screen.findByRole('region', { name: '重考入口' })).getByRole('button', { name: '查看并重考' });
      await userEvent.click(entry);
      // 入口把页面带到「本场经验与重考」那一节。
      const lessons = screen.getByRole('region', { name: '本场经验与重考' });
      expect(scroll.mock.contexts.includes(lessons)).toBe(true);
      await userEvent.click(within(lessons).getByRole('button', { name: status === 'trial' ? '只考这条' : '重新考试' }));
      expect(run).toHaveBeenCalledWith('/api/memory/actions/exam', { renderers: ['claude'], ...(status === 'trial' ? { trial: 'hold-readable' } : { name: 'hold-readable' }) });
      scroll.mockRestore();
    });
  }

  it('考试进行中的进度跟着刷新，考完换成考试结果，不用重开页面', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const progress = examProgress();
    progress.cells[0] = { ...progress.cells[0], status: 'completed', result: examCell('control', true, { problems: 0 }) };
    progress.cells[1] = { ...progress.cells[1], status: 'running' };
    const { api, container } = setup(memoryState({ memories: [lesson({ status: 'trial', verified_by: [] })], exam_progress: [progress] }));
    const panel = await screen.findByRole('region', { name: '考试进度' });
    expect(panel.textContent).toContain('已完成 1 / 2 组');
    // 考完：后端不再给进行中的进度，给出考试结果。
    api.set('/api/memory', memoryState({ memories: [lesson()], exams: [exam()], exam_progress: [{ ...progress, status: 'completed' }] }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await screen.findByText('同一个镜头，带与不带');
    expect(screen.queryByRole('region', { name: '考试进度' })).toBeNull();
    expect(container.querySelector('.evidence-figures')!.textContent).toContain('考试通过');
  });

  it('还没有考过试时先说该做什么，按钮带去记忆页', async () => {
    const { onOpen, container } = setup(memoryState());
    await screen.findByText('还没有考过试的经验');
    await userEvent.click(within(container.querySelector<HTMLElement>('.evidence-empty')!).getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith('memory');
  });
});
