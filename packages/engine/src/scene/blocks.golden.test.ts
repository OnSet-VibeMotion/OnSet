// 镜头扩展块的黄金测试：带 cast、song、beat、timing 块与什么块都没有的镜头，
// 各自的渲染提示词、输入指纹、onset-scene.js 与 scene.json 读入再写回的字节都钉在
// testdata/blocks-golden/ 里。块的实现搬家、换成注册表都不得改变其中任何一个字节：
// 那会让已有项目的镜头被判 Stale、提示词变样。
//
// 确实要改行为时，用 ONSET_UPDATE_GOLDEN=1 重新生成，并在提交里说明为什么变。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as beat from '../beat';
import { marshalIndent } from '../gojson';
import * as song from '../song';
import { fingerprint } from './record';
import { buildPrompt, load, sceneToJSON, type Scene } from './scene';
import { encodeSceneData, buildSceneData } from './scenedata';
import { SongExplainerSkillName } from '../plugins/song';
import { dataScene, frameWithCanvas, tempDir } from './testsupport';

const goldenDir = path.join(__dirname, 'testdata', 'blocks-golden');
const update = process.env.ONSET_UPDATE_GOLDEN === '1';

/** 提示词里给技能用的假路径：只在提示词里出现，不参与指纹（指纹要读技能目录）。 */
const fakeSkills = '/golden/skills';

interface Golden {
  prompt: string;
  prompt_with_skills: string;
  fingerprint: string;
  parts: Record<string, string>;
  scene_data: string;
  scene_json: string;
}

function capture(s: Scene): Golden {
  const inputs = fingerprint(s, 'claude', {});
  return {
    prompt: buildPrompt(s, {}),
    prompt_with_skills: buildPrompt(s, { [SongExplainerSkillName]: fakeSkills }),
    fingerprint: inputs.fingerprint,
    parts: inputs.parts ?? {},
    scene_data: encodeSceneData(buildSceneData(s)),
    scene_json: marshalIndent(sceneToJSON(load(s.directory))) + '\n',
  };
}

function check(name: string, s: Scene): void {
  const got = JSON.stringify(capture(s), null, 2) + '\n';
  const file = path.join(goldenDir, name + '.json');
  if (update) {
    fs.mkdirSync(goldenDir, { recursive: true });
    fs.writeFileSync(file, got);
    return;
  }
  expect(fs.existsSync(file), `缺少黄金文件 ${file}：用 ONSET_UPDATE_GOLDEN=1 生成`).toBe(true);
  expect(got).toBe(fs.readFileSync(file, 'utf8'));
}

