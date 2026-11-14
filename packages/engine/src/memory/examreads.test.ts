import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newAttempt, newTiming, OutcomeSucceeded, type Attempt, type Scene } from '../scene';
import { ArmControl, ArmTrial, type ExamOptions } from './exam';
import { ExamEventsFile, readsExamNote, readsPostCheck } from './examreads';
import { examinable } from './features';
import { MaxBodyChars } from './lint';
import { format, StatusActive, StatusTrial } from './memory';
import { SourceRender } from './episode';
import { failingAttempt, lesson, newStore, tempDir, writeSceneDir } from './testsupport';

interface EventFields {
  id: string;
  text: string;
  phrase?: string;
  enter: number;
  start: number;
  end: number;
  role?: string;
}

function writeEvents(dir: string, events: EventFields[]): void {
  const body = {
    schema: 1,
    fps: 30,
    events: events.map((e) => ({
      event_id: e.id,
      selector: '#' + e.id,
      text: e.text,
      role: e.role ?? 'title',
      phrase_id: e.phrase ?? '',
      enter_frame: e.enter,
      readable_start_frame: e.start,
      readable_end_frame_exclusive: e.end,
      exit_end_frame: e.end,
    })),
  };
  fs.writeFileSync(path.join(dir, ExamEventsFile), JSON.stringify(body));
}

