// 估算朗读时间：纯函数，不开客户端（原来写在 e2e/script-playback.spec.mjs 里）。
import { expect, test } from 'vitest';
import { estimateScriptTiming } from './scriptTiming.ts';

test('estimated reading preserves nested markup, silent text and paragraph offsets', () => {
  const input = [
    { kind: 'heading', text: '不参与朗读' },
    { kind: 'para', nodes: [{ kind: 'text', text: '你好，' }, { kind: 'phrase', id: 'year', children: [{ kind: 'alt', text: '2025', spoken: '二零二五' }] }, { kind: 'alt', text: '注', spoken: '' }] },
    { kind: 'para', nodes: [{ kind: 'alt', spoken: '嗯' }, { kind: 'text', text: '世界。' }] },
  ];
  const out = estimateScriptTiming(input, 9);
  expect(out[0]).toEqual(input[0]);
  expect(out[1].nodes[0].timings).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, null]);
  expect(out[1].nodes[1].children[0].timings).toHaveLength(4);
  expect(out[1].nodes[2].timings).toEqual([null]);
  expect(out[2].nodes[0].timings).toEqual([{ start: 6, end: 7 }]);
  expect(out[2].nodes[1].timings).toEqual([{ start: 7, end: 8 }, { start: 8, end: 9 }, null]);
  expect(input[1].nodes[0].timings).toBeUndefined();
});
