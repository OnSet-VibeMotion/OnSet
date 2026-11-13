// 歌曲讲解的镜头块：scene.json 的 song 字段。移植自 internal/scene/scene.go 的 song 部分。
import path from 'node:path';
import * as song from '../../song';
import { registerBlock, verifyBlock, type SceneBlock } from '../block';
import type { StructType } from '../jsondecode';
import { sceneCanvas, type Canvas, type Scene } from '../scene';
import { songExplainerPrompt, SongExplainerSkillName } from '../skills';
import { VerificationError } from '../verification';

declare module '../scene' {
  interface Scene {
    song: song.Cue | null;
  }
}

const songCueType: StructType = {
  kind: 'struct',
  goName: 'song.Cue',
  name: 'Cue',
  fields: [
    ['fps', 'int'],
    ['timeline', 'string'],
    ['sha256', 'string'],
    ['start_seconds', 'float'],
    ['data', 'string'],
    ['data_sha256', 'string'],
  ],
};

function songSection(s: Scene, resolved: Record<string, string>): string {
  if (s.song === null) return '';
  return (
    `\n歌曲镜头（强制）：读取 ${s.song.data} 的局部歌词与节拍。时长包含前奏、间奏或尾奏；不得填造字幕。节拍仅控制装饰，不能提前揭示歌词。不得生成或替换歌曲、改写全局时间轴。\n` +
    songExplainerPrompt(resolved[SongExplainerSkillName] ?? '')
  );
}

function verification(s: Scene, problem: string): VerificationError {
  return new VerificationError(s.output, [problem]);
}

function verifySong(s: Scene): void {
  if (s.song !== null) {
    let canvas: Canvas;
    try {
      canvas = sceneCanvas(s);
    } catch (err) {
      throw verification(s, (err as Error).message);
    }
    if (s.song.fps !== canvas.fps) throw verification(s, '歌曲镜头帧率与画幅不符，请重新 cues');
    try {
      song.verifyCue(s.directory, s.song, s.duration_seconds);
    } catch (err) {
      throw verification(s, (err as Error).message);
    }
    return;
  }
  let dir = path.resolve(s.directory);
  for (;;) {
    if (song.enabled(dir)) throw verification(s, '歌曲镜头缺少 song 块，请运行 song_cues()');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const songBlock: SceneBlock<song.Cue> = {
  key: 'song',
  order: 20,
  type: songCueType,
  toJSON: song.cueToJSON,
  excludes: { keys: ['cast'], message: '首版不支持 song + cast' },
  verifyInputs: verifySong,
  timeline: { label: '歌曲' },
  promptSection: songSection,
};
registerBlock(songBlock);

/** 核对歌曲镜头的 song 块。复用已有产物前同样要检查。 */
export function verifySongInputs(s: Scene): void {
  verifyBlock(songBlock as SceneBlock, s);
}