describe('exam reads', () => {
  it('reads checks are examinable, handoff is not', () => {
    expect(examinable('reads.duration')).toBe(true);
    expect(examinable('reads.binding')).toBe(true);
    expect(examinable('review.handoff')).toBe(false);
  });

  it('judges the scene-local inventory against the scene-local phrase frames', () => {
    const dir = tempDir();
    const s = writeSceneDir(dir, 'scene-002', '中文标题', '');
    // 全局第 100 帧起的镜头；短语在全局 130 帧开始，即局部第 30 帧。
    fs.writeFileSync(
      path.join(dir, 'phrase-timeline.json'),
      JSON.stringify({ schema: 1, fps: 30, phrases: [{ phrase_id: 'p1', semantic_order: 1, start_frame: 130, end_frame_exclusive: 190 }] }),
    );
    s.timing = newTiming({ start_frame: 100, phrases: 'phrase-timeline.json' });
    const checks = ['reads.duration', 'reads.binding', 'reads.spoiler'];
    // 没交清单：判不了，不能算通过。
    expect(readsPostCheck(s, checks).map((f) => f.check)).toEqual(['reads.duration']);
    expect(readsPostCheck(s, checks)[0].incomplete).toBe(true);
    writeEvents(dir, [
      { id: 'ok', text: '复利', phrase: 'p1', enter: 30, start: 34, end: 80 },
      { id: 'short', text: '一二三四五六七八九十一二三四五六七八', phrase: 'p1', enter: 40, start: 44, end: 60 },
      { id: 'loose', text: '标签', enter: 50, start: 52, end: 90 },
      { id: 'early', text: '结论', phrase: 'p1', enter: 10, start: 12, end: 60 },
    ]);
    const found = readsPostCheck(s, checks);
    expect(found.map((f) => f.check).sort()).toEqual(['reads.binding', 'reads.duration', 'reads.spoiler']);
    // 局部第 30 帧出现的元素不早于短语：没有按全局帧误判成剧透。
    expect(found.some((f) => f.problem.startsWith('ok '))).toBe(false);
    // 只留点名的规则。
    expect(readsPostCheck(s, ['reads.duration']).map((f) => f.check)).toEqual(['reads.duration']);
    expect(readsPostCheck(s, ['frames.blank'])).toEqual([]);
  });

  it('asks both arms for the inventory and promotes a reads lesson that helps', async () => {
    const store = newStore();
    const project = tempDir();
    const s = writeSceneDir(path.join(project, 'scenes', 'scene-001'), 'scene-001', '中文标题', '');
    const { episode: failed } = store.recordCheck(s, [{ check: 'reads.duration', problem: 'x 可读 10 帧' }]);
    const hold = lesson('hold-readable', StatusTrial, null, 'reads.duration');
    hold.from_episodes = [failed.id];
    store.write(hold);
    const notes: string[] = [];
    const run = async (sc: Scene, renderer: string): Promise<Attempt> => {
      notes.push(sc.examNote);
      const helped = sc.memory?.names?.includes('hold-readable') ?? false;
      writeEvents(sc.directory, [{ id: 'title', text: '中文标题', enter: 0, start: 4, end: helped ? 60 : 14 }]);
      return newAttempt({ renderer, outcome: OutcomeSucceeded });
    };
    const opts: ExamOptions = {
      renderers: ['codex'],
      budget: 1500,
      workspace: path.join(project, 'production', 'memory-exams'),
      run,
      postCheck: (sc, checks) => readsPostCheck(sc, checks),
    };
    const result = await store.exam(opts);
    expect(notes.length).toBe(2);
    for (const note of notes) expect(note).toContain(ExamEventsFile);
    expect(notes[0]).toBe(notes[1]);
    expect(result.verdict.pass).toBe(true);
    expect(result.applied).toBe('promoted');
    for (const c of result.cells!) {
      if (c.arm === ArmControl) expect(c.checks).toEqual(['reads.duration']);
      if (c.arm === ArmTrial) expect(c.passed).toBe(true);
    }
    expect(store.find('hold-readable')!.status).toBe(StatusActive);
  });

  it('catches a later title repeating an earlier phrase after a caption has exposed the next phrase', () => {
    const dir = tempDir();
    const sc = writeSceneDir(dir, 'scene-002', '分层阅读', '');
    sc.duration_seconds = 4;
    fs.writeFileSync(path.join(dir, sc.transcript), '1\n00:00:04,000 --> 00:00:07,000\n先整理，再比较。\n');
    fs.writeFileSync(path.join(dir, 'phrase-timeline.json'), JSON.stringify({ schema: 1, fps: 30, phrases: [
      { phrase_id: 'sort', source_text: '整理', semantic_order: 1, start_frame: 130, end_frame_exclusive: 155 },
      { phrase_id: 'compare', source_text: '比较', semantic_order: 2, start_frame: 160, end_frame_exclusive: 190 },
    ] }));
    sc.timing = newTiming({ start_frame: 100, phrases: 'phrase-timeline.json' });
    const caption: EventFields = { id: 'subtitle-1', role: 'subtitle', text: '先整理，\n再比较。', enter: 20, start: 20, end: 110 };
    writeEvents(dir, [caption, { id: 'title', text: '整理', phrase: 'sort', enter: 30, start: 35, end: 75 }]);
    expect(readsPostCheck(sc, ['reads.order']).map((f) => f.problem)).toEqual([
      expect.stringContaining('subtitle-1/compare（短语顺序 2）比 title（短语顺序 1）先可读'),
    ]);
    // 用不重复前序文字的图形承接，不改冻结字幕也能消除跨层倒序。
    writeEvents(dir, [caption, { id: 'title', text: '比较', phrase: 'compare', enter: 60, start: 65, end: 110 }]);
    expect(readsPostCheck(sc, ['reads.order'])).toEqual([]);
    expect(readsPostCheck(sc, ['reads.order', 'reads.binding', 'reads.spoiler'])).toEqual([]);
    writeEvents(dir, [{ id: 'title', text: '整理', phrase: 'sort', enter: 30, start: 35, end: 75 }]);
    expect(readsPostCheck(sc, ['reads.order'])[0]).toMatchObject({ incomplete: true, problem: expect.stringContaining('未声明实际烧录的字幕编号') });
    // 把未登记的文字改报为 subtitle，也不能绕过检查。
    writeEvents(dir, [caption, { id: 'hidden-title', role: 'subtitle', text: '整理', enter: 30, start: 35, end: 75 }]);
    expect(readsPostCheck(sc, ['reads.order'])[0].problem).toContain('不是本镜头的冻结字幕事件');
    writeEvents(dir, [caption]);
    expect(readsPostCheck(sc, ['reads.binding'])[0]).toMatchObject({incomplete:true});
    expect(readsExamNote(['reads.order'])).toContain('烧录字幕也必须登记');
    expect(readsExamNote(['reads.duration'])).toContain('烧录字幕不用登记');
    // 同一份 SRT 在字幕可选的项目里可能只用作时间合同；没有烧录时不可凭空引入字幕倒序。
    writeEvents(dir, [{ id: 'title', text: '整理', phrase: 'sort', enter: 30, start: 35, end: 75 }]);
    const file = path.join(dir, ExamEventsFile);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.subtitle_cues = [];
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(readsPostCheck(sc, ['reads.order'])).toEqual([]);
    fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\nsubtitles: {required: true}\n---\n');
    expect(readsPostCheck(sc, ['reads.order']).some((f) => f.incomplete && f.problem.includes('要求烧录字幕'))).toBe(true);
  });

  it('does not pass an order-only exam with invalid inventory frames or no phrase timeline', () => {
    const dir = tempDir();
    const sc = writeSceneDir(dir, 'scene-002', '分层阅读', '');
    writeEvents(dir, [{ id: 'title', text: '整理', enter: 40, start: 20, end: 60 }]);
    const problems = readsPostCheck(sc, ['reads.order']).map((f) => f.problem);
    expect(problems.some((p) => p.includes('帧号顺序不成立'))).toBe(true);
    expect(problems.some((p) => p.includes('没有冻结短语时间轴'))).toBe(true);
  });

  it('hands rejected drafts back for one revision round', async () => {
    const store = newStore();
    const s = writeSceneDir(tempDir(), 'scene-001', '人工智能正在改变世界', '');
    const a = store.recordAttempt(s, failingAttempt('claude', 'determinism.raf'), { source: SourceRender });
    const b = store.recordAttempt(s, failingAttempt('codex', 'determinism.raf'), { source: SourceRender });
    const prompts: string[] = [];
    const drafter = async (workdir: string, prompt: string): Promise<void> => {
      prompts.push(prompt);
      const fixable = lesson('timeline-not-raf', StatusTrial, null, 'determinism.raf');
      fixable.from_episodes = [a.id, b.id];
      // 第一轮超长，改稿时删到上限以内。
      if (prompts.length === 1) fixable.body += '\n' + '多'.repeat(MaxBodyChars);
      fs.writeFileSync(path.join(workdir, 'drafts', 'lessons', 'timeline-not-raf.md'), format(fixable));
      const hopeless = lesson('stray-source', StatusTrial, null, 'determinism.raf');
      hopeless.from_episodes = ['ep-made-up'];
      fs.writeFileSync(path.join(workdir, 'drafts', 'lessons', 'stray-source.md'), format(hopeless));
    };
    const result = await store.consolidate({ minCount: 2, drafter });
    // 只改一轮。
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('drafts/lessons/timeline-not-raf.md');
    expect(prompts[1]).toContain('上限');
    expect(result.accepted).toEqual(['timeline-not-raf']);
    // 改了还不合格的照实记为被拒。
    expect(Object.keys(result.rejected)).toEqual(['lessons/stray-source.md']);
    expect(fs.existsSync(path.join(result.workdir, 'revise.md'))).toBe(true);
  });

  it('keeps the first round when the revision run fails', async () => {
    const store = newStore();
    const s = writeSceneDir(tempDir(), 'scene-001', '人工智能正在改变世界', '');
    const a = store.recordAttempt(s, failingAttempt('claude', 'determinism.raf'), { source: SourceRender });
    store.recordAttempt(s, failingAttempt('codex', 'determinism.raf'), { source: SourceRender });
    let calls = 0;
    const result = await store.consolidate({
      minCount: 2,
      drafter: async (workdir) => {
        calls++;
        if (calls > 1) throw new Error('改稿时断网');
        const long = lesson('timeline-not-raf', StatusTrial, null, 'determinism.raf');
        long.from_episodes = [a.id];
        long.body += '\n' + '多'.repeat(MaxBodyChars);
        fs.writeFileSync(path.join(workdir, 'drafts', 'lessons', 'timeline-not-raf.md'), format(long));
      },
    });
    expect(result.accepted).toEqual([]);
    expect(Object.keys(result.rejected)).toEqual(['lessons/timeline-not-raf.md']);
  });
});
