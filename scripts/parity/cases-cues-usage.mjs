/**
 * 双跑对照用例（写法见 cases.mjs 开头的说明）。由 cases.mjs 汇总。
 * 覆盖 am scene cues、am scene usage、am usage。样例全部在 prepare 里合成。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const goAm = process.env.AM_GO || path.join(os.homedir(), '.local/bin/am');

// 四条字幕，30fps 下：[0,30) [45,90) [90,120) [150,180)。
const cuesSRT = '1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,500 --> 00:00:03,000\n第二句\n\n3\n00:00:03,000 --> 00:00:04,000\n第三句\n\n4\n00:00:05,000 --> 00:00:06,000\n第四句\n';
const cuesPhrases =
  '{"schema":1,"fps":30,"phrases":[\n' +
  '{"phrase_id":"p-1","source_text":"第一句","start_frame":0,"end_frame_exclusive":30},\n' +
  '{"phrase_id":"p-2","source_text":"第二句","start_frame":45,"end_frame_exclusive":90},\n' +
  '{"phrase_id":"p-4","source_text":"第四句","start_frame":150,"end_frame_exclusive":180}]}\n';

const plans = {
  'scene-plan.json':
    '{"schema":1,"scenes":[\n  {"id":"scene-001","dir":"scenes/scene-001"},\n  {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2},\n  {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end"}]}',
  'plan-look.json':
    '{"schema":1,"look":{"background":"#0F1720","ink":"#F5F1E8","accent":"#F2B134"},"scenes":[\n' +
    '  {"id":"scene-001","dir":"scenes/scene-001","chapter":"问题"},\n' +
    '  {"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2,"chapter":"问题","cut":"mid_gap"},\n' +
    '  {"id":"scene-003","dir":"scenes/scene-003","first_phrase":"p-4","cut":"prev_end","chapter":"机制",\n' +
    '   "handoff":{"device":"push_in","bridge":"琥珀色圆形表面铺满画面 <b>&</b>"}}]}',
  'plan-short.json': '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"scene-002","dir":"scenes/scene-002","first_subtitle":2}]}',
  'plan-order.json':
    '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"scene-003","dir":"scenes/scene-003","first_subtitle":2},{"id":"scene-002","dir":"scenes/scene-002","first_subtitle":4}]}',
  'plan-id.json':
    '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"wrong","dir":"scenes/scene-002","first_subtitle":2},{"id":"scene-003","dir":"scenes/scene-003","first_subtitle":4}]}',
  'plan-missing.json':
    '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001"},{"id":"scene-002","dir":"scenes/nope","first_subtitle":2},{"id":"scene-003","dir":"scenes/scene-003","first_subtitle":4}]}',
  'plan-unknown.json': '{"schema":1,"scenes":[{"id":"scene-001","dir":"scenes/scene-001","nope":1}]}',
};

/** 三镜头项目：scene-001 的字段顺序故意打乱，并带需要 HTML 转义的文字。 */
function cuesProject(base) {
  for (const id of ['scene-001', 'scene-002', 'scene-003']) {
    const dir = path.join(base, 'scenes', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.srt'), cuesSRT);
    let body = `{"id":"${id}","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"文案"}`;
    if (id === 'scene-001') body = '{ "text" : "文案 <b>&</b> \\u00e9", "id":"scene-001","renderer":"codex","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt"}';
    fs.writeFileSync(path.join(dir, 'scene.json'), body);
  }
  fs.mkdirSync(path.join(base, 'production'), { recursive: true });
  fs.writeFileSync(path.join(base, 'transcription-production.srt'), cuesSRT);
  fs.writeFileSync(path.join(base, 'production', 'phrase-timeline.json'), cuesPhrases);
  for (const [name, body] of Object.entries(plans)) fs.writeFileSync(path.join(base, 'production', name), body);
}

const cues = (...extra) => [
  'scene',
  'cues',
  '--plan',
  'production/scene-plan.json',
  '--srt',
  'transcription-production.srt',
  '--phrases',
  'production/phrase-timeline.json',
  '--total-frames',
  '240',
  ...extra,
  'scenes',
];

/** 已经用 Go 版跑过一次 cues，再手改一处时长、换掉一份短语副本。 */
function cuedAndEdited(base) {
  cuesProject(base);
  spawnSync(goAm, cues(), { cwd: base });
  const file = path.join(base, 'scenes', 'scene-002', 'scene.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"duration_seconds": 1.500000', '"duration_seconds": 1.533333'));
  fs.writeFileSync(path.join(base, 'scenes', 'scene-003', 'phrase-timeline.json'), '{}');
}

/** 已经用 Go 版跑过一次带配色与交接的 cues。 */
function cuedWithLook(base) {
  cuesProject(base);
  spawnSync(goAm, cues('--plan', 'production/plan-look.json'), { cwd: base });
}

const attempt = (id, fields) =>
  JSON.stringify({ schema: 1, scene_id: id, renderer: 'codex', outcome: 'succeeded', started_at: '2026-11-01T10:00:00Z', ...fields });

