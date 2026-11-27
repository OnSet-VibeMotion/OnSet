import { describe, expect, test } from 'vitest';
import { parseChoices, stripChoices } from './proseParse.ts';
import { formatQuestionAnswersForChat, parseQuestionsBlock } from './questionParse.ts';

describe('questionParse & upgraded choices parser', () => {
  test('parses valid ```questions JSON blocks and strips them from prose', () => {
    const prose = `先确认两件事：\n\`\`\`questions\n${JSON.stringify({
      title: '制作规格',
      questions: [
        {
          id: 'opening',
          header: '开场',
          question: '前 15 秒怎么开场？',
          options: [{ label: '抛核心数据', description: '3 秒直入结论', recommended: true }, { label: '抛反常识问题' }],
        },
        {
          id: 'sections',
          header: '重点',
          question: '哪些章节放慢讲？',
          multi_select: true,
          options: [{ label: '原理拆解' }, { label: '实测对比' }],
        },
      ],
    })}\n\`\`\``;
    const parsed = parseQuestionsBlock(prose, 't1');
    expect(parsed).not.toBeNull();
    expect(parsed.id).toBe('prose-t1');
    expect(parsed.title).toBe('制作规格');
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[0].options[0]).toMatchObject({ label: '抛核心数据', recommended: true });
    expect(parsed.questions[1].multi_select).toBe(true);
    expect(parseChoices(prose)).toEqual([]);
    expect(stripChoices(prose)).toBe('先确认两件事：');
  });

  test('keeps malformed ```questions blocks visible instead of crashing', () => {
    const prose = '说明：\n```questions\n{not valid json\n```';
    expect(parseQuestionsBlock(prose, 'bad')).toBeNull();
    expect(stripChoices(prose)).toContain('{not valid json');
  });

  test('preserves single ```choices blocks as flat pills with relaxed 16-item cap', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `选项 ${i + 1}`).join('\n');
    const prose = `请选一个：\n\`\`\`choices\n${lines}\n\`\`\``;
    expect(parseQuestionsBlock(prose, 'single')).toBeNull();
    expect(parseChoices(prose)).toHaveLength(12);
    expect(stripChoices(prose)).toBe('请选一个：');
  });

  test('upgrades multiple ```choices blocks into a grouped multi-question card without dropping blocks', () => {
    const prose = [
      '1. 画面整体风格想选哪种？',
      '```choices',
      '深色科技风',
      '白板手绘风',
      '```',
      '',
      '2. 配音语速偏向？',
      '```choices',
      '自然沉稳',
      '紧凑偏快',
      '```',
    ].join('\n');
    const parsed = parseQuestionsBlock(prose, 'multi');
    expect(parsed).not.toBeNull();
    expect(parsed.questions.map((q) => q.question)).toEqual(['画面整体风格想选哪种？', '配音语速偏向？']);
    expect(parsed.questions.map((q) => q.options.map((o) => o.label))).toEqual([
      ['深色科技风', '白板手绘风'],
      ['自然沉稳', '紧凑偏快'],
    ]);
    expect(parseChoices(prose)).toEqual([]);
    expect(stripChoices(prose)).not.toContain('```choices');
  });

  test('formats multi-question answers cleanly for next-turn delivery', () => {
    const text = formatQuestionAnswersForChat(
      {
        title: '规格确认',
        questions: [
          { id: 'q1', header: '开场', question: '开场？', options: [{ label: 'A' }, { label: 'B' }] },
          {
            id: 'q2',
            header: '章节',
            question: '章节？',
            multi_select: true,
            options: [{ label: 'X' }, { label: 'Y' }],
          },
        ],
      },
      [
        { question_id: 'q1', label: '开场', selected: ['A'] },
        { question_id: 'q2', label: '章节', selected: ['X', 'Y'], other: '加总结页' },
      ],
      '封面简短',
    );
    expect(text).toContain('已完成「规格确认」（2/2 题）');
    expect(text).toContain('1. [开场]：A');
    expect(text).toContain('2. [章节]：X、Y；补充：加总结页');
    expect(text).toContain('补充说明：封面简短');
  });

  test('falls back to single choices pills when a second choices block has only 1 item and keeps unconsumed blocks', () => {
    const prose = '第一题：\n```choices\nA\nB\n```\n补充：\n```choices\n仅一项\n```';
    expect(parseQuestionsBlock(prose, 'partial')).toBeNull();
    expect(parseChoices(prose)).toEqual(['A', 'B']);
    expect(stripChoices(prose)).toContain('仅一项');
  });

  test('strips only the first valid ```questions block and preserves any subsequent block in prose', () => {
    const q1 = JSON.stringify({ questions: [{ question: '第一组？', options: ['A', 'B'] }] });
    const q2 = JSON.stringify({ questions: [{ question: '第二组？', options: ['C', 'D'] }] });
    const prose = `说明：\n\`\`\`questions\n${q1}\n\`\`\`\n补充：\n\`\`\`questions\n${q2}\n\`\`\``;
    const parsed = parseQuestionsBlock(prose, 'two');
    expect(parsed.questions[0].question).toBe('第一组？');
    const stripped = stripChoices(prose);
    expect(stripped).not.toContain('第一组？');
    expect(stripped).toContain('第二组？');
  });
});
