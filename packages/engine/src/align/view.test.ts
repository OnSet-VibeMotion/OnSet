// 移植自 internal/align/view_test.go。
import { expect, it } from 'vitest';
import { marshal } from '../gojson';
import { parseScript } from './script';
import { view } from './view';

it('view keeps headings, markup and nesting', () => {
  const script = parseScript('# 开场\n\n在 <2025年|二零二五年>，@{a}大模型@{b}<API|A P I>@{/b}@{/a}很贵<|嗯>。\n第二行\n\n## 正文\n\n@{c}跨\n\n段@{/c}\n');
  const { blocks, stats } = view(script);
  const want =
    '[{"kind":"heading","level":1,"text":"开场"},' +
    '{"kind":"para","nodes":[{"kind":"text","text":"在 "},{"kind":"alt","text":"2025年","spoken":"二零二五年"},{"kind":"text","text":"，"},' +
    '{"kind":"phrase","id":"a","children":[{"kind":"text","text":"大模型"},{"kind":"phrase","id":"b","children":[{"kind":"alt","text":"API","spoken":"A P I"}]}]},' +
    '{"kind":"text","text":"很贵"},{"kind":"alt","spoken":"嗯"},{"kind":"text","text":"。第二行"}]},' +
    '{"kind":"heading","level":2,"text":"正文"},' +
    '{"kind":"para","nodes":[{"kind":"phrase","id":"c","children":[{"kind":"text","text":"跨"}]}]},' +
    '{"kind":"para","nodes":[{"kind":"phrase","id":"c","children":[{"kind":"text","text":"段"}]}]}]';
  expect(marshal(blocks)).toBe(want);
  expect(stats.paragraphs).toBe(3);
  expect(stats.phrases).toBe(3);
  expect(stats.units).toBeGreaterThan(0);
});