function writeFile(file: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const transcript = '1\n00:00:00,000 --> 00:00:01,000\n一句话\n';

// 与 scene.test.ts 的最小角色包同一份契约。
const castYAML = `schema: cast/v1
id: heiwa
name: 黑娃
summary: 测试用最小角色包
voice:
  minimax: { voiceId: "v-1" }
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head: { pivot: [200, 168], rotate: [-18, 18] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
  pointing: {}
`;

const castSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520">
  <g id="j-head"><circle cx="200" cy="168" r="60" fill="#fff" stroke="#000" stroke-width="6"/></g>
</svg>`;

function writeCastPack(dir: string, id: string): void {
  writeFile(path.join(dir, 'cast', id, 'character.yaml'), castYAML.replace('id: heiwa', 'id: ' + id));
  writeFile(path.join(dir, 'cast', id, 'rig.svg'), castSVG);
}

function plainScene(extra: string): string {
  const dir = tempDir();
  writeFile(path.join(dir, 'transcript.srt'), transcript);
  writeFile(path.join(dir, 'frame.md'), frameWithCanvas(1080, 1920));
  writeFile(
    path.join(dir, 'scene.json'),
    `{"id":"scene-001","duration_seconds":4,"output":"scene-001.mp4","transcript":"transcript.srt","text":"一句话"${extra}}`,
  );
  return dir;
}

/** 歌曲项目：与 cli 的 song cues 测试同一套数据，镜头的 song 块按 song_cues() 的写法手算。 */
function songScene(): Scene {
  const root = tempDir();
  writeFile(path.join(root, 'song.yaml'), song.DefaultConfig);
  const cdir = path.join(root, song.Store, 'candidates', 'chosen');
  writeFile(path.join(cdir, 'audio.mp3'), 'audio');
  writeFile(path.join(cdir, 'lyrics.txt'), '歌词\n歌词');
  const c = song.candidate({ id: 'chosen', state: 'ready', audio: 'audio.mp3', lyrics: 'lyrics.txt', duration_seconds: 3.01 });
  c.audio_sha256 = song.hashFile(path.join(cdir, c.audio));
  c.lyrics_sha256 = song.hashFile(path.join(cdir, c.lyrics));
  song.writeJSON(path.join(cdir, 'candidate.json'), song.candidateToJSON(c));
  song.select(root, c.id);
  const tl = song.timeline({
    schema: 1,
    candidate_id: c.id,
    audio_sha256: c.audio_sha256,
    lyrics_sha256: c.lyrics_sha256,
    duration_seconds: c.duration_seconds,
    reviewed: true,
    lines: [song.line({ id: 'line-1', text: '歌词', start: 0.3, end: 1.8 }), song.line({ id: 'line-2', text: '歌词', start: 2.1, end: 2.8 })],
    beats: [0.3, 1, 2, 3],
  });
  song.saveTimeline(root, tl);
  const dir = path.join(root, 'shots', 'scene-001');
  writeFile(path.join(dir, 'transcript.srt'), '');
  writeFile(path.join(dir, 'frame.md'), frameWithCanvas(1080, 1440));
  const duration = 1.5;
  const timelineFile = path.join(root, song.Store, 'timeline.json');
  const local = song.slice(song.loadTimeline(root), 0, duration);
  song.writeJSON(path.join(dir, 'song-cues.json'), song.timelineToJSON(local));
  const cue = {
    fps: 30,
    timeline: path.relative(dir, timelineFile),
    sha256: song.hashFile(timelineFile),
    start_seconds: 0,
    data: 'song-cues.json',
    data_sha256: song.hashFile(path.join(dir, 'song-cues.json')),
  };
  writeFile(
    path.join(dir, 'scene.json'),
    JSON.stringify({ id: 'scene-001', duration_seconds: duration, output: 'out.mp4', transcript: 'transcript.srt', text: '歌词', song: cue }),
  );
  return load(dir);
}

/** 卡点项目：与 cli 的 beat 测试同一份网格（120 BPM、4/4、弱起 0.5 秒、3 小节），不经 ffmpeg 与分析。 */
function beatScene(): Scene {
  const root = tempDir();
  writeFile(path.join(root, beat.ConfigFile), beat.DefaultConfig);
  writeFile(path.join(root, beat.Store, 'loop.wav'), 'audio');
  const audioSHA = song.hashFile(path.join(root, beat.Store, 'loop.wav'));
  writeFile(
    path.join(root, beat.TrackFile),
    JSON.stringify(beat.trackToJSON({ audio: 'loop.wav', audio_sha256: audioSHA, duration_seconds: 6.5, source: 'loop.wav' })),
  );
  const grid = beat.newGrid({ schema: 1, audio_sha256: audioSHA, duration_seconds: 6.5, source: 'test', reviewed: true });
  grid.beats = [];
  for (let i = 0; i < 13; i++) grid.beats.push(i * 0.5);
  grid.downbeats = [0.5, 2.5, 4.5];
  writeFile(path.join(root, beat.GridFile), JSON.stringify(beat.gridToJSON(grid)));
  writeFile(path.join(root, beat.PlanFile), '{"schema":1,"scenes":[{"id":"scene-001","bars":2},{"id":"scene-002","bars":1}]}');
  const g = beat.loadGrid(root);
  const segment = beat.layout(g, beat.loadPlan(root), 30).find((s) => s.id === 'scene-001')!;
  const dir = path.join(root, 'shots', 'scene-001');
  writeFile(path.join(dir, 'transcript.srt'), '');
  writeFile(path.join(dir, 'frame.md'), frameWithCanvas(320, 240));
  const { body, sha256 } = beat.encodeLocal(beat.sliceGrid(g, segment, 30));
  writeFile(path.join(dir, beat.CueDataFile), body);
  const cue = {
    scene: 'scene-001',
    first_bar: segment.firstBar,
    bars: segment.bars,
    fps: 30,
    grid: beat.gridRef(dir, root),
    sha256: beat.gridSHA(root),
    start_frame: segment.startFrame,
    frames: segment.frames,
    data: beat.CueDataFile,
    data_sha256: sha256,
  };
  writeFile(
    path.join(dir, 'scene.json'),
    JSON.stringify({ id: 'scene-001', duration_seconds: segment.frames / 30, output: 'out.mp4', transcript: 'transcript.srt', text: '卡点', beat: cue }),
  );
  return load(dir);
}

describe('scene block golden', () => {
  it('no blocks', () => {
    const dir = plainScene('');
    writeFile(path.join(dir, 'prompt.md'), '创意方向：\n- 一张图讲清楚。\n');
    check('none', load(dir));
  });

  it('cast block', () => {
    const dir = plainScene(
      `,"cast":{"pack_dir":"cast","ground_y":0.78,"on_stage":[{"id":"heiwa","x":0.3,"pose":"pointing","facing":"right"}],` +
        `"beats":[{"speaker":"heiwa","start":0,"end":2},{"speaker":"zhaocai","start":2,"end":3.5}]}`,
    );
    writeCastPack(dir, 'heiwa');
    writeCastPack(dir, 'zhaocai');
    check('cast', load(dir));
  });

  it('cast block without anyone on stage', () => {
    const dir = plainScene(`,"cast":{"pack_dir":"cast","ground_y":0.78,"on_stage":[],"beats":[{"speaker":"heiwa","start":0,"end":2}]}`);
    writeCastPack(dir, 'heiwa');
    check('cast-offstage', load(dir));
  });

  it('song block', () => {
    check('song', songScene());
  });

  it('beat block', () => {
    check('beat', beatScene());
  });

  it('timing block', () => {
    check('timing', dataScene());
  });
});
