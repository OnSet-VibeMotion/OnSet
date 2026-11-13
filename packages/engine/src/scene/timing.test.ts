// 移植自 internal/scene/timing_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as beat from '../beat';
import { goRound } from '../gofmt';
import type * as srt from '../srt';
import { frameAlignmentTolerance } from './frames';
import { buildPrompt, load, optionalFields, type Scene } from './scene';
import { testPlanSHA, writeScene } from './testsupport';
import {
  CutMidGap,
  CutNextStart,
  CutPrevEnd,
  durationLiteral,
  handoffEqual,
  handoffIsZero,
  layoutTiming,
  newPlanEntry,
  parseTimingPlan,
  planHandoffs,
  segmentFrames,
  TimingPlanSchema,
  verifyStyleBoundaries,
  verifyTimingInputs,
  type PlanEntry,
  type PhraseTimeline,
  type TimingPlan,
  type TimingSegment,
} from './timing';
import { VerificationError } from './verification';

// 四条字幕：1 与 2 之间、3 与 4 之间各有一段空白，2 与 3 首尾相接。
// 30fps 下的帧区间：[0,30) [45,90) [90,120) [150,180)。
const testCues: srt.Cue[] = [
  { index: 1, start_seconds: 0, end_seconds: 1, text: '' },
  { index: 2, start_seconds: 1.5, end_seconds: 3, text: '' },
  { index: 3, start_seconds: 3, end_seconds: 4, text: '' },
  { index: 4, start_seconds: 5, end_seconds: 6, text: '' },
];

function planOf(...entries: PlanEntry[]): TimingPlan {
  return { schema: TimingPlanSchema, look: null, scenes: entries };
}

function entry(id: string, sub: number, cut: string): PlanEntry {
  return newPlanEntry({ id, dir: 'scenes/' + id, cut, first_subtitle: sub > 0 ? sub : null });
}

function spans(segments: TimingSegment[]): string {
  return segments.map((s) => `[${s.startFrame},${s.endFrameExclusive})`).join(' ');
}

function timedScene(duration: string, timing: string): Scene {
  const dir = writeScene(
    '{"id":"scene-001","duration_seconds":' + duration + ',"output":"out.mp4","transcript":"transcript.srt","text":"hello","timing":' + timing + '}',
  );
  return load(dir);
}

