// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { QuestionAsk } from '../../types';
import { QuestionCard } from './QuestionCard';
import { createStudio, turnDone, turnStart } from './studioHarness';

const sampleAsk: QuestionAsk = {
  id: 'q-req-1',
  title: '开工前确认 2 项规格',
  source: 'tool',
  questions: [
    {
      id: 'opening',
      header: '开场',
      question: '前 15 秒希望用哪种钩子？',
      options: [
        { label: '直接抛核心反差数据', description: '3 秒直入结论', recommended: true },
        { label: '先抛悬念问题', description: '适合故事感节奏' },
      ],
    },
    {
      id: 'focus',
      header: '重点章节',
      question: '哪些部分需要重点展开？',
      multi_select: true,
      options: [{ label: '原理拆解' }, { label: '实测对比' }],
    },
  ],
};

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('QuestionCard', () => {
  test('supports single-select, multi-select + custom other, global note, and clears draft after submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<QuestionCard ask={sampleAsk} onSubmit={onSubmit} />);

    expect(screen.getByText('推荐')).toBeTruthy();
    expect(screen.getByText('3 秒直入结论')).toBeTruthy();
    const submitBtn = screen.getByRole('button', { name: /提交全部回答/ });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('radio', { name: /直接抛核心反差数据/ }));
    await user.click(screen.getByRole('checkbox', { name: /原理拆解/ }));
    await user.click(screen.getByRole('checkbox', { name: /其他（自定义填写）/ }));
    await user.type(screen.getByLabelText('重点章节自定义回答'), '保留小数点后一位');
    await user.click(screen.getByRole('button', { name: /\+ 添加补充说明/ }));
    await user.type(screen.getByLabelText('补充说明'), '封面不超过 10 字');

    expect(screen.getByText('已答 2/2 题')).toBeTruthy();
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
    await user.click(submitBtn);

    expect(onSubmit).toHaveBeenCalledWith({
      status: 'answered',
      answers: [
        { question_id: 'opening', label: '开场', selected: ['直接抛核心反差数据'] },
        { question_id: 'focus', label: '重点章节', selected: ['原理拆解'], other: '保留小数点后一位' },
      ],
      note: '封面不超过 10 字',
    });
    expect(window.sessionStorage.getItem('onset:qdraft:q-req-1')).toBeNull();
  });

  test('defaults to step mode for 4+ questions, toggles to all mode, and restores drafts from sessionStorage', async () => {
    const fourAsk: QuestionAsk = {
      id: 'q-four',
      questions: Array.from({ length: 4 }, (_, i) => ({
        id: `q${i + 1}`,
        header: `维度${i + 1}`,
        question: `第 ${i + 1} 题？`,
        options: [{ label: `方案 ${i + 1}A` }, { label: `方案 ${i + 1}B` }],
      })),
    };
    const user = userEvent.setup();
    const view = render(<QuestionCard ask={fourAsk} onSubmit={vi.fn()} />);

    expect(screen.getByText('1. 第 1 题？')).toBeTruthy();
    expect(screen.queryByText('4. 第 4 题？')).toBeNull();
    await user.click(screen.getByRole('radio', { name: '方案 1A' }));
    // 单选后在步进模式自动跳到下一题。
    expect(screen.getByText('2. 第 2 题？')).toBeTruthy();

    // 切到全部展开模式能同时看到全部 4 题。
    await user.click(screen.getByRole('button', { name: '全部' }));
    expect(screen.getByText('4. 第 4 题？')).toBeTruthy();

    // 模拟重挂载：已勾选草稿自动恢复。
    view.unmount();
    render(<QuestionCard ask={fourAsk} onSubmit={vi.fn()} />);
    expect(screen.getByText('已答 1/4 题')).toBeTruthy();
  });

  test('integrates with Chat SSE stream: mid-turn submit, history summary expand, and skip focus escape hatch', async () => {
    const submitted: unknown[] = [];
    const studio = createStudio({
      routes: {
        'POST /api/sessions/s1/questions/q-req-1': (req: { body: unknown }) => {
          submitted.push(req.body);
          return { ok: true, mode: 'live' };
        },
        'POST /api/sessions/s1/questions/q-skip': (req: { body: unknown }) => {
          submitted.push(req.body);
          return { ok: true, mode: 'live' };
        },
      },
    });
    studio.render();
    await screen.findByText('说说要做什么');
    const user = userEvent.setup();
    await user.type(document.getElementById('prompt')!, '开始规划');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/turns')).toBe(1));

    await studio.emit([...turnStart('t1', '开始规划'), { kind: 'question', turn_id: 't1', question: sampleAsk }]);
    const card = document.querySelector('.question-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(screen.getByText('等待你回答问题')).toBeTruthy();

    await user.click(within(card).getByRole('radio', { name: /直接抛核心反差数据/ }));
    await user.click(within(card).getByRole('checkbox', { name: /实测对比/ }));
    await user.click(within(card).getByRole('button', { name: /提交全部回答/ }));
    await waitFor(() => expect(submitted).toHaveLength(1));

    await studio.emit([
      {
        kind: 'question-resolved',
        turn_id: 't1',
        question: {
          id: 'q-req-1',
          status: 'answered',
          answers: [
            { question_id: 'opening', label: '开场', selected: ['直接抛核心反差数据'] },
            { question_id: 'focus', label: '重点章节', selected: ['实测对比'] },
          ],
        },
      },
      ...turnDone('t1', '收到选择，已按你的要求继续完成规划。'),
    ]);
    expect(document.querySelector('.question-card')).toBeNull();
    const summary = document.querySelector('[data-question-summary="q-req-1"]') as HTMLElement;
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain('已确认 2 项');
    await user.click(within(summary).getByRole('button', { name: '查看原题' }));
    expect(summary.textContent).toContain('前 15 秒希望用哪种钩子？');

    // 测试跳过逃生口：立刻回传 skipped 并把焦点还给输入框。
    await studio.emit([
      ...turnStart('t2', '再问一次'),
      {
        kind: 'question',
        turn_id: 't2',
        question: {
          id: 'q-skip',
          questions: [{ id: 'q1', question: '确认吗？', options: [{ label: '是' }, { label: '否' }] }],
        },
      },
    ]);
    await user.click(screen.getByRole('button', { name: '跳过，改手动输入' }));
    await waitFor(() => expect(submitted).toHaveLength(2));
    expect(submitted[1]).toMatchObject({ status: 'skipped' });
    expect(document.activeElement?.id).toBe('prompt');
  });
});
