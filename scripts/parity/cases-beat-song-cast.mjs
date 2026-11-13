/**
 * 双跑对照用例（写法见 cases.mjs 开头的说明）：am beat、am song、am cast、am dialogue 与 am validate beat / song / cast。
 * 由 cases.mjs 汇总。不调用要联网或要模型的子命令（beat analyze / doctor、song generate / doctor / prepare）。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const goAm = process.env.AM_GO || path.join(os.homedir(), '.local/bin/am');

function goRun(cwd, ...args) {
  const r = spawnSync(goAm, args, { cwd, encoding: 'utf8', env: { ...process.env, AM_MEMORY_DIR: path.join(cwd, '..', 'home', 'memory') } });
  if (r.status !== 0) throw new Error(`准备步骤失败：am ${args.join(' ')}\n${r.stderr}`);
}

function ffmpeg(...args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${r.stderr}`);
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** 一个最小镜头目录：scene.json 用不同的键顺序与数字写法，检验 cues 对原文的保留与重排。 */
function sceneDir(base, id, duration, extra = {}) {
  const dir = path.join(base, 'scenes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  const fields = { text: 'hello <b> & 2.50', id, output: 'out.mp4', duration_seconds: duration, transcript: 'transcript.srt', ...extra };
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(fields, null, 4).replace(/"duration_seconds": 1(?=[,\n])/, '"duration_seconds": 1.000'));
  return dir;
}

/**
 * 卡点项目：6.5 秒音乐、120 BPM、4/4、弱起 0.5 秒，共 3 小节。草稿网格直接写盘（代替要 Python 的 analyze），
 * 重拍故意错一拍，再由 Go 版 regrid、confirm 纠正。cued 为真时再由 Go 版写好镜头 cue。
 */
function beatFixture(base, { cued = false, plan } = {}) {
  goRun(base, 'beat', 'init');
  fs.writeFileSync(path.join(base, 'frame.md'), '---\nstyle_id: x\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6.5', path.join(base, 'loop.wav'));
  goRun(base, 'beat', 'import', 'loop.wav');
  const track = JSON.parse(fs.readFileSync(path.join(base, 'production/beat/track.json'), 'utf8'));
  const beats = Array.from({ length: 13 }, (_, i) => i * 0.5);
  writeJSON(path.join(base, 'production/beat/grid-draft.json'), {
    schema: 1,
    audio_sha256: track.audio_sha256,
    duration_seconds: track.duration_seconds,
    source: 'test',
    reviewed: false,
    beats,
    downbeats: [0, 2, 4, 6],
  });
  goRun(base, 'beat', 'regrid', '--meter', '4', '--anchor', '1');
  goRun(base, 'beat', 'confirm');
  sceneDir(base, 'scene-001', 1);
  sceneDir(base, 'scene-002', 1);
  writeJSON(path.join(base, 'production/beat/plan.json'), plan ?? { schema: 1, scenes: [{ id: 'scene-001', bars: 2 }, { id: 'scene-002', bars: 1 }] });
  if (cued) goRun(base, 'beat', 'cues', 'scenes');
}

