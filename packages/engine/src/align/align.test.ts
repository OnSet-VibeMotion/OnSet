import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameOf, totalFrames } from '../beat';
import { build, type Options, type Result } from './build';
import { formatSRT } from './cue';
import { loadEvidence, loadSegments, parseSegmentFlag, type Item } from './evidence';
import { LabelExact, LabelInsertion, LabelMerge, LabelOmission, LabelReplace } from './match';
import { SourceAdjusted, SourceForced, SourceInterpolated, loadAdjust, loadExistingTimeline, type Adjustment, type Timeline } from './phrase';
import { VocalEvents, parseScript, type Script } from './script';
import { tokenize } from './token';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-align-'));

/**
 * heard 把一段文本按匹配单元切开，每个单元占 step 秒，从 start 开始首尾相接，
 * 模拟对齐工具的逐字输出（标点已丢）。
 */
function heard(text: string, start: number, step: number): Item[] {
  const items: Item[] = [];
  for (const t of tokenize(text)) {
    items.push({ text: t.text, start, end: start + step, segment: 0 });
    start += step;
  }
  return items;
}

const item = (text: string, start: number, end: number): Item => ({ text, start, end, segment: 0 });

function mustBuild(script: Script, items: Item[] | null, opts: Partial<Options> = {}): Result {
  return build(script, items, { ...opts, fps: opts.fps || 30 });
}

const contains = (list: string[], sub: string): boolean => list.some((s) => s.includes(sub));
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