function catchError(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe('parseTimingPlan', () => {
  it('rejects malformed plans', () => {
    const cases: Record<string, string> = {
      '{"schema":2,"scenes":[{"id":"a","dir":"a"}]}': 'schema',
      '{"schema":1,"scenes":[]}': '为空',
      '{"schema":1,"scenes":[{"id":"a","dir":"a","extra":1}]}': '未知字段',
      '{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"b","dir":"b"}]}': '缺少锚点',
      '{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"b","dir":"b","first_subtitle":2,"first_phrase":"p"}]}': '只能填一个',
      '{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"b","dir":"b","first_subtitle":0}]}': '从 1 开始',
      '{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"b","dir":"b","first_subtitle":2,"cut":"later"}]}': 'cut 只能是',
      '{"schema":1,"scenes":[{"id":"a","dir":"a","cut":"mid_gap"}]}': '不能写 cut',
      '{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"a","dir":"b","first_subtitle":2}]}': 'id 重复',
      '{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"b","dir":"a","first_subtitle":2}]}': 'dir 重复',
      '{"schema":1,"scenes":[{"id":"","dir":"a"}]}': '缺少 id 或 dir',
      '{"schema":1,"scenes":[{"id":"a","dir":"a","visual_role":"装饰"}]}': 'visual_role 只能是',
      'not json': '不是合法 JSON',
    };
    for (const [body, want] of Object.entries(cases)) {
      expect(() => parseTimingPlan(body), body).toThrow(want);
    }
    const plan = parseTimingPlan(
      '{"schema":1,"scenes":[{"id":"a","dir":"a","visual_role":"语境","summary":"开场"},{"id":"b","dir":"b","first_phrase":"p-2","cut":"prev_end","visual_role":"证据"}]}',
    );
    expect(plan.scenes).toHaveLength(2);
    expect(plan.scenes![1].first_phrase).toBe('p-2');
    expect(plan.scenes![1].visual_role).toBe('证据');
  });

  it('validates chapters and handoffs', () => {
    const head = '{"schema":1,"scenes":[{"id":"a","dir":"a","chapter":"一"},';
    const cases: Record<string, string> = {
      [head + '{"id":"b","dir":"b","first_subtitle":2}]}']: '要么每个镜头都写',
      [head + '{"id":"b","dir":"b","first_subtitle":2,"chapter":"二"}]}']: '必须写 handoff',
      [head + '{"id":"b","dir":"b","first_subtitle":2,"chapter":"二","handoff":{"device":"wipe","bridge":"x"}}]}']: 'handoff.device 只能是',
      [head + '{"id":"b","dir":"b","first_subtitle":2,"chapter":"二","handoff":{"device":"pan","bridge":" "}}]}']: 'bridge 为空',
      [head + '{"id":"b","dir":"b","first_subtitle":2,"chapter":"二","handoff":{"device":"pan","bridge":"' + '长'.repeat(201) + '"}}]}']: '超过 200 字',
      ['{"schema":1,"scenes":[{"id":"a","dir":"a","handoff":{"device":"pan","bridge":"x"}}]}']: '不能写 handoff',
      ['{"schema":1,"look":{"background":"#000","ink":"#ffffff","accent":"#ffffff"},"scenes":[{"id":"a","dir":"a"}]}']: 'look.background 必须是 #RRGGBB',
      ['{"schema":1,"look":{"background":"#000000","accent":"#ffffff"},"scenes":[{"id":"a","dir":"a"}]}']: 'look.ink 必填',
      [head +
      '{"id":"b","dir":"b","first_subtitle":2,"chapter":"二","handoff":{"device":"pan","bridge":"底面"}},' +
      '{"id":"c","dir":"c","first_subtitle":3,"chapter":"三","handoff":{"device":"pan","bridge":"底面"}}]}']: '换一种手法',
    };
    for (const [body, want] of Object.entries(cases)) {
      expect(() => parseTimingPlan(body), body).toThrow(want);
    }
    // 章节内的交接可选；同一手法隔开一个章节交界后可以再用。
    const body =
      '{"schema":1,"look":{"background":"#0F1720","ink":"#F5F1E8","accent":"#F2B134"},"scenes":[' +
      '{"id":"a","dir":"a","chapter":"一"},' +
      '{"id":"b","dir":"b","first_subtitle":2,"chapter":"一","handoff":{"device":"carry","bridge":"左上角的计数器"}},' +
      '{"id":"c","dir":"c","first_subtitle":3,"chapter":"二","handoff":{"device":"flood","bridge":"满屏琥珀色"}},' +
      '{"id":"d","dir":"d","first_subtitle":4,"chapter":"三","handoff":{"device":"carry","bridge":" 中央的圆点 "}}]}';
    const plan = parseTimingPlan(body);
    const { enter, exit } = planHandoffs(plan);
    expect(handoffIsZero(enter[0]) && handoffIsZero(exit[3]), '首镜无入场、末镜无出场').toBe(true);
    expect(handoffEqual(enter[1], { peer: 'a', device: 'carry', bridge: '左上角的计数器', cross_chapter: false, style_shift: '', peer_film_style: '' }), '章节内入场').toBe(true);
    expect(handoffEqual(exit[2], { peer: 'd', device: 'carry', bridge: '中央的圆点', cross_chapter: true, style_shift: '', peer_film_style: '' }), '章节交界出场应去掉首尾空白并标记章节').toBe(true);
    expect(enter[2].peer).toBe('b');
    expect(exit[1].peer).toBe('c');
    expect(enter[2].bridge, '同一交界两侧应拿到同一份约定').toBe(exit[1].bridge);
  });

  // 风格交界：style_shift 写法与搭配、film_style 写法在解析时查；风格交界要不要写由 verifyStyleBoundaries 查，
  // 两侧的交接都带上对方 film_style 的原值。
  it('validates style shifts', () => {
    const head = '{"schema":1,"scenes":[{"id":"a","dir":"a"},';
    const cases: Record<string, string> = {
      [head + '{"id":"b","dir":"b","first_subtitle":2,"handoff":{"device":"carry","bridge":"x","style_shift":"fade"}}]}']: 'style_shift 只能是',
      [head + '{"id":"b","dir":"b","first_subtitle":2,"handoff":{"device":"carry","bridge":"x","style_shift":"window"}}]}']: '只能配 device push_in',
      [head + '{"id":"b","dir":"b","first_subtitle":2,"film_style":"oil"}]}']: 'film_style 只能是',
    };
    for (const [body, want] of Object.entries(cases)) {
      expect(() => parseTimingPlan(body), body).toThrow(want);
    }
    const body =
      '{"schema":1,"scenes":[' +
      '{"id":"a","dir":"a"},' +
      '{"id":"b","dir":"b","first_subtitle":2,"film_style":"beta/oil","handoff":{"device":"push_in","bridge":"相框里的油画铺满","style_shift":"window"}},' +
      '{"id":"c","dir":"c","first_subtitle":3,"film_style":"none","handoff":{"device":"match","bridge":"圆点","style_shift":"match_cut"}},' +
      '{"id":"d","dir":"d","first_subtitle":4,"film_style":"none"}]}';
    const plan = parseTimingPlan(body);
    const effective = (v: string) => (v === '' ? 'alpha/ink' : v === 'none' ? '' : v);
    expect(() => verifyStyleBoundaries(plan, effective)).not.toThrow();
    const { enter, exit } = planHandoffs(plan);
    expect(exit[0]).toMatchObject({ peer: 'b', style_shift: 'window', peer_film_style: 'beta/oil' });
    expect(enter[1]).toMatchObject({ peer: 'a', style_shift: 'window', peer_film_style: '' });
    expect(enter[2]).toMatchObject({ style_shift: 'match_cut', peer_film_style: 'beta/oil' });
    expect(handoffIsZero(enter[3])).toBe(true);

    // 默认风格换成 beta/oil 后，a→b 不再是风格交界，b→c 仍是。
    expect(() => verifyStyleBoundaries(plan, (v) => (v === '' ? 'beta/oil' : v === 'none' ? '' : v))).toThrow('不是风格交界，不要写 style_shift');
    const missing = parseTimingPlan('{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"b","dir":"b","first_subtitle":2,"film_style":"beta/oil"}]}');
    expect(() => verifyStyleBoundaries(missing, effective)).toThrow('风格交界必须写 handoff');
    const noShift = parseTimingPlan(
      '{"schema":1,"scenes":[{"id":"a","dir":"a"},{"id":"b","dir":"b","first_subtitle":2,"film_style":"beta/oil","handoff":{"device":"carry","bridge":"x"}}]}',
    );
    expect(() => verifyStyleBoundaries(noShift, effective)).toThrow('handoff 要写 style_shift');
  });
});

describe('layoutTiming', () => {
  it('cut modes', () => {
    const cases: Array<[cut: string, want: string]> = [
      ['', '[0,45) [45,200)'],
      [CutNextStart, '[0,45) [45,200)'],
      [CutPrevEnd, '[0,30) [30,200)'],
      [CutMidGap, '[0,37) [37,200)'],
    ];
    for (const [cut, want] of cases) {
      const segments = layoutTiming(planOf(entry('a', 0, ''), entry('b', 2, cut)), testCues, null, 30, 200);
      expect(spans(segments), `cut=${cut}`).toBe(want);
    }
  });

  // 2 与 3 首尾相接没有空白：三种规则都只能切在锚点开始处。
  it('cuts at the anchor without a gap', () => {
    for (const cut of [CutNextStart, CutPrevEnd, CutMidGap]) {
      const segments = layoutTiming(planOf(entry('a', 0, ''), entry('b', 3, cut)), testCues, null, 30, 200);
      expect(spans(segments), `cut=${cut}`).toBe('[0,90) [90,200)');
    }
  });

  it('sums to total and absorbs gaps', () => {
    const segments = layoutTiming(planOf(entry('a', 1, ''), entry('b', 2, ''), entry('c', 4, CutPrevEnd)), testCues, null, 30, 210);
    expect(spans(segments)).toBe('[0,45) [45,120) [120,210)');
    expect(segments.reduce((sum, s) => sum + segmentFrames(s), 0)).toBe(210);
  });

  it('phrase anchors', () => {
    // 文件里乱序：「前一条」按时间找，不按文件顺序。
    const phrases: PhraseTimeline = {
      fps: 30,
      phrases: [
        { phrase_id: 'p-3', source_text: '', start_frame: 100, end_frame_exclusive: 130 },
        { phrase_id: 'p-1', source_text: '', start_frame: 0, end_frame_exclusive: 40 },
        { phrase_id: 'p-2', source_text: '', start_frame: 50, end_frame_exclusive: 80 },
      ],
    };
    const plan = planOf(
      newPlanEntry({ id: 'a', dir: 'a' }),
      newPlanEntry({ id: 'b', dir: 'b', first_phrase: 'p-2', cut: CutMidGap }),
      newPlanEntry({ id: 'c', dir: 'c', first_phrase: 'p-3', cut: CutPrevEnd }),
    );
    expect(spans(layoutTiming(plan, testCues, phrases, 30, 150))).toBe('[0,45) [45,80) [80,150)');
  });

  it('rejects bad anchors', () => {
    const phrases: PhraseTimeline = { fps: 30, phrases: [{ phrase_id: 'p-1', source_text: '', start_frame: 0, end_frame_exclusive: 40 }] };
    const cases: Array<{ plan: TimingPlan; phrases: PhraseTimeline | null; total: number; want: string }> = [
      { plan: planOf(entry('a', 0, ''), entry('b', 3, ''), entry('c', 2, '')), phrases: null, total: 200, want: '严格递增' },
      { plan: planOf(entry('a', 0, ''), entry('b', 2, ''), entry('c', 2, '')), phrases: null, total: 200, want: '严格递增' },
      { plan: planOf(entry('a', 0, ''), entry('b', 9, '')), phrases: null, total: 200, want: '超出字幕范围' },
      { plan: planOf(entry('a', 0, ''), entry('b', 4, '')), phrases: null, total: 150, want: '不早于总帧数' },
      { plan: planOf(entry('a', 0, ''), entry('b', 1, '')), phrases: null, total: 200, want: '不足一帧' },
      { plan: planOf(entry('a', 0, ''), newPlanEntry({ id: 'b', dir: 'b', first_phrase: 'p-1' })), phrases: null, total: 200, want: '--phrases' },
      { plan: planOf(entry('a', 0, ''), newPlanEntry({ id: 'b', dir: 'b', first_phrase: 'p-9' })), phrases, total: 200, want: '不在短语时间轴' },
      { plan: planOf(entry('a', 0, '')), phrases: { fps: 25, phrases: phrases.phrases }, total: 200, want: '25fps' },
    ];
    cases.forEach((c, i) => {
      expect(() => layoutTiming(c.plan, testCues, c.phrases, 30, c.total), `第 ${i} 例`).toThrow(c.want);
    });
  });
});

// 写进 scene.json 的 6 位小数必须能还原成原帧数，并通过整数帧校验。
it('duration literal round-trips', () => {
  for (const fps of [24, 25, 30, 50, 60]) {
    for (let frames = 1; frames <= 20000; frames++) {
      const value = Number(durationLiteral(frames, fps));
      const exact = value * fps;
      if (goRound(exact) !== frames || Math.abs(exact - goRound(exact)) > frameAlignmentTolerance) {
        throw new Error(`${frames} 帧 @${fps}fps 写成 ${durationLiteral(frames, fps)} 后还原为 ${exact} 帧`);
      }
    }
  }
});

describe('verifyTimingInputs', () => {
  it('checks the timing block', () => {
    const ok = '{"fps":30,"start_frame":120,"end_frame_exclusive":431,"plan":"' + testPlanSHA + '"}';
    expect(() => verifyTimingInputs(timedScene('10.366667', ok)), '一致的 timing 块应通过').not.toThrow();
    const cases: Record<string, [string, string]> = {
      手改时长: ['10.4', ok],
      非整数帧: ['10.367', ok],
      帧率不符: ['10.366667', '{"fps":25,"start_frame":120,"end_frame_exclusive":431,"plan":"' + testPlanSHA + '"}'],
      区间倒置: ['10.366667', '{"fps":30,"start_frame":431,"end_frame_exclusive":120,"plan":"' + testPlanSHA + '"}'],
      缺计划摘要: ['10.366667', '{"fps":30,"start_frame":120,"end_frame_exclusive":431,"plan":""}'],
      短语文件缺失: ['10.366667', '{"fps":30,"start_frame":120,"end_frame_exclusive":431,"plan":"' + testPlanSHA + '","phrases":"phrase-timeline.json"}'],
      短语路径逃逸: ['10.366667', '{"fps":30,"start_frame":120,"end_frame_exclusive":431,"plan":"' + testPlanSHA + '","phrases":"../x.json"}'],
    };
    for (const [name, [duration, timing]] of Object.entries(cases)) {
      const err = catchError(() => verifyTimingInputs(timedScene(duration, timing)));
      expect(err, `${name}：应返回 VerificationError`).toBeInstanceOf(VerificationError);
    }
    let s = timedScene('10.366667', ok);
    s.beat = {} as beat.Cue;
    expect(() => verifyTimingInputs(s), 'timing 与 beat 同时出现应拒绝').toThrow('互斥');
    s = timedScene('10.366667', ok);
    fs.writeFileSync(
      path.join(s.directory, 'p.json'),
      '{"schema":1,"fps":25,"phrases":[{"phrase_id":"p","start_frame":0,"end_frame_exclusive":3}]}',
    );
    s.timing!.phrases = 'p.json';
    expect(() => verifyTimingInputs(s), '短语时间轴帧率不符应拒绝').toThrow('25fps');
  });

  // 没有 timing 块的老镜头不受影响。
  it('ignores legacy scenes', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1.25,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    expect(() => verifyTimingInputs(load(dir))).not.toThrow();
  });

  it('rejects a hand-edited handoff', () => {
    const s = timedScene(
      '1.000000',
      '{"fps":30,"start_frame":0,"end_frame_exclusive":30,"plan":"' +
        testPlanSHA +
        '","enter":{"peer":"x","device":"wipe","bridge":"y"},"look":{"background":"red","ink":"#ffffff","accent":"#ffffff"}}',
    );
    const err = catchError(() => verifyTimingInputs(s)) as Error | null;
    expect(err?.message).toContain('timing.enter');
    expect(err?.message).toContain('look.background');
  });
});

it('buildPrompt rejects hand-edited timing', () => {
  const s = timedScene('10.4', '{"fps":30,"start_frame":120,"end_frame_exclusive":431,"plan":"' + testPlanSHA + '"}');
  expect(() => buildPrompt(s, null), '时长与 timing 块不符时 buildPrompt 应失败').toThrow();
});

it('timing is an optional field', () => {
  expect(optionalFields(), 'timing 应是 scene.json 的可选字段').toContain('timing');
});
