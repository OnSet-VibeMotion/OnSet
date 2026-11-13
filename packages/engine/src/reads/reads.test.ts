import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Defaults,
  DecorativeRole,
  RuleDuration,
  RuleFrames,
  RuleOrder,
  RuleSpoiler,
  check,
  loadInventory,
  loadTimeline,
  newEvent,
  newPhrase,
  requiredFrames,
  units,
  writeJSON,
} from './index';
import type { Event, Timeline } from './index';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function event(id: string, text: string, start: number, end: number): Event {
  return newEvent({
    event_id: id,
    scene_id: 'scene-001',
    text,
    role: 'label',
    phrase_id: 'p-' + id,
    enter_frame: start - 5,
    readable_start_frame: start,
    readable_end_frame_exclusive: end,
    exit_end_frame: end + 5,
  });
}

describe('reads', () => {
  it('units', () => {
    const cases: Record<string, number> = {
      '配音、字幕和渲染': 7,
      'GPU 算力提升 3 倍': 7, // GPU、算、力、提、升、3、倍
      'Claude Opus 5.5': 4, // Claude、Opus、5、5
      '！？……': 0,
      '': 0,
    };
    for (const [text, want] of Object.entries(cases)) {
      expect(units(text), `Units(${JSON.stringify(text)})`).toBe(want);
    }
  });

  it('required frames', () => {
    // 4 个字：4/9 秒不到 5/6 秒，取下限 25 帧（30fps）。
    expect(requiredFrames(4, 30, Defaults), '短文本应取最短显示时长').toBe(25);
    // 18 个字：2 秒，60 帧。
    expect(requiredFrames(18, 30, Defaults), '18 字应需 60 帧').toBe(60);
  });

  it('short read is a problem', () => {
    const inv = {
      schema: 0,
      fps: 30,
      events: [
        event('a', '一共分三步', 10, 60), // 5 字需 25 帧，有 50 帧
        event('b', '写稿配音渲染然后拼接混音最后交付成片', 100, 130), // 18 字需 60 帧，只有 30 帧
      ],
    };
    const report = check(inv, null, Defaults);
    expect(report.ok).toBe(false);
    expect(report.problems, '只有 b 不够读').toHaveLength(1);
    expect(report.problems[0]).toContain('b（scene-001）可读 30 帧');
    expect(report.problems[0]).toContain('还差 30 帧');
  });

  it('decorative is skipped and frame order checked', () => {
    const decorative = event('d', '很长很长的装饰文字不需要读完的', 0, 2);
    decorative.role = DecorativeRole;
    const broken = event('x', '好', 50, 40);
    const duplicate = event('a', '一', 200, 260);
    const report = check(
      { schema: 0, fps: 30, events: [decorative, broken, event('a', '一', 100, 160), duplicate, newEvent({ text: '无编号' })] },
      null,
      Defaults,
    );
    const joined = report.problems.join('\n');
    for (const want of ['x 的帧号顺序不成立', 'event_id 重复：a', '缺少 event_id']) {
      expect(joined).toContain(want);
    }
    expect(joined, '装饰元素不应检查阅读时间').not.toContain('d（');
  });

  it('phrase binding and order', () => {
    const timeline: Timeline = {
      fps: 30,
      phrases: [
        newPhrase({ phrase_id: 'p-a', semantic_order: 1, start_frame: 0 }),
        newPhrase({ phrase_id: 'p-b', semantic_order: 2, start_frame: 100 }),
        newPhrase({ phrase_id: 'p-c', semantic_order: 3, start_frame: 200 }),
      ],
    };
    const early = event('b', '第二件事', 90, 150); // 第 85 帧出现，短语 100 才开始
    const reversed = event('c', '第三件事', 40, 80); // 比 a 先可读，但口播在后
    const unbound = event('e', '无短语', 300, 340);
    unbound.phrase_id = '';
    const report = check(
      { schema: 0, fps: 30, events: [event('a', '第一件事', 60, 100), early, reversed, unbound] },
      timeline,
      Defaults,
    );
    const joined = report.problems.join('\n');
    for (const want of [
      'b 在第 85 帧出现，早于绑定短语 p-b 的开始帧 100',
      'c 在第 35 帧出现',
      'c（短语顺序 3）比 a（短语顺序 1）先可读',
      'e 没有绑定 phrase_id',
    ]) {
      expect(joined).toContain(want);
    }
  });

  it('mismatched fps disables phrase checks', () => {
    const report = check(
      { schema: 0, fps: 30, events: [event('a', '一', 10, 60)] },
      { fps: 24, phrases: [newPhrase({ phrase_id: 'p-a' })] },
      Defaults,
    );
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain('fps');
    expect(report.problems, 'fps 不一致应报一次并跳过短语比对').toHaveLength(1);
  });

  // TestCrowdingIsOnlyAHint：卡片组一起出现是合法版式，只提示。
  it('crowding is only a hint', () => {
    const report = check(
      { schema: 0, fps: 30, events: [event('a', '甲', 100, 160), event('b', '乙', 105, 165), event('c', '丙', 300, 360)] },
      null,
      Defaults,
    );
    expect(report.ok).toBe(true);
    expect(report.hints).toHaveLength(1);
    expect(report.hints![0]).toContain('[a b]');
  });

  it('load and write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-reads-'));
    temps.push(dir);
    const inventory = path.join(dir, 'inv.json');
    fs.writeFileSync(
      inventory,
      '{"schema":1,"fps":30,"events":[{"event_id":"a","text":"一","enter_frame":0,"readable_start_frame":0,"readable_end_frame_exclusive":30,"exit_end_frame":30}]}',
    );
    const inv = loadInventory(inventory);
    expect(inv.events[0].readable_end_frame_exclusive).toBe(30);
    for (const [name, body] of Object.entries({
      'nofps.json': '{"events":[{}]}',
      'empty.json': '{"fps":30,"events":[]}',
      'bad.json': '{',
    })) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      expect(() => loadInventory(file), `${name} 应报错`).toThrow();
    }
    const timeline = path.join(dir, 'phrases.json');
    fs.writeFileSync(
      timeline,
      '{"fps":30,"phrases":[{"phrase_id":"p","semantic_order":1,"start_frame":0,"end_frame_exclusive":10}]}',
    );
    expect(loadTimeline(timeline).phrases[0].end_frame_exclusive).toBe(10);
    fs.writeFileSync(timeline, '{"fps":30,"phrases":[]}');
    expect(() => loadTimeline(timeline), '空短语时间轴应报错').toThrow();
    writeJSON(check(inv, null, Defaults), path.join(dir, 'r.json'));
  });

  // TestFindingsAlignWithProblems：渲染记忆按 Findings 把问题记到镜头上，
  // 每条 Problem 都要有一条同文的 Finding，且能归到镜头与规则。
  it('findings align with problems', () => {
    const inv = {
      schema: 0,
      fps: 30,
      events: [
        newEvent({ event_id: 'e1', scene_id: 'scene-001', text: '一句很长很长很长的标题文字', phrase_id: 'p2', enter_frame: 0, readable_start_frame: 0, readable_end_frame_exclusive: 5, exit_end_frame: 5 }),
        newEvent({ event_id: 'e2', scene_id: 'scene-002', text: '短', phrase_id: 'p1', enter_frame: 30, readable_start_frame: 30, readable_end_frame_exclusive: 90, exit_end_frame: 90 }),
        newEvent({ event_id: 'e3', scene_id: 'scene-002', text: 'x', enter_frame: 9, readable_start_frame: 8, readable_end_frame_exclusive: 20, exit_end_frame: 20 }),
      ],
    };
    const timeline: Timeline = {
      fps: 30,
      phrases: [
        newPhrase({ phrase_id: 'p1', semantic_order: 1, start_frame: 0 }),
        newPhrase({ phrase_id: 'p2', semantic_order: 2, start_frame: 10 }),
      ],
    };
    const report = check(inv, timeline, Defaults);
    expect(report.findings.length).toBe(report.problems.length);
    const rules: Record<string, string | undefined> = {};
    report.findings.forEach((f, i) => {
      expect(f.message, `第 ${i} 条文字不一致`).toBe(report.problems[i]);
      rules[f.rule] = f.scene_id;
    });
    expect(rules[RuleDuration]).toBe('scene-001');
    expect(rules[RuleSpoiler]).toBe('scene-001');
    expect(rules[RuleOrder]).toBe('scene-002');
    expect(rules[RuleFrames]).toBe('scene-002');
  });
});
