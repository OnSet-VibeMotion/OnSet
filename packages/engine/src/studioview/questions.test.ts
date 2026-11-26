import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatQuestionAnswers,
  listQuestionRequests,
  normalizeQuestionInput,
  normalizeQuestionResponse,
  waitQuestionResponse,
  writeQuestionRequest,
  writeQuestionResponse,
} from './questions';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-studioview-q-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('studioview questions schema & inbox', () => {
  it('validates and normalizes multi-question inputs with deduplicated ids and camelCase tolerance', () => {
    const got = normalizeQuestionInput({
      title: ' 开工前确认 ',
      questions: [
        {
          id: 'tone',
          header: '节奏',
          question: '整体节奏偏哪种？',
          options: [
            { label: '冷静克制', description: '高信息密度', recommended: true },
            { label: '轻松聊天' },
            { label: '冷静克制' }, // 去重
          ],
        },
        {
          id: 'tone', // 重名自动消重
          question: '重点保留哪些模块？',
          multiSelect: true,
          allowOther: true,
          options: ['原理拆解', '实测对比'],
        },
      ],
    });
    expect(got.title).toBe('开工前确认');
    expect(got.questions.map((q) => q.id)).toEqual(['tone', 'tone_2']);
    expect(got.questions[0].options).toEqual([
      { label: '冷静克制', description: '高信息密度', recommended: true },
      { label: '轻松聊天' },
    ]);
    expect(got.questions[1].multi_select).toBe(true);
    expect(got.questions[1].options.map((o) => o.label)).toEqual(['原理拆解', '实测对比']);

    expect(() => normalizeQuestionInput({ questions: [] })).toThrow(/至少提供 1 个问题/);
    expect(() =>
      normalizeQuestionInput({ questions: Array.from({ length: 7 }, () => ({ question: 'q', options: ['a', 'b'] })) }),
    ).toThrow(/最多提 6 个问题/);
    expect(() => normalizeQuestionInput({ questions: [{ question: 'q', options: ['only-one'] }] })).toThrow(
      /至少需要 2 个不同选项/,
    );
  });

  it('validates required answers, combines multi-select with other text, and formats readable summaries', () => {
    const req = writeQuestionRequest(tmp, {
      title: '制作规格',
      questions: [
        {
          id: 'opening',
          header: '开场',
          question: '选哪种开场？',
          options: [{ label: '数据反差' }, { label: '故事悬念' }],
        },
        {
          id: 'focus',
          header: '重点',
          question: '保留哪些章节？',
          multi_select: true,
          options: [{ label: '原理' }, { label: '案例' }],
        },
        {
          id: 'extra',
          header: '可选',
          question: '附加需求？',
          required: false,
          options: [{ label: '加字幕' }, { label: '不加' }],
        },
      ],
    });
    expect(() =>
      normalizeQuestionResponse(req, {
        status: 'answered',
        answers: [{ question_id: 'opening', selected: ['数据反差'] }],
      }),
    ).toThrow(/重点/);

    const resp = normalizeQuestionResponse(req, {
      status: 'answered',
      answers: [
        { question_id: 'opening', selected: ['数据反差'] },
        { question_id: 'focus', selected: ['原理', '案例'], other: '加一页结论对比' },
      ],
      note: '封面控制在 10 字以内',
    });
    expect(resp.answer_map).toEqual({
      opening: '数据反差',
      focus: ['原理', '案例', '加一页结论对比'],
    });
    const text = formatQuestionAnswers(req, resp);
    expect(text).toContain('已完成「制作规格」（2/3 题）');
    expect(text).toContain('1. [开场]：数据反差');
    expect(text).toContain('2. [重点]：原理、案例；补充：加一页结论对比');
    expect(text).toContain('补充说明：封面控制在 10 字以内');
  });

  it('wakes up immediately when a response file arrives and ignores duplicate writes', async () => {
    const req1 = writeQuestionRequest(tmp, { questions: [{ question: 'Q1', options: ['A', 'B'] }] });
    const req2 = writeQuestionRequest(tmp, { questions: [{ question: 'Q2', options: ['C', 'D'] }] });
    expect(listQuestionRequests(tmp).map((x) => x.request.id)).toEqual([req1.id, req2.id]);

    const waiting = waitQuestionResponse(tmp, req1.id, 10);
    setTimeout(() => {
      expect(writeQuestionResponse(tmp, req1.id, { status: 'answered', answer_map: { q1: 'A' } })).toBe(true);
      expect(writeQuestionResponse(tmp, req1.id, { status: 'skipped' })).toBe(false);
    }, 20);
    const outcome = await waiting;
    expect(outcome).toEqual({ kind: 'response', response: { status: 'answered', answer_map: { q1: 'A' } } });
  });

  it('writes deferred marker when timeoutMs elapses and exits promptly on abort', async () => {
    const req = writeQuestionRequest(tmp, { questions: [{ question: 'Q1', options: ['A', 'B'] }] });
    const deferred = await waitQuestionResponse(tmp, req.id, 10, undefined, 25);
    expect(deferred).toEqual({ kind: 'deferred' });
    expect(listQuestionRequests(tmp)[0]).toMatchObject({ answered: false, deferred: true });

    const req2 = writeQuestionRequest(tmp, { questions: [{ question: 'Q2', options: ['A', 'B'] }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);
    expect(await waitQuestionResponse(tmp, req2.id, 10, controller.signal, 5000)).toEqual({ kind: 'aborted' });
  });
});
