/**
 * 双跑对照用例（写法见 cases.mjs 开头的说明）。由 cases.mjs 汇总。
 *
 * 媒体相关命令：scene frames、scene lint、validate video、concat、review、validate reads。
 * 素材都在 prepare 里用 ffmpeg 合成；两边调用 ffmpeg 的参数相同，抽出的 PNG、拼出的 mp4 也逐字节相同。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function ffmpeg(...args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
}

function clip(file, filter) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ffmpeg('-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file);
}

function film(file, seconds) {
  ffmpeg(
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  );
}

function sceneDir(base, id, filter) {
  const dir = path.join(base, 'scenes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), `{"id":"${id}","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}`);
  clip(path.join(dir, 'out.mp4'), filter);
}

const frame320 =
  '---\nstyle_id: x\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\naudio:\n  final_integrated_lufs: -16\n  final_lufs_tolerance: 1\n  true_peak_max_dbtp: -1\n---\n';

function videoFixture(base) {
  clip(path.join(base, 'ok.mp4'), 'testsrc=size=320x240:rate=30:duration=1');
  clip(path.join(base, 'clip.mp4'), 'testsrc=size=320x240:rate=25:duration=1');
  clip(path.join(base, 'black.mp4'), 'color=c=black:size=320x240:rate=30:duration=1');
}

function mediaFixture(base) {
  fs.writeFileSync(path.join(base, 'frame.md'), frame320);
  sceneDir(base, 'scene-001', 'testsrc=size=320x240:rate=30:duration=1');
  sceneDir(base, 'scene-002', 'testsrc2=size=320x240:rate=30:duration=1');
  film(path.join(base, 'final.mp4'), 2);
  film(path.join(base, 'long.mp4'), 3);
  fs.mkdirSync(path.join(base, 'lint-bad'));
  fs.writeFileSync(path.join(base, 'lint-bad', 'index.html'), '<script>\nconst x = Math.random();\nconst t = Date.now();\n</script>');
  fs.mkdirSync(path.join(base, 'lint-ok', 'vendor'), { recursive: true });
  fs.writeFileSync(
    path.join(base, 'lint-ok', 'index.html'),
    '<script src="vendor/lib.js"></script>\n<script>const x = rng(); // am-allow-nondeterministic: demo\nrequestAnimationFrame(f); // am-allow-nondeterministic: 预览\n</script>',
  );
  fs.writeFileSync(path.join(base, 'lint-ok', 'vendor', 'lib.js'), 'Math.random();\n');
}

function blankScene(base) {
  sceneDir(base, 'scene-003', 'color=c=black:size=320x240:rate=30:duration=1');
}

function readsFixture(base) {
  const production = path.join(base, 'production');
  fs.mkdirSync(production, { recursive: true });
  fs.writeFileSync(
    path.join(production, 'visible-event-inventory.json'),
    JSON.stringify({
      schema: 1,
      fps: 30,
      events: [
        { event_id: 'a', scene_id: 'scene-001', text: '一共分三步', role: 'title', phrase_id: 'p1', enter_frame: 0, readable_start_frame: 5, readable_end_frame_exclusive: 60, exit_end_frame: 70 },
        { event_id: 'b', scene_id: 'scene-001', text: '第一步先把数据装进来再说', role: 'body', phrase_id: 'p2', enter_frame: 40, readable_start_frame: 45, readable_end_frame_exclusive: 60, exit_end_frame: 60 },
        { event_id: 'c', scene_id: 'scene-002', text: 'API 调用', role: 'label', phrase_id: 'p3', enter_frame: 80, readable_start_frame: 90, readable_end_frame_exclusive: 200, exit_end_frame: 210 },
        { event_id: 'd', scene_id: 'scene-002', text: '装饰', role: 'decorative', enter_frame: 90, readable_start_frame: 91, readable_end_frame_exclusive: 95, exit_end_frame: 96 },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(base, 'phrases.json'),
    JSON.stringify({
      fps: 30,
      phrases: [
        { phrase_id: 'p1', semantic_order: 1, start_frame: 30, end_frame_exclusive: 60 },
        { phrase_id: 'p2', semantic_order: 2, start_frame: 40, end_frame_exclusive: 90 },
        { phrase_id: 'p3', semantic_order: 3, start_frame: 80, end_frame_exclusive: 120 },
      ],
    }),
  );
  fs.writeFileSync(path.join(base, 'good.json'), JSON.stringify({ schema: 1, fps: 30, events: [{ event_id: 'a', scene_id: 'scene-001', text: '一共分三步', role: 'title', phrase_id: 'p1', enter_frame: 0, readable_start_frame: 5, readable_end_frame_exclusive: 60, exit_end_frame: 70 }] }));
  fs.writeFileSync(path.join(base, 'broken.json'), '{"schema":1,');
}

export const cases = [
  {
    name: 'media help',
    commands: [
      ['concat', '--help'],
      ['review', '--help'],
      ['scene', 'frames', '--help'],
      ['scene', 'lint', '--help'],
      ['validate', 'video', '--help'],
      ['validate', 'reads', '--help'],
      ['concat'],
      ['review'],
      ['scene', 'frames'],
      ['scene', 'lint', 'a', 'b'],
      ['validate', 'video'],
      ['validate', 'reads', 'x'],
    ],
  },
  {
    name: 'validate video',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    prepare: videoFixture,
    commands: [
      ['validate', 'video', 'ok.mp4', '--canvas', '320x240', '--fps', '30', '--silent', '--decode', '--report-json', 'r.json'],
      ['validate', 'video', 'ok.mp4', '--canvas', '320x240', '--fps', '30', '--expect-frames', '30', '--check-frame-zero', '--report-json', 'r.json'],
      ['validate', 'video', 'clip.mp4', '--canvas', '1080x1440', '--fps', '30', '--silent', '--report-json', 'r.json'],
      ['validate', 'video', 'ok.mp4', '--report-json', 'r.json'],
      ['validate', 'video', 'ok.mp4', '--canvas', '320x240', '--audio', '--duration', '2', '--codec', 'hevc', '--pixel-format', ''],
      ['validate', 'video', 'black.mp4', '--canvas', '320x240', '--check-frame-zero', '--report-json', 'r.json'],
      ['validate', 'video', 'ok.mp4', '--silent', '--audio'],
      ['validate', 'video', 'ok.mp4', '--canvas', 'abc'],
      ['validate', 'video', 'ok.mp4', '--canvas', '0x10'],
      ['validate', 'video', 'missing.mp4', '--canvas', '320x240'],
      ['validate', 'video', 'ok.mp4', '--project-root', 'nowhere'],
      ['validate', 'video', 'ok.mp4', '--canvas', '320x240', '--duration', '1', '--duration-tolerance', '-1'],
    ],
  },
  {
    name: 'scene frames and lint',
    prepare: (base) => {
      mediaFixture(base);
      blankScene(base);
    },
    commands: [
      ['scene', 'frames', 'scenes/scene-001', '--at', '0,50%,end', '--report-json', 'qc.json'],
      ['scene', 'frames', 'scenes/scene-001'],
      ['scene', 'frames', 'scenes/scene-003', '--at', '0', '--check-blank', '--report-json', 'qc.json'],
      ['scene', 'frames', 'scenes/scene-003', '--at', '0,end', '--out', 'qc'],
      ['scene', 'frames', 'scenes/scene-001', '--strip', '0.2:0.4', '--cols', '3', '--thumb-width', '64'],
      ['scene', 'frames', 'scenes/scene-001', '--at', '0', '--crop', '0,0,200,100'],
      ['scene', 'frames', 'scenes/scene-001', '--crop', '1000,0,10,10'],
      ['scene', 'frames', 'scenes/scene-001', '--crop', '1,2,3'],
      ['scene', 'frames', 'scenes/scene-001', '--at', 'abc'],
      ['scene', 'frames', 'scenes/scene-001', '--at', '5'],
      ['scene', 'frames', 'scenes/scene-001', '--at', '120%'],
      ['scene', 'frames', 'scenes/scene-001', '--at', ' , '],
      ['scene', 'frames', 'scenes/scene-001', '--strip', '0:2', '--at', '0'],
      ['scene', 'frames', 'scenes/scene-001', '--strip', '0.5:0.1'],
      ['scene', 'frames', 'scenes/scene-001', '--strip', '0.5'],
      ['scene', 'frames', 'scenes/nope'],
      ['scene', 'lint', 'lint-bad', '--report-json', 'lint.json'],
      ['scene', 'lint', 'lint-ok', '--report-json', 'lint.json'],
      ['scene', 'lint', 'nowhere'],
    ],
    // 抽帧报告里的 path / image 是镜头目录的绝对路径（两边的项目目录名不同），stdout 里已按 <PROJECT> 比对过。
    ignore: [/^qc\.json$/],
  },
  {
    name: 'concat',
    prepare: mediaFixture,
    commands: [
      ['concat', 'scenes', '--out', 'production/silent-master.mp4', '--dry-run'],
      ['concat', 'scenes', '--out', 'production/silent-master.mp4'],
      ['concat', 'scenes', '--out', 'master.mp4', '--canvas', '160x120', '--fps', '30'],
      ['concat', 'scenes', '--out', 'master.mp4', '--fps', '25', '--dry-run'],
      ['concat', 'scenes'],
      ['concat', 'nowhere', '--out', 'm.mp4'],
      ['concat', 'scenes', '--out', 'm.mp4', '--project-root', 'nowhere'],
    ],
  },
  {
    name: 'review',
    prepare: mediaFixture,
    commands: [
      ['review', 'final.mp4', '--scenes', 'scenes', '--out', 'rv', '--thumb-width', '64'],
      ['review', 'long.mp4', '--scenes', 'scenes', '--out', 'rv', '--thumb-width', '64', '--report-json', 'review.json'],
      ['review', 'final.mp4', '--out', 'rv', '--thumb-width', '64', '--every', '0.5', '--per-sheet', '2'],
      ['review', 'final.mp4', '--silent', '--fps', '30', '--out', 'rv', '--thumb-width', '64'],
      ['review', 'x.mp4', '--fps', '30'],
      ['review', 'x.mp4', '--out', 'rv', '--project-root', 'nowhere'],
    ],
  },
  {
    name: 'validate reads',
    prepare: readsFixture,
    commands: [
      ['validate', 'reads'],
      ['validate', 'reads', '--inventory', 'good.json', '--report-json', 'reads.json'],
      ['validate', 'reads', '--phrases', 'phrases.json', '--report-json', 'reads.json'],
      ['validate', 'reads', '--phrases', 'phrases.json', '--chars-per-second', '20', '--min-seconds', '0.2', '--crowd-seconds', '1'],
      ['validate', 'reads', '--phrases', 'missing.json'],
      ['validate', 'reads', '--inventory', 'broken.json'],
      ['validate', 'reads', '--chars-per-second', '0'],
      ['validate', 'reads', '--min-seconds', 'inf'],
      ['validate', 'reads', '--crowd-seconds', 'abc'],
      ['validate', 'reads', '--project-root', 'nowhere'],
    ],
  },
];