/** 镜头的尝试记录（含 attempts/ 里归档的）与编排账本。 */
function usageProject(base) {
  const frame = '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n';
  for (const id of ['s1', 's2', 's3']) {
    const dir = path.join(base, 'scenes', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
    fs.writeFileSync(path.join(dir, 'frame.md'), frame);
    fs.writeFileSync(
      path.join(dir, 'scene.json'),
      `{"id":"${id}","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文","style_guide":"frame.md"}`,
    );
  }
  const s1 = path.join(base, 'scenes', 's1');
  fs.writeFileSync(
    path.join(s1, 'render-s1.attempt.json'),
    attempt('s1', { started_at: '2026-11-01T11:00:00Z', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, basis: 'total-input', source: 'codex turn.completed' } }),
  );
  fs.mkdirSync(path.join(s1, 'attempts', 'attempt-01'), { recursive: true });
  fs.writeFileSync(
    path.join(s1, 'attempts', 'attempt-01', 'render-s1.attempt.json'),
    attempt('s1', { outcome: 'verification_failed', model: 'gpt-5', usage: { input_tokens: 800, cached_input_tokens: 100, output_tokens: 40, basis: 'total-input', source: 'codex turn.completed' } }),
  );
  fs.mkdirSync(path.join(s1, 'attempts', 'attempt-02'), { recursive: true });
  fs.writeFileSync(path.join(s1, 'attempts', 'attempt-02', 'render-s1.attempt.json'), attempt('s1', { outcome: 'failed', renderer: 'claude', started_at: '2026-11-01T10:30:00Z' }));
  // 老口径记录：claude 的输入不含缓存，读时换算。
  fs.writeFileSync(
    path.join(base, 'scenes', 's2', 'render-s2.attempt.json'),
    attempt('s2', { renderer: 'claude', model: 'claude-opus', usage: { input_tokens: 4, cached_input_tokens: 40437, output_tokens: 900, cost_usd: 0.25, source: 'claude result' } }),
  );
  fs.mkdirSync(path.join(base, 'production', 'usage'), { recursive: true });
  const ledger = [
    { time: '2026-11-01T09:00:00Z', source: 'run', tool: 'codex', model: 'gpt-test', session: 'th-1', status: 'succeeded', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, basis: 'total-input', source: 'codex turn.completed' } },
    { time: '2026-11-01T09:10:00Z', source: 'studio', tool: 'claude', session: 'c-1', turn: 't1', status: 'failed' },
    { time: '2026-11-01T09:20:00Z', source: 'other', tool: 'claude', model: 'claude-opus', status: 'cancelled', usage: { input_tokens: 70, output_tokens: 7, cost_usd: 0.01, basis: 'total-input', source: 'claude result' } },
  ];
  fs.writeFileSync(path.join(base, 'production', 'usage', 'orchestrator.jsonl'), ledger.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
}

export const cases = [
  {
    name: 'scene cues',
    prepare: cuesProject,
    commands: [
      ['scene', 'cues', '--help'],
      cues(),
      cues('--check'),
      ['scene', 'cues', '--plan', 'production/scene-plan.json', '--srt', 'transcription-production.srt', '--total-frames', '240', 'scenes'],
      cues('--plan', 'production/plan-look.json'),
      cues('--fps', '25'),
      cues('--fps', '30'),
      cues('--fps', '-1'),
      cues('--total-frames', '90'),
      cues('--total-frames', '0'),
      cues('--plan', 'production/plan-short.json'),
      cues('--plan', 'production/plan-order.json'),
      cues('--plan', 'production/plan-id.json'),
      cues('--plan', 'production/plan-missing.json'),
      cues('--plan', 'production/plan-unknown.json'),
      cues('--plan', 'production/nope.json'),
      cues('--phrases', 'production/nope.json'),
      ['scene', 'cues', 'scenes'],
      ['scene', 'cues'],
    ],
  },
  {
    name: 'scene cues check after hand edits',
    prepare: cuedAndEdited,
    commands: [cues('--check'), cues(), cues('--plan', 'production/plan-look.json', '--check')],
  },
  {
    name: 'scene cues check with look and handoffs',
    prepare: cuedWithLook,
    commands: [cues('--plan', 'production/plan-look.json', '--check'), cues('--check'), cues('--plan', 'production/plan-look.json')],
  },
  {
    name: 'usage',
    prepare: usageProject,
    commands: [
      ['usage', '--help'],
      ['scene', 'usage', '--help'],
      ['scene', 'usage', 'scenes'],
      ['scene', 'usage', 'scenes', '--json'],
      ['usage'],
      ['usage', '--json'],
      ['usage', '--scenes', 'nope'],
      ['usage', '--scenes', 'nope', '--json'],
      ['usage', 'extra'],
      ['scene', 'usage'],
      ['scene', 'usage', 'missing'],
    ],
  },
  {
    name: 'usage empty project',
    commands: [['usage'], ['usage', '--json']],
  },
];