function writeFile(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

describe('parse', () => {
  const cases: { name: string; input: string; spoken: string; phrases: Record<string, string> }[] = [
    { name: '标题与分段', input: '# 标题\n第一段。\n\n第二段\n接着写。\n', spoken: '第一段。\n第二段接着写。\n', phrases: {} },
    { name: '显示与朗读', input: '<2024年|二零二四年>发布', spoken: '二零二四年发布\n', phrases: {} },
    { name: '只读与只显示', input: '好<|嗯>的<（注）|>。', spoken: '好嗯的。\n', phrases: {} },
    { name: '转义', input: 'a\\<b\\>c\\@d\\|e\\\\f', spoken: 'a<b>c@d|e\\f\n', phrases: {} },
    { name: '段内换行补空格', input: 'hello\nworld\n中\n文', spoken: 'hello world中文\n', phrases: {} },
    { name: '嵌套短语', input: '@{outer}先@{inner}说@{/inner}完@{/outer}。', spoken: '先说完。\n', phrases: { outer: '先说完', inner: '说' } },
    { name: '短语里的标记', input: '@{year}<2024年|二零二四年>@{/year}', spoken: '二零二四年\n', phrases: { year: '2024年' } },
    { name: '不成标记的 @', input: '邮件 a@b.c', spoken: '邮件 a@b.c\n', phrases: {} },
  ];
  for (const tc of cases) {
    it(`markup: ${tc.name}`, () => {
      const s = parseScript(tc.input);
      expect(s.spokenText()).toBe(tc.spoken);
      expect(s.phrases.length).toBe(Object.keys(tc.phrases).length);
      for (const p of s.phrases) expect(s.displayText(p.startPiece, p.endPiece)).toBe(tc.phrases[p.id]);
    });
  }

  it('orders phrases', () => {
    const s = parseScript('@{a}@{b}甲@{/b}乙@{/a}@{c}丙@{/c}');
    const want = ['a', 'b', 'c'];
    s.phrases.forEach((p, i) => {
      expect(p.id).toBe(want[i]);
      expect(p.order).toBe(i + 1);
    });
  });

  // 行首的 # 是标题、整行丢掉；正文的话题要写成 \#，在 <显示|朗读> 里也一样。行中间的 # 不用转义。
  it('escapes a leading hash so a topic line is not dropped as a heading', () => {
    const s = parseScript('大家好。\n\n\\#OiiOii\n\n带上 <\\#OiiOii|话题 OiiOii>，或者 #OiiOii 也行。\n\n#OiiOii\n');
    expect(s.spokenText()).toBe('大家好。\n#OiiOii\n带上 话题 OiiOii，或者 #OiiOii 也行。\n');
    expect(s.headings.map((h) => h.text)).toEqual(['OiiOii']);
    expect(() => parseScript('\\x')).toThrow('只能转义');
  });

  it('errors carry position', () => {
    const cases: [string, string][] = [
      ['好<显示朗读>', '第 1 行第 2 列'],
      ['好\n  <a|b', '第 2 行第 3 列'],
      ['<a|b|c>', '第 1 行第 5 列'],
      ['<|>', '两侧都是空的'],
      ['x\\y', '第 1 行第 2 列：无效转义'],
      ['@{A}x@{/A}', '不合法'],
      ['@{a}x@{/a}@{a}y@{/a}', '重复'],
      ['@{a}x', '第 1 行第 1 列：短语 @{a} 没有闭合'],
      ['x@{/a}', '没有对应'],
      ['@{a}x@{b}y@{/a}@{/b}', '交叉'],
      ['@{a}@{/a}', '是空的'],
      ['@{a', '缺少 }'],
    ];
    for (const [input, want] of cases) expect(() => parseScript(input), input).toThrow(want);
  });

  it('tokenizes mixed text', () => {
    const got = tokenize("GPT-4 在2024年发布，价格3.5美元；don't ＡＢＣ v2.");
    expect(got.map((t) => t.text).join('|')).toBe("GPT-4|在|2024|年|发|布|价|格|3.5|美|元|don't|ＡＢＣ|v2");
    expect(got.map((t) => t.norm).join('|')).toBe('gpt4|在|2024|年|发|布|价|格|35|美|元|dont|abc|v2');
  });
});

describe('build', () => {
  it('exact match', () => {
    const s = parseScript('@{hi}你好@{/hi}，世界。再见！');
    const r = mustBuild(s, heard('你好世界再见', 1.0, 0.1));
    expect(r.report.ok && r.report.match_rate === 1 && r.report.labels[LabelExact] === 6, JSON.stringify(r.report)).toBe(true);
    expect(r.cues.length).toBe(2);
    expect([r.cues[0].text, r.cues[0].startMs, r.cues[0].endMs]).toEqual(['你好，世界。', 1000, 1400]);
    expect([r.cues[1].text, r.cues[1].startMs, r.cues[1].endMs]).toEqual(['再见！', 1400, 1600]);
    const p = r.timeline.phrases![0];
    expect(p).toMatchObject({
      start_ms: 1000,
      end_ms: 1200,
      start_frame: 30,
      end_frame_exclusive: 36,
      alignment_source: SourceForced,
      confidence: 1,
      subtitle_index: 1,
      source_text: '你好',
    });
    expect(p.visible_event_ids, 'visible_event_ids 应写成 [] 而不是 null').toEqual([]);
  });

  it('replaced char is a hint', () => {
    const s = parseScript('今天@{w}天气@{/w}很好，我们一起出去走走吧。');
    const r = mustBuild(s, heard('今天天汽很好我们一起出去走走吧', 0, 0.2));
    expect(r.report.problems, '单字读错不应判为问题').toEqual([]);
    expect(r.report.labels[LabelReplace]).toBe(1);
    expect(contains(r.report.hints, '对上的是「汽」'), String(r.report.hints)).toBe(true);
    const p = r.timeline.phrases![0];
    expect(p.confidence).toBe(0.75);
    expect(p.alignment_source).toBe(SourceForced);
    expect(contains(r.report.hints, '置信度 0.75')).toBe(true);
    // 读错的字仍然拿到实测时间：第 4 个单元 0.6–0.8 秒。
    const tok = r.tokens[3];
    expect(!tok.interpolated && near(tok.start, 0.6) && near(tok.end, 0.8), JSON.stringify(tok)).toBe(true);
  });

  it('omitted word in phrase is a problem', () => {
    const s = parseScript('我们明天@{when}早上八点@{/when}出发去北京看看那里的风景和朋友们。');
    const r = mustBuild(s, heard('我们明天出发去北京看看那里的风景和朋友们', 0, 0.2));
    expect(!r.report.ok && contains(r.report.problems, '短语 when'), String(r.report.problems)).toBe(true);
    const p = r.timeline.phrases![0];
    expect(p.alignment_source).toBe(SourceInterpolated);
    expect(p.confidence).toBe(0);
    // 漏读的四个字被挤在「天」与「出」之间的零宽缝里，起止都在 0.8 秒。
    expect([p.start_ms, p.end_ms, p.end_frame_exclusive]).toEqual([800, 800, p.start_frame + 1]);
    expect(r.report.labels[LabelOmission]).toBe(4);
  });

  it('interpolates across a gap by char count', () => {
    const s = parseScript('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉。');
    const items = [...heard('甲乙丙丁戊己庚辛壬癸', 0, 0.1), ...heard('寅卯辰巳午未申酉', 1.6, 0.1)];
    const r = mustBuild(s, items);
    const [a, b] = [r.tokens[10], r.tokens[11]];
    expect(a.interpolated && b.interpolated && near(a.start, 1.0) && near(b.end, 1.6) && near(a.end, 1.3), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(true);
  });

  it('inserted token is a hint', () => {
    const s = parseScript('@{p}今天我们讲对齐@{/p}。');
    const items = [...heard('今天', 0, 0.2), item('嗯', 0.4, 0.6), ...heard('我们讲对齐', 0.6, 0.2)];
    const r = mustBuild(s, items);
    expect(r.report.problems).toEqual([]);
    expect(r.report.labels[LabelInsertion]).toBe(1);
    expect(contains(r.report.hints, '配音里多出「嗯」（0.40 秒）'), String(r.report.hints)).toBe(true);
    const p = r.timeline.phrases![0];
    expect(p.confidence).toBe(1);
    expect(p.end_ms).toBe(1600);
  });

  it('digits spoken as Chinese', () => {
    const s = parseScript('@{year}<2024|二零二四>年@{/year}发布了新版本。');
    const r = mustBuild(s, heard('二零二四年发布了新版本', 2, 0.1));
    expect(r.report.ok && r.report.match_rate === 1).toBe(true);
    expect(r.cues[0].text).toBe('2024年发布了新版本。');
    const p = r.timeline.phrases![0];
    expect([p.source_text, p.start_ms, p.end_ms]).toEqual(['2024年', 2000, 2500]);
  });

  it('spelled acronym merges', () => {
    const s = parseScript('调用<API|A P I>接口完成对齐任务。');
    const r = mustBuild(s, heard('调用API接口完成对齐任务', 0, 0.1));
    expect(r.report.labels[LabelMerge]).toBe(3);
    expect(r.report.ok).toBe(true);
    expect(near(r.tokens[2].start, 0.2) && near(r.tokens[4].end, 0.3) && near(r.tokens[3].start, 0.2 + 0.1 / 3)).toBe(true);
  });

  it('low match rate is a problem', () => {
    const r = mustBuild(parseScript('今天天气很好。'), heard('明年风雨太差', 0, 0.1));
    expect(!r.report.ok && contains(r.report.problems, '匹配率')).toBe(true);
  });

  it('empty evidence is a problem', () => {
    const r = mustBuild(parseScript('你好。'), null);
    expect(!r.report.ok && contains(r.report.problems, '没有任何可用')).toBe(true);
  });
});

describe('evidence', () => {
  const cases: { name: string; body: string; want: [string, number, number][] }[] = [
    { name: '规范形状', body: '[{"text":"你","start":0.1,"end":0.2},{"text":"好","start":0.2,"end":0.35}]', want: [['你', 0.1, 0.2], ['好', 0.2, 0.35]] },
    { name: 'funasr', body: '[{"key":"voice","text":"你 好","timestamp":[[100,200],[200,350]]}]', want: [['你', 0.1, 0.2], ['好', 0.2, 0.35]] },
    { name: '嵌套与毫秒字段', body: '{"language":"zh","segments":[{"word":"你","start_ms":100,"end_ms":200}]}', want: [['你', 0.1, 0.2]] },
    { name: 'start_time', body: '{"items":[{"char":"你","start_time":0.1,"end_time":0.2}]}', want: [['你', 0.1, 0.2]] },
  ];
  for (const tc of cases) {
    it(`loads shape: ${tc.name}`, () => {
      const items = loadEvidence(writeFile(tempDir(), 'a.json', tc.body));
      expect(items.length).toBe(tc.want.length);
      items.forEach((got, i) => {
        expect(got.text).toBe(tc.want[i][0]);
        expect(Math.abs(got.start - tc.want[i][1])).toBeLessThan(1e-9);
        expect(Math.abs(got.end - tc.want[i][2])).toBeLessThan(1e-9);
      });
    });
  }

  it('rejects unknown and bad shapes', () => {
    const dir = tempDir();
    const cases: [string, string][] = [
      ['{"result":{"foo":1},"text":"你好"}', '键：result, text'],
      ['[{"text":"你 好","timestamp":[[0,100]]}]', '无法逐一对应'],
      ['[{"text":"你","start":0.3,"end":0.1}]', '起止时间不合法'],
      ['[{"text":"你","start":100,"end":30000}]', '像是毫秒'],
    ];
    for (const [body, want] of cases) {
      let message = '';
      try {
        loadEvidence(writeFile(dir, 'bad.json', body));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, body).toContain(want);
      if (want.includes('键')) expect(message, '认不出时应给出规范形状').toContain('"start"');
    }
  });

  it('segments are shifted by offset', () => {
    const dir = tempDir();
    const first = writeFile(dir, 'align-01.json', '[{"text":"你","start":0,"end":0.2},{"text":"好","start":0.2,"end":0.4}]');
    const second = writeFile(dir, 'align-02.json', '[{"text":"世","start":0,"end":0.2},{"text":"界","start":0.2,"end":0.4}]');
    const seg2 = parseSegmentFlag(second + '@10.5');
    let items = loadSegments([{ path: first, offset: 0 }, seg2]);
    let r = mustBuild(parseScript('你好。世界。'), items);
    expect(r.report.ok).toBe(true);
    expect([r.cues[1].startMs, r.cues[1].endMs]).toEqual([10500, 10900]);
    expect(r.report.total_frames).toBe(totalFrames(10.9, 30));
    // 偏移写错导致两段重叠，判为问题。
    seg2.offset = 0.1;
    items = loadSegments([{ path: first, offset: 0 }, seg2]);
    r = mustBuild(parseScript('你好。世界。'), items);
    expect(!r.report.ok && contains(r.report.problems, '偏移写错'), String(r.report.problems)).toBe(true);
    for (const bad of ['a.json@x', '@1', 'a.json@-1']) expect(() => parseSegmentFlag(bad), bad).toThrow();
  });
});

describe('adjust', () => {
  const script = '@{a}你好@{/a}，@{b}世界@{/b}。';
  const items = heard('你好世界', 1, 0.25); // 1.0–2.0 秒，全片 60 帧
  const adj = (phrase_id: string, edge: string, frame: number, reason: string): Adjustment => ({ phrase_id, edge, frame, reason });
  const cases: [string, Adjustment[], string][] = [
    ['未知短语', [adj('x', 'start', 1, 'r')], '没有这个短语'],
    ['边界名', [adj('a', 'middle', 1, 'r')], 'edge 只能是'],
    ['空理由', [adj('a', 'start', 1, ' ')], 'reason 不能为空'],
    ['重复', [adj('a', 'start', 31, 'r'), adj('a', 'start', 32, 'r')], '重复修正'],
    ['越界', [adj('a', 'start', 60, 'r')], '超出'],
    ['负帧', [adj('a', 'end', -1, 'r')], '超出'],
    ['起点不早于终点', [adj('a', 'start', 45, 'r')], '不早于终点'],
  ];
  for (const [name, adjustments, want] of cases) {
    it(`rejects: ${name}`, () => {
      expect(() => build(parseScript(script), items, { fps: 30, adjust: { schema: 1, adjustments } })).toThrow(want);
    });
  }

  it('applies the adjust layer', () => {
    const r = mustBuild(parseScript(script), items, { adjust: { schema: 1, adjustments: [adj('b', 'end', 60, '尾音被对齐截短')] } });
    const [a, b] = r.timeline.phrases!;
    expect(a.alignment_source).toBe(SourceForced);
    expect(a.reviewed).toBe(false);
    expect(b).toMatchObject({ alignment_source: SourceAdjusted, reviewed: true, end_frame_exclusive: 60, end_ms: 2000, start_frame: 45 });
    const stat = r.report.phrases[1];
    expect([stat.measured_end_frame_exclusive, stat.end_frame_exclusive]).toEqual([60, 60]);
  });

  it('loadAdjust rejects unknown fields and schema', () => {
    const dir = tempDir();
    expect(() => loadAdjust(writeFile(dir, 'a.json', '{"schema":1,"adjustments":[{"phrase_id":"a","edge":"start","frame":1,"reason":"r","note":1}]}'))).toThrow();
    expect(() => loadAdjust(writeFile(dir, 'b.json', '{"schema":2,"adjustments":[]}'))).toThrow();
  });
});

describe('timeline', () => {
  it('existing timeline fields are preserved', () => {
    const blank = { subtitle_index: 0, source_text: '', semantic_order: 0, start_ms: 0, end_ms: 0, start_frame: 0, end_frame_exclusive: 0, alignment_source: '', confidence: 0, reviewed: false };
    const existing: Timeline = {
      schema: 1,
      fps: 30,
      phrases: [
        { ...blank, phrase_id: 'a', reviewed: true, visible_event_ids: ['title-1'], start_frame: 999 },
        { ...blank, phrase_id: 'gone', visible_event_ids: ['card-2'] },
      ],
    };
    const r = mustBuild(parseScript('@{a}你好@{/a}，@{b}世界@{/b}。'), heard('你好世界', 0, 0.1), { existing });
    const [a, b] = r.timeline.phrases!;
    expect(a.reviewed && a.visible_event_ids!.length === 1 && a.visible_event_ids![0] === 'title-1' && a.start_frame === 0).toBe(true);
    expect(b.reviewed).toBe(false);
    expect(b.visible_event_ids).toEqual([]);
    expect(r.timeline.phrases!.length).toBe(2);
    expect(contains(r.report.hints, '短语 gone 已不在终稿里') && contains(r.report.hints, 'card-2'), String(r.report.hints)).toBe(true);
  });

  it('loadExistingTimeline', () => {
    const dir = tempDir();
    expect(loadExistingTimeline(path.join(dir, 'none.json'))).toBeNull();
    expect(() => loadExistingTimeline(writeFile(dir, 'bad.json', '{"phrases":"x"}'))).toThrow();
  });
});

describe('cues', () => {
  it('segments cues', () => {
    const long = '第一部分说的是背景和来由，第二部分说的是方法与步骤，第三部分说的是结果和后续的计划安排。';
    const s = parseScript('开头一句！「引号里的话。」然后\n\n' + long);
    const r = mustBuild(s, heard(s.tokens.map((t) => t.text).join(''), 0, 0.1));
    expect(r.cues.map((c) => c.text)).toEqual([
      '开头一句！',
      '「引号里的话。」',
      '然后',
      '第一部分说的是背景和来由，第二部分说的是方法与步骤，',
      '第三部分说的是结果和后续的计划安排。',
    ]);
    for (let i = 1; i < r.cues.length; i++) {
      expect(r.cues[i].startMs).toBeGreaterThanOrEqual(r.cues[i - 1].endMs);
      expect(r.cues[i].index).toBe(i + 1);
    }
    expect(formatSRT(r.cues.slice(0, 1))).toBe('1\n00:00:00,000 --> 00:00:00,400\n开头一句！\n');
  });

  it('clamps overlap and absorbs silent text', () => {
    const s = parseScript('甲。<|嗯>乙。<图|>');
    const r = mustBuild(s, [item('甲', 0, 0.5), item('嗯', 0.4, 0.6), item('乙', 0.6, 0.8)]);
    expect(r.cues.length).toBe(2);
    expect(r.cues[1].text).toBe('乙。图');
    expect(r.cues[1].startMs).toBe(500);
    expect(r.cues[0].endMs).toBe(500);
  });

  it('phrase frames use beat.frameOf', () => {
    const s = parseScript('@{p}一二三@{/p}。');
    const items = [item('一', 0.517, 0.6), item('二', 0.6, 0.7), item('三', 0.7, 0.718)];
    for (const fps of [24, 25, 30, 60]) {
      const p = mustBuild(s, items, { fps }).timeline.phrases![0];
      expect(p.start_frame, `fps ${fps}`).toBe(frameOf(0.517, fps));
      expect(p.end_frame_exclusive, `fps ${fps}`).toBe(Math.max(frameOf(0.718, fps), p.start_frame + 1));
    }
  });

  it('display-only phrase is a problem', () => {
    const r = mustBuild(parseScript('你好@{pic}<【图】|>@{/pic}世界。'), heard('你好世界', 0, 0.1));
    expect(!r.report.ok && contains(r.report.problems, '没有朗读内容')).toBe(true);
    const p = r.timeline.phrases![0];
    expect(p.start_ms).toBe(200);
    expect(p.end_frame_exclusive).toBe(p.start_frame + 1);
  });

  it('matching is deterministic on long input', () => {
    const s = parseScript('我们今天讨论强制对齐的实现细节，'.repeat(300) + '完。');
    const spoken = s.tokens
      .filter((_, i) => i % 97 !== 5) // 隔一段漏读一个字
      .map((t) => t.text)
      .join('');
    const items = heard(spoken, 0, 0.05);
    const first = mustBuild(s, items);
    const second = mustBuild(s, items);
    expect(first.report.labels[LabelOmission]).toBeGreaterThan(0);
    expect(first.report.match_rate).toBeGreaterThanOrEqual(0.95);
    first.tokens.forEach((t, i) => {
      expect(t.start).toBe(second.tokens[i].start);
      expect(t.label).toBe(second.tokens[i].label);
    });
  });
});

describe('vocal events', () => {
  const script = '<|[叹气]>很多人以为，学会一门技术最难的是开始。<|[笑]>其实用 GPT 写个 demo 很容易，难的是坚持下去。\n';

  it('go to TTS but not to the aligner, the subtitles or the token list', () => {
    const s = parseScript(script);
    expect(s.hasVocalEvents()).toBe(true);
    expect(s.spokenText()).toBe('[叹气]很多人以为，学会一门技术最难的是开始。[笑]其实用 GPT 写个 demo 很容易，难的是坚持下去。\n');
    expect(s.alignText()).toBe('很多人以为，学会一门技术最难的是开始。其实用 GPT 写个 demo 很容易，难的是坚持下去。\n');
    expect(s.tokens.map((t) => t.text)).not.toContain('笑');
    expect(s.tokens.map((t) => t.text)).not.toContain('叹');
    // <|嗯> 这种只读不显示的口头语仍是朗读单元：它是字，不是事件。
    expect(parseScript('<|嗯>好的。').tokens.map((t) => t.text)).toEqual(['嗯', '好', '的']);
  });

  it('written bare they would show up in subtitles, so parsing refuses them', () => {
    for (const e of VocalEvents) expect(() => parseScript(`好的${e}，我们开始。`)).toThrow(`<|${e}>`);
    // 方括号、圆括号本身照常可以写。
    expect(() => parseScript('见附录[1]（详见第二章）。')).not.toThrow();
  });

  // 2026-11 实测：Breeze 合成的这一句（开头叹气、句中笑），对齐文本去掉事件后用 Qwen3-ForcedAligner 对齐的原始结果。
  it('builds subtitles from a real Breeze take, the laugh falling in the gap between sentences', () => {
    const items = loadEvidence(path.join(__dirname, 'testdata', 'breeze-events-align.json'));
    const r = mustBuild(parseScript(script), items);
    expect(r.report.ok, JSON.stringify(r.report)).toBe(true);
    expect(r.report.match_rate).toBe(1);
    const text = r.cues.map((c) => c.text).join('');
    expect(text).not.toContain('[');
    expect(text).not.toContain('笑]');
    // 叹气在 0–0.75 秒，第一条字幕从叹气之后的「很」开始。
    expect(r.cues[0].startMs).toBe(1040);
  });
});