/** 歌曲项目：选定一个候选、写好已复核的时间轴、两个镜头（1.5 秒 + 46 帧）。cued 为真时再由 Go 版写好镜头 cue。 */
function songFixture(base, { cued = false } = {}) {
  const dir = path.join(base, 'production/song/candidates/chosen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio.mp3'), 'audio');
  fs.writeFileSync(path.join(dir, 'lyrics.txt'), '歌词\n歌词');
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const audioSHA = sha(path.join(dir, 'audio.mp3'));
  const lyricsSHA = sha(path.join(dir, 'lyrics.txt'));
  writeJSON(path.join(dir, 'candidate.json'), {
    id: 'chosen',
    state: 'ready',
    audio: 'audio.mp3',
    lyrics: 'lyrics.txt',
    audio_sha256: audioSHA,
    lyrics_sha256: lyricsSHA,
    duration_seconds: 3.01,
  });
  goRun(base, 'song', 'select', 'chosen');
  writeJSON(path.join(base, 'timeline-input.json'), {
    schema: 1,
    candidate_id: 'chosen',
    audio_sha256: audioSHA,
    lyrics_sha256: lyricsSHA,
    duration_seconds: 3.01,
    source: 'manual',
    reviewed: true,
    lines: [
      { id: 'line-1', source_line: 1, text: '歌词', alignment_text: '歌词', start: 0.3, end: 1.8, words: [{ text: '歌', start: 0.3, end: 1.0 }] },
      { id: 'line-2', source_line: 2, text: '歌词', alignment_text: '歌词', start: 2.1, end: 2.8 },
    ],
    beats: [0.3, 1, 2, 3],
  });
  goRun(base, 'song', 'prepare', '--timeline', 'timeline-input.json', '--reviewed');
  const frame = fs.readFileSync(path.join(base, 'frame.md'));
  [1.5, 46 / 30].forEach((duration, i) => {
    const d = sceneDir(base, `scene-00${i + 1}`, duration, { style_guide: 'frame.md' });
    fs.writeFileSync(path.join(d, 'frame.md'), frame);
  });
  if (cued) goRun(base, 'song', 'cues', 'scenes');
}

