import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '@onset/engine/filmstyle';
import * as scene from '@onset/engine/scene';
import { describe, expect, it } from 'vitest';
import { ref } from './cobra';
import { opCommand } from './ops/cli';
import { findOp } from './ops/op';
import { Buffer, tempDir } from './testutil';
import './scene_cues';

// 四条字幕，30fps 下：[0,30) [45,90) [90,120) [150,180)。
const cuesSRT = `1
00:00:00,000 --> 00:00:01,000
第一句

2
00:00:01,500 --> 00:00:03,000
第二句

3
00:00:03,000 --> 00:00:04,000
第三句

4
00:00:05,000 --> 00:00:06,000
第四句
`;

const cuesPhrases = `{"schema":1,"fps":30,"phrases":[
{"phrase_id":"p-1","source_text":"第一句","start_frame":0,"end_frame_exclusive":30},
{"phrase_id":"p-2","source_text":"第二句","start_frame":45,"end_frame_exclusive":90},
{"phrase_id":"p-4","source_text":"第四句","start_frame":150,"end_frame_exclusive":180}]}
`;

/** 建一个三镜头项目。scene-001 带 renderer 字段，并故意把 text 放在 id 前面，用来检查字段顺序被保留。 */
function cuesProject(): string {
  const root = tempDir();
  for (const id of ['scene-001', 'scene-002', 'scene-003']) {
    const dir = path.join(root, 'scenes', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.srt'), cuesSRT);
    let body = `{"id":"${id}","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"文案"}`;
    if (id === 'scene-001') {
      body = `{"text":"文案 <b>&</b>","id":"scene-001","renderer":"codex","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt"}`;
    }
    fs.writeFileSync(path.join(dir, 'scene.json'), body);
  }
  fs.writeFileSync(path.join(root, 'onset.conf'), '');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
  fs.mkdirSync(path.join(root, 'production'), { recursive: true });
  fs.writeFileSync(path.join(root, 'transcription-production.srt'), cuesSRT);
  fs.writeFileSync(path.join(root, 'production', 'phrase-timeline.json'), cuesPhrases);
  writePlan(
    root,
    `{"schema":1,"scenes":[
  {"id":"scene-001","dir":"scenes/scene-001"},
  {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2},
  {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end"}]}`,
  );
  return root;
}

function writePlan(root: string, body: string): void {
  fs.writeFileSync(path.join(root, 'production', 'scene-plan.json'), body);
}

async function runCues(root: string, ...extra: string[]): Promise<{ out: string; err: Error | null }> {
  const out = new Buffer();
  const cmd = opCommand(findOp('scene_cues')!, out, out, ref(false));
  cmd.setOut(out);
  cmd.setErr(out);
  const args = [
    '--project-root',
    root,
    '--plan',
    path.join(root, 'production', 'scene-plan.json'),
    '--srt',
    path.join(root, 'transcription-production.srt'),
    '--phrases',
    path.join(root, 'production', 'phrase-timeline.json'),
    '--total-frames',
    '240',
    ...extra,
    path.join(root, 'scenes'),
  ];
  try {
    await cmd.execute(args);
    return { out: out.text, err: null };
  } catch (err) {
    return { out: out.text, err: err as Error };
  }
}

const mustRead = (file: string) => fs.readFileSync(file, 'utf8');

describe('onset scene cues', () => {
  it('keeps a legacy rendered mirror reusable when a different cut changes', async () => {
    const root = cuesProject();
    expect((await runCues(root)).err).toBeNull();
    const dirs = [1, 2, 3].map((n) => path.join(root, 'scenes', 'scene-00' + n));
    for (const dir of dirs) {
      const s = scene.load(dir);
      fs.writeFileSync(scene.outputPath(s), 'video');
      fs.writeFileSync(
        path.join(dir, scene.RecordFile),
        JSON.stringify({
          schema: 2,
          output: 'out.mp4',
          output_size: 5,
          output_sha256: crypto.createHash('sha256').update('video').digest('hex'),
          ...scene.fingerprint(s, 'claude', {}, 2),
        }),
      );
    }
    const file = path.join(root, 'production', 'scene-plan.json');
    fs.writeFileSync(file, mustRead(file).replace('"first_subtitle":2', '"first_subtitle":2,"cut":"prev_end"'));
    expect((await runCues(root)).err).toBeNull();
    const reuses = dirs.map((dir) => {
      const s = scene.load(dir);
      const record = scene.loadRecord(s)!;
      expect(record.schema).toBe(scene.RecordSchemaRenderContract);
      expect(record.plan_sha256).not.toBe(s.timing!.plan);
      return scene.inputsMatchRecord(s, scene.fingerprint(s, 'claude', {}, record.schema), record);
    });
    expect(reuses).toEqual([false, false, true]);
  });

  it('writes durations and timing', async () => {
    const root = cuesProject();
    const first = await runCues(root);
    expect(first.err, first.out).toBeNull();
    const want: Record<string, [number, number]> = {
      'scene-001': [0, 45],
      'scene-002': [45, 90],
      'scene-003': [90, 240],
    };
    for (const [id, span] of Object.entries(want)) {
      const s = scene.load(path.join(root, 'scenes', id));
      expect(s.timing).not.toBeNull();
      expect([s.timing!.start_frame, s.timing!.end_frame_exclusive, s.timing!.fps]).toEqual([span[0], span[1], 30]);
      expect(s.timing!.phrases).toBe(scene.PhraseCopyFile);
      expect(s.timing!.plan.length).toBe(64);
      scene.verifyTimingInputs(s);
      expect(mustRead(path.join(s.directory, scene.PhraseCopyFile))).toBe(cuesPhrases);
    }
    expect(mustRead(path.join(root, 'scenes', 'scene-002', 'scene.json'))).toContain('"duration_seconds": 1.500000');
    const text = mustRead(path.join(root, 'scenes', 'scene-001', 'scene.json'));
    let last = -1;
    for (const key of [
      '"text"',
      '"id"',
      '"renderer": "codex"',
      '"duration_seconds": 1.500000',
      '"output"',
      '"transcript"',
      '"timing"',
    ]) {
      const at = text.indexOf(key);
      expect(at, `${key} 位置不对：\n${text}`).toBeGreaterThan(last);
      last = at;
    }
    expect(text).toContain('"文案 <b>&</b>"');
    expect(first.out).toContain('scene-003');
    expect(first.out).toContain('5.000000');

    // 无变化的重跑不改动文件，--check 通过。
    const file = path.join(root, 'scenes', 'scene-001', 'scene.json');
    const stat = fs.statSync(file, { bigint: true });
    const again = await runCues(root);
    expect(again.err, again.out).toBeNull();
    expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(stat.mtimeNs);
    const check = await runCues(root, '--check');
    expect(check.err, check.out).toBeNull();
  });

  it('--check detects hand edits', async () => {
    const root = cuesProject();
    expect((await runCues(root)).err).toBeNull();
    const file = path.join(root, 'scenes', 'scene-002', 'scene.json');
    const edited = mustRead(file).replace('"duration_seconds": 1.500000', '"duration_seconds": 1.533333');
    fs.writeFileSync(file, edited);
    fs.writeFileSync(path.join(root, 'scenes', 'scene-003', scene.PhraseCopyFile), '{}');

    const { err } = await runCues(root, '--check');
    expect(err).not.toBeNull();
    for (const want of ['scene-002', '46 帧', '45 帧', 'scene-003', scene.PhraseCopyFile])
      expect(err!.message).toContain(want);
    expect(mustRead(file)).toBe(edited);

    // 计划改了而镜头没重跑：plan 摘要不再相符。
    expect((await runCues(root)).err).toBeNull();
    writePlan(
      root,
      `{"schema":1,"scenes":[
  {"id":"scene-001","dir":"scenes/scene-001"},
  {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2,"cut":"mid_gap"},
  {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end"}]}`,
    );
    const after = await runCues(root, '--check');
    expect(after.err?.message).toContain('timing 块');
  });

  it('rejects a plan that does not match the scenes', async () => {
    const root = cuesProject();
    const cases: Record<string, string> = {
      '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2}]}':
        '3 个镜头目录',
      '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"scene-003","dir":"scenes/scene-003","first_subtitle":2},{"id":"scene-002","dir":"scenes/scene-002","first_subtitle":4}]}':
        '字典序',
      '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"wrong","dir":"scenes/scene-002","first_subtitle":2},{"id":"scene-003","dir":"scenes/scene-003","first_subtitle":4}]}':
        'id wrong',
      '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"scene-002","dir":"scenes/nope","first_subtitle":2},{"id":"scene-003","dir":"scenes/scene-003","first_subtitle":4}]}':
        '不存在',
    };
    for (const [plan, want] of Object.entries(cases)) {
      writePlan(root, plan);
      const { err } = await runCues(root);
      expect(err?.message ?? '', `应报 ${want}`).toContain(want);
    }
    expect(mustRead(path.join(root, 'scenes', 'scene-002', 'scene.json'))).not.toContain('timing');
  });

  it('validates flags', async () => {
    const root = cuesProject();
    expect((await runCues(root, '--fps', '25')).err?.message).toContain('fps 25');
    expect((await runCues(root, '--total-frames', '90')).err?.message).toContain('不早于总帧数');
  });

  it('writes look and handoffs to both sides', async () => {
    const root = cuesProject();
    writePlan(
      root,
      `{"schema":1,"look":{"background":"#0F1720","ink":"#F5F1E8","accent":"#F2B134"},"scenes":[
  {"id":"scene-001","dir":"scenes/scene-001","chapter":"问题"},
  {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2,"chapter":"问题"},
  {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end","chapter":"机制",
   "handoff":{"device":"push_in","bridge":"琥珀色圆形表面铺满画面"}}]}`,
    );
    const r = await runCues(root);
    expect(r.err, r.out).toBeNull();
    const load = (id: string) => scene.load(path.join(root, 'scenes', id));
    const [first, second, third] = [load('scene-001'), load('scene-002'), load('scene-003')];
    expect(first.timing!.look.background).toBe('#0F1720');
    expect(scene.lookEqual(third.timing!.look, first.timing!.look)).toBe(true);
    expect(scene.handoffIsZero(first.timing!.exit)).toBe(true);
    expect(scene.handoffIsZero(second.timing!.enter)).toBe(true);
    const want = scene.newTiming().enter;
    Object.assign(want, { device: 'push_in', bridge: '琥珀色圆形表面铺满画面', cross_chapter: true });
    const exit = { ...second.timing!.exit };
    const enter = { ...third.timing!.enter };
    expect(exit.peer).toBe('scene-003');
    expect(enter.peer).toBe('scene-002');
    exit.peer = '';
    enter.peer = '';
    expect(exit).toEqual(want);
    expect(enter).toEqual(want);
    expect(third.timing!.chapter).toBe('机制');
    const check = await runCues(root, '--check');
    expect(check.err, check.out).toBeNull();

    // 改了交接约定却没重跑，--check 要指出来。
    writePlan(root, mustRead(path.join(root, 'production', 'scene-plan.json')).replace('push_in', 'flood'));
    const changed = await runCues(root, '--check');
    expect(changed.err?.message).toContain('enter=scene-002/flood');
  });

  // 镜头可以换风格：film_style 抄进 scene.json，风格交界两侧都拿到 style_shift 与对方的 film_style；
  // 风格没装、风格交界没写 style_shift 都在写文件之前报错。
  it('writes film styles and checks style boundaries', async () => {
    const root = cuesProject();
    writeStyle(path.join(root, '.agents', 'skills', filmstyle.SkillName), 'alpha/ink');
    const plan = (shift: string) => `{"schema":1,"scenes":[
  {"id":"scene-001","dir":"scenes/scene-001"},
  {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2,"film_style":"beta/oil",
   "handoff":{"device":"push_in","bridge":"相框里的油画铺满画面"${shift}}},
  {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end","film_style":"beta/oil"}]}`;
    writePlan(root, plan(',"style_shift":"window"'));
    const missing = await runCues(root);
    expect(missing.err?.message).toContain('film_style_add({"style": "beta/oil"})');

    writeStyle(filmstyle.extraDir(root, 'beta/oil'), 'beta/oil');
    writePlan(root, plan(''));
    const noShift = await runCues(root);
    expect(noShift.err?.message).toContain('handoff 要写 style_shift');

    writePlan(root, plan(',"style_shift":"window"'));
    const r = await runCues(root);
    expect(r.err, r.out).toBeNull();
    const load = (id: string) => scene.load(path.join(root, 'scenes', id));
    expect(load('scene-001').film_style).toBe('');
    expect(load('scene-002').film_style).toBe('beta/oil');
    expect(load('scene-001').timing!.exit).toMatchObject({
      peer: 'scene-002',
      style_shift: 'window',
      peer_film_style: 'beta/oil',
    });
    expect(load('scene-002').timing!.enter).toMatchObject({
      peer: 'scene-001',
      style_shift: 'window',
      peer_film_style: '',
    });
    expect((await runCues(root, '--check')).err).toBeNull();

    // 手改了镜头的 film_style，--check 要指出来；重跑 cues 按计划改回去，计划不写时删掉这个字段。
    const file = path.join(root, 'scenes', 'scene-003', 'scene.json');
    fs.writeFileSync(file, mustRead(file).replace('"beta/oil"', '"none"'));
    expect((await runCues(root, '--check')).err?.message).toContain('film_style 是 "none"');
    writePlan(root, plan(',"style_shift":"window"').replace(',"film_style":"beta/oil"}]}', '}]}'));
    const back = await runCues(root);
    expect(back.err?.message, '撤掉 scene-003 的风格后 002→003 成了风格交界').toContain('风格交界必须写 handoff');
  });

  it('validates, writes, checks motion_effects and emits soft hint when >=5 scenes have none', async () => {
    const root = cuesProject();
    // 超过 3 条拒绝
    writePlan(
      root,
      `{"schema":1,"scenes":[
        {"id":"scene-001","dir":"scenes/scene-001","motion_effects":["001","002","003","004"]},
        {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2},
        {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end"}]}`,
    );
    expect((await runCues(root)).err?.message).toContain('单镜最多 3 条');

    // 不存在的 ID 拒绝
    writePlan(
      root,
      `{"schema":1,"scenes":[
        {"id":"scene-001","dir":"scenes/scene-001","motion_effects":["motion-prompt:999"]},
        {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2},
        {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end"}]}`,
    );
    expect((await runCues(root)).err?.message).toContain('找不到动效');

    // 合法简写自动归一化、去重并写入 scene.json，且纳入 --check 校验
    writePlan(
      root,
      `{"schema":1,"scenes":[
        {"id":"scene-001","dir":"scenes/scene-001","motion_effects":["005","motion-prompt:005","007"]},
        {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2},
        {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end"}]}`,
    );
    const ok = await runCues(root);
    expect(ok.err, ok.out).toBeNull();
    expect(scene.load(path.join(root, 'scenes', 'scene-001')).motion_effects).toEqual([
      'motion-prompt:005',
      'motion-prompt:007',
    ]);
    expect(scene.load(path.join(root, 'scenes', 'scene-002')).motion_effects).toEqual([]);
    expect((await runCues(root, '--check')).err).toBeNull();

    // 手改 scene.json 的 motion_effects，--check 必须报错
    const file = path.join(root, 'scenes', 'scene-001', 'scene.json');
    fs.writeFileSync(file, mustRead(file).replace('"motion-prompt:007"', '"motion-prompt:001"'));
    expect((await runCues(root, '--check')).err?.message).toContain('motion_effects');

    // >= 5 镜且全部未指定 motion_effects 时，输出非阻断柔性提醒
    const root5 = tempDir();
    const srt5 = [1, 2, 3, 4, 5].map((n) => `${n}\n00:00:0${n - 1},000 --> 00:00:0${n},000\n第${n}句\n`).join('\n');
    for (let n = 1; n <= 5; n++) {
      const id = `scene-00${n}`;
      const dir = path.join(root5, 'scenes', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcript.srt'), srt5);
      fs.writeFileSync(
        path.join(dir, 'scene.json'),
        JSON.stringify({ id, duration_seconds: 1, output: 'out.mp4', transcript: 'transcript.srt', text: `第${n}句` }),
      );
    }
    fs.writeFileSync(path.join(root5, 'onset.conf'), '');
    fs.writeFileSync(path.join(root5, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    fs.mkdirSync(path.join(root5, 'production'), { recursive: true });
    fs.writeFileSync(path.join(root5, 'transcription-production.srt'), srt5);
    writePlan(
      root5,
      JSON.stringify({
        schema: 1,
        scenes: [1, 2, 3, 4, 5].map((n) => ({
          id: `scene-00${n}`,
          dir: `scenes/scene-00${n}`,
          ...(n > 1 ? { first_subtitle: n } : {}),
        })),
      }),
    );
    const out5 = new Buffer();
    const cmd5 = opCommand(findOp('scene_cues')!, out5, out5, ref(false));
    cmd5.setOut(out5);
    cmd5.setErr(out5);
    await cmd5.execute([
      '--project-root',
      root5,
      '--plan',
      path.join(root5, 'production', 'scene-plan.json'),
      '--srt',
      path.join(root5, 'transcription-production.srt'),
      '--total-frames',
      '150',
      path.join(root5, 'scenes'),
    ]);
    expect(out5.text).toContain('均未指定 motion_effects');
  });
});

function writeStyle(dir: string, key: string): void {
  const [source, slug] = key.split('/');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filmstyle.StyleFile), '# ' + key + '\n');
  fs.writeFileSync(path.join(dir, filmstyle.GuideFile), '# guide\n');
  fs.writeFileSync(
    path.join(dir, filmstyle.ManifestFile),
    JSON.stringify({ source, slug, cn: slug, en: slug, version: 'v1', digest: 'x', installed_at: '' }),
  );
}
