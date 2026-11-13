/**
 * 双跑对照用例（写法见 cases.mjs 开头的说明）：am scene run / run-all、am run、am validate publish / style。
 * 只跑在启动渲染器或编排工具之前就会结束的路径：渲染与编排都要调用 AI CLI。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 三个镜头：两个非整数帧时长、一个整数帧；字幕跨度 30 秒，镜头合计不足。 */
function scenesFixture(base) {
  fs.writeFileSync(path.join(base, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:30,000\n很长的一句\n');
  for (const [id, duration] of [
    ['scene-001', '14.367'],
    ['scene-002', '4'],
    ['scene-003', '2.01'],
  ]) {
    const dir = path.join(base, 'scenes', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    fs.writeFileSync(path.join(dir, 'scene.json'), `{"id":"${id}","duration_seconds":${duration},"output":"${id}.mp4","transcript":"transcription.srt","text":"hi"}`);
  }
  // 编号重复的一组，覆盖校验要点名。
  for (const id of ['a', 'b']) {
    const dir = path.join(base, 'dup', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"same","duration_seconds":1.5,"output":"out.mp4","transcript":"transcription.srt","text":"hi"}');
  }
  // 载入就失败的镜头（未知字段）。
  const bad = path.join(base, 'bad', 'scene-001');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
  fs.writeFileSync(path.join(bad, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcription.srt","text":"hi","nope":1}');
  fs.mkdirSync(path.join(base, 'empty'), { recursive: true });
}

export const cases = [
  {
    name: 'scene, run, validate help',
    commands: [
      ['scene', '--help'],
      ['scene'],
      ['scene', 'run', '--help'],
      ['scene', 'run-all', '--help'],
      ['run', '--help'],
      ['validate', '--help'],
      ['validate'],
      ['validate', 'publish', '--help'],
      ['validate', 'style', '--help'],
      ['help', 'scene', 'run-all'],
    ],
  },
  {
    name: 'validate publish and style',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--style', 'pixel-arcade-v1']],
    commands: [
      ['validate', 'publish', 'templates/publish.md'],
      ['validate', 'publish', 'templates/publish.md', '--project-root', '.'],
      ['validate', 'publish', 'nope.md'],
      ['validate', 'publish', 'PROMPT.md'],
      ['validate', 'publish'],
      ['validate', 'style'],
      ['validate', 'style', '--project-root', 'nowhere'],
      ['validate', 'style', 'extra'],
    ],
  },
  {
    name: 'validate style on a custom draft',
    setup: [['init', '--canvas', 'vertical-9x16', '--skip-hyperframes']],
    commands: [['validate', 'style'], ['validate', 'style', '--project-root', '.']],
  },
  {
    name: 'scene run-all preflight',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    prepare: scenesFixture,
    commands: [
      ['scene', 'run-all', 'empty'],
      ['scene', 'run-all', 'empty', '--jobs', '1', '--retries', '0'],
      ['scene', 'run-all', 'scenes', '--jobs', '1', '--retries', '0'],
      ['scene', 'run-all', 'scenes', '--srt', 'transcription.srt'],
      ['scene', 'run-all', 'scenes', '--srt', 'transcription.srt', '--strict-coverage'],
      ['scene', 'run-all', 'scenes', '--srt', 'transcription.srt', '--coverage-tolerance', '100'],
      ['scene', 'run-all', 'dup', '--strict-coverage'],
      ['scene', 'run-all', 'bad'],
      ['scene', 'run-all', 'nowhere'],
      ['scene', 'run-all', 'scenes', '--jobs', '17'],
      ['scene', 'run-all', 'scenes', '--retries', '6'],
      ['scene', 'run-all', 'scenes', '--duration-tolerance', 'nan'],
      ['scene', 'run-all', 'scenes', '--duration-tolerance', '-1'],
      ['scene', 'run-all', 'scenes', '--jobs', 'x'],
      ['scene', 'run-all', 'scenes', '--srt', 'transcription.srt', '--song-timeline', 'production/song/timeline.json'],
      ['scene', 'run-all', 'scenes', '--song-timeline', 'timeline.json'],
      ['scene', 'run-all', 'scenes', '--srt', 'missing.srt'],
      ['scene', 'run-all'],
      ['scene', 'run'],
      ['scene', 'run', 'scenes/missing'],
      ['scene', 'run', 'bad/scene-001'],
      ['scene', 'run', 'scenes/scene-001', '--duration-tolerance', '-1'],
    ],
  },
  {
    name: 'scene run-all in a song project',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song']],
    prepare: (base) => fs.mkdirSync(path.join(base, 'scenes'), { recursive: true }),
    commands: [
      ['scene', 'run-all', 'scenes'],
      ['scene', 'run-all', 'scenes', '--song-timeline', 'production/song/timeline.json'],
    ],
  },
  {
    name: 'scene run-all in a beat project',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'beat']],
    prepare: (base) => fs.mkdirSync(path.join(base, 'scenes'), { recursive: true }),
    commands: [['scene', 'run-all', 'scenes']],
  },
  {
    name: 'run before the orchestrator starts',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [['run', 'nope.md'], ['run', 'a', 'b'], ['run', 'nope.md', '--workdir', 'elsewhere']],
  },
  {
    name: 'run with an invalid configuration',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    prepare: (base) => fs.writeFileSync(path.join(base, '.env'), 'ORCHESTRATOR=nope\n'),
    commands: [['run'], ['scene', 'run-all', 'scenes'], ['scene', 'run', 'scenes/x']],
  },
];