/** 外部角色包（另一个 id），供 cast add 引入。 */
function externalPack(base) {
  const dir = path.join(base, 'ext', 'xiaoming');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'character.yaml'),
    `schema: cast/v1
id: xiaoming
name: 小明
summary: 对照用例的外部角色包
voice:
  minimax: { voiceId: "v-1", speed: 0.98 }
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head:     { pivot: [200, 168], rotate: [-18, 18] }
    frontLeg: { pivot: [176, 330], rotate: [-40, 55] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
  pointing: { frontLeg: 48, head: -6 }
`,
  );
  fs.writeFileSync(
    path.join(dir, 'rig.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520">
  <g id="j-head"><circle cx="200" cy="168" r="60" fill="#fff" stroke="#000" stroke-width="6"/></g>
  <g id="j-frontLeg"><path d="M176 330 L176 420" stroke="#000" stroke-width="6"/></g>
</svg>
`,
  );
  fs.mkdirSync(path.join(dir, 'refs'));
  fs.writeFileSync(path.join(dir, 'refs', 'note.txt'), '参考');
  // 带符号链接的坏包。
  const bad = path.join(base, 'ext', 'linked');
  fs.cpSync(dir, bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'character.yaml'), fs.readFileSync(path.join(dir, 'character.yaml'), 'utf8').replace('id: xiaoming', 'id: linked'));
  fs.symlinkSync('/etc/hosts', path.join(bad, 'evil-link'));
}

/** 两段配音 + plan.json，Go 版装配好对白，镜头带 cast 块但还没有 beats。 */
function dialogueFixture(base, { assembled = true } = {}) {
  const audio = path.join(base, 'production/audio');
  fs.mkdirSync(audio, { recursive: true });
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.000', '-ar', '22050', '-ac', '2', path.join(audio, 'seg-001-heiwa.wav'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.500', '-ar', '22050', '-ac', '2', path.join(audio, 'seg-002-zhaocai.wav'));
  writeJSON(path.join(audio, 'plan.json'), {
    schema: 'cast-dialogue/v1',
    segments: [
      { index: 1, speaker: 'heiwa', voiceId: 'v-1', audio: 'production/audio/seg-001-heiwa.wav', gapAfterMs: 200, lines: [{ text: '第一句', startSeconds: 0, endSeconds: 1.0 }] },
      { index: 2, speaker: 'zhaocai', voiceId: 'v-2', audio: 'production/audio/seg-002-zhaocai.wav', gapAfterMs: 0, lines: [{ text: '等一下', startSeconds: 0, endSeconds: 0.5 }] },
    ],
  });
  goRun(base, 'cast', 'new', 'heiwa');
  goRun(base, 'cast', 'new', 'zhaocai');
  if (!assembled) return;
  goRun(base, 'dialogue', 'assemble');
  const scene = path.join(base, 'scenes', 'scene-001');
  fs.mkdirSync(scene, { recursive: true });
  fs.writeFileSync(path.join(scene, 'transcript.txt'), '占位字幕');
  fs.cpSync(path.join(base, 'cast'), path.join(scene, 'cast'), { recursive: true });
  fs.writeFileSync(
    path.join(scene, 'scene.json'),
    `{
  "id": "scene-001",
  "duration_seconds": 1.7,
  "output": "out.mp4",
  "transcript": "transcript.txt",
  "text": "两人说话",
  "cast": {
    "pack_dir": "cast",
    "ground_y": 0.78,
    "on_stage": [
      {"id": "heiwa", "x": 0.3, "pose": "idle", "facing": "right"},
      {"id": "zhaocai", "x": 0.7, "pose": "idle", "facing": "left"}
    ]
  }
}
`,
  );
}

const help = (...path) => [...path, '--help'];

export const cases = [
  {
    name: 'beat song cast help',
    commands: [
      help('beat'),
      ...['init', 'doctor', 'import', 'analyze', 'regrid', 'click', 'confirm', 'bars', 'cues'].map((sub) => help('beat', sub)),
      help('song'),
      ...['providers', 'configure', 'init', 'handoff', 'receive', 'doctor', 'generate', 'import', 'select', 'prepare', 'cues', 'mux'].map((sub) => help('song', sub)),
      help('cast'),
      ...['new', 'add', 'validate', 'preview'].map((sub) => help('cast', sub)),
      help('dialogue'),
      help('dialogue', 'assemble'),
      help('dialogue', 'beats'),
      help('validate', 'beat'),
      help('validate', 'song'),
      help('validate', 'cast'),
      ['beat'],
      ['song'],
      ['cast'],
      ['dialogue'],
    ],
  },
  {
    name: 'beat outside a beat project',
    commands: [
      ['beat', 'init'],
      ['beat', 'init', 'extra'],
      ['beat', 'bars'],
      ['beat', 'cues'],
      ['beat', 'cues', 'scenes'],
      ['beat', 'confirm'],
      ['beat', 'regrid'],
      ['beat', 'analyze', '--timeout', '0s'],
      ['validate', 'beat'],
    ],
  },
  {
    name: 'beat init conflicts',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song']],
    commands: [['beat', 'init']],
  },
  {
    name: 'beat project before cues',
    prepare: (base) => beatFixture(base),
    commands: [
      ['beat', 'bars'],
      ['beat', 'cues', 'scenes'],
      ['beat', 'cues', 'scenes', '--project-root', 'scenes'],
      ['beat', 'cues', 'nowhere'],
      ['validate', 'beat'],
      ['beat', 'confirm'],
      ['beat', 'regrid', '--meter', '3', '--anchor', '0'],
      ['beat', 'regrid', '--meter', '0'],
      ['beat', 'click'],
      ['beat', 'click', '--grid', 'missing.json'],
      ['beat', 'import', 'loop.wav'],
      ['beat', 'import', 'missing.wav'],
    ],
  },
  {
    name: 'beat project after cues',
    prepare: (base) => beatFixture(base, { cued: true }),
    commands: [['validate', 'beat'], ['validate', 'beat', '--scenes', 'scenes'], ['beat', 'cues', 'scenes'], ['beat', 'bars']],
  },
  {
    name: 'beat plan mismatches',
    prepare: (base) => beatFixture(base, { plan: { schema: 1, scenes: [{ id: 'scene-002', bars: 2 }, { id: 'scene-001', bars: 1 }] } }),
    commands: [['beat', 'cues', 'scenes'], ['validate', 'beat']],
  },
  {
    name: 'beat plan bar count',
    prepare: (base) => beatFixture(base, { plan: { schema: 1, scenes: [{ id: 'scene-001', bars: 1 }, { id: 'scene-002', bars: 1 }] } }),
    commands: [['beat', 'cues', 'scenes']],
  },
  {
    name: 'song commands',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [
      ['song', 'init'],
      ['song', 'providers'],
      ['song', 'providers', 'fal'],
      ['song', 'providers', 'manual'],
      ['song', 'providers', 'nope'],
      ['song', 'providers', 'a', 'b'],
      ['song', 'configure', '--provider', 'elevenlabs'],
      ['song', 'select', 'nope'],
      ['song', 'cues', 'scenes'],
      ['validate', 'song'],
      ['song', 'init', '--timeout', '0s'],
    ],
  },
  {
    name: 'song project setup',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song']],
    prepare: (base) => fs.writeFileSync(path.join(base, 'lyrics.txt'), '太阳照着水面\n水汽升上蓝天'),
    commands: [
      ['song', 'init'],
      ['song', 'configure', '--provider', 'manual'],
      ['song', 'configure', '--provider', 'mureka'],
      ['song', 'configure', '--provider', 'bailian', '--workspace', 'ws-1'],
      ['song', 'configure', '--provider', 'nope'],
      ['song', 'configure'],
      ['song', 'generate', '--count', '9'],
      ['song', 'import', 'x.mp3'],
      ['song', 'mux', 'x.mp4'],
    ],
  },
  {
    name: 'song cues',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song']],
    prepare: (base) => songFixture(base),
    commands: [
      ['song', 'cues', 'scenes'],
      ['validate', 'song'],
      ['song', 'mux', 'x.mp4', '--out', 'final.mp4'],
      ['song', 'prepare', '--timeline', 'timeline-input.json', '--reviewed'],
      ['song', 'prepare', '--timeline', 'timeline-input.json'],
      ['song', 'select', 'chosen'],
    ],
  },
  {
    name: 'song cues 9x16',
    setup: [['init', '--canvas', 'vertical-9x16', '--skip-hyperframes', '--delivery', 'song']],
    prepare: (base) => songFixture(base),
    commands: [['song', 'cues', 'scenes']],
  },
  {
    name: 'song after cues',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song']],
    prepare: (base) => songFixture(base, { cued: true }),
    commands: [['validate', 'song'], ['validate', 'song', '--scenes', 'scenes'], ['song', 'cues', 'scenes']],
  },
  {
    name: 'cast commands',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--narration', 'cast']],
    prepare: externalPack,
    ignore: [/^production\/cast-preview\//],
    commands: [
      ['cast', 'new', 'heiwa'],
      ['cast', 'new'],
      ['cast', 'validate'],
      ['cast', 'validate', 'ext/xiaoming'],
      ['cast', 'validate', '--provider', 'bailian', 'ext/xiaoming', 'missing'],
      ['cast', 'add', 'ext/xiaoming'],
      ['cast', 'add', 'ext/linked'],
      ['cast', 'add', 'missing'],
      ['cast', 'preview', 'ext/xiaoming'],
      ['cast', 'preview', 'missing'],
      ['validate', 'cast'],
      ['validate', 'cast', '--provider', 'minimax'],
    ],
  },
  {
    name: 'cast without roster',
    commands: [['cast', 'validate'], ['cast', 'new', 'heiwa'], ['validate', 'cast'], ['dialogue', 'beats'], ['dialogue', 'assemble']],
  },
  {
    name: 'cast with packs',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--narration', 'cast'], ['cast', 'new', 'heiwa']],
    commands: [['cast', 'new', 'heiwa'], ['cast', 'new', 'zhaocai'], ['cast', 'validate'], ['cast', 'validate', '--provider', 'minimax'], ['validate', 'cast']],
  },
  {
    name: 'dialogue assemble',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--narration', 'cast']],
    prepare: (base) => dialogueFixture(base, { assembled: false }),
    commands: [
      ['dialogue', 'assemble'],
      ['dialogue', 'assemble', '--expect-total', '1.7'],
      ['dialogue', 'assemble', '--expect-total', '5'],
      ['dialogue', 'assemble', '--plan', 'nope.json'],
      ['dialogue', 'assemble', 'extra'],
    ],
  },
  {
    name: 'dialogue beats',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--narration', 'cast']],
    prepare: (base) => dialogueFixture(base),
    commands: [['dialogue', 'beats'], ['validate', 'cast'], ['validate', 'cast', '--provider', 'minimax']],
  },
];
