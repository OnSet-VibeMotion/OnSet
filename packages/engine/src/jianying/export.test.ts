/**
 * 剪映可二次编辑素材包导出真实 FFmpeg 集成测试。
 * 现场用 FFmpeg 合成 2 个镜头 MP4 + 旁白/BGM/SFX WAV + SRT，不签入任何二进制 fixture，
 * 全部临时文件落在 os.tmpdir() 并在 afterEach 中清理（保持 boundary.test.ts 洁净）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envMap, lookPath } from '../envutil';
import { newToolchain, videoFPS } from '../mediaprobe';
import { DraftCompatibilityNote, exportJianying, resolveExportDir } from './index';

function which(name: string): string | null {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return null;
  }
}

const ffmpegBin = which('ffmpeg');
const ffprobeBin = which('ffprobe');
const hasFfmpeg = ffmpegBin !== null && ffprobeBin !== null;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function runFfmpeg(...args: string[]): void {
  const res = spawnSync(ffmpegBin!, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg 测试素材生成失败：${res.stderr || res.stdout}`);
  }
}

function probeFirstFrameKeyframe(file: string): { keyFrame: number; pictType: string } {
  const res = spawnSync(
    ffprobeBin!,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-read_intervals',
      '%+#1',
      '-show_entries',
      'frame=key_frame,pict_type',
      '-print_format',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`ffprobe 帧检查失败：${res.stderr}`);
  const parsed = JSON.parse(res.stdout) as { frames?: Array<{ key_frame?: number; pict_type?: string }> };
  const first = parsed.frames?.[0];
  return { keyFrame: Number(first?.key_frame ?? 0), pictType: String(first?.pict_type ?? '') };
}

function writeFrameMd(root: string, width: number, height: number, fps: number): void {
  fs.writeFileSync(
    path.join(root, 'frame.md'),
    `---\ncanvas:\n  width_px: ${width}\n  height_px: ${height}\n  fps: ${fps}\n---\n`,
  );
}

describe('jianying export', () => {
  it('blocks path traversal and non-empty overwrite without overwrite=true', () => {
    const root = makeTempDir('onset-jy-path-');
    expect(() => resolveExportDir(root, '../escape', 'demo', false)).toThrow('不能越出项目根目录');
    expect(() => resolveExportDir(root, '../../etc', 'demo', false)).toThrow('不能越出项目根目录');
    expect(() => resolveExportDir(root, 'scenes/sub', 'demo', false)).toThrow('受保护的项目子目录');
    expect(() => resolveExportDir(root, root, 'demo', false)).toThrow('不能是项目根目录');
    expect(() => resolveExportDir(root, undefined, '../bad', false)).toThrow('非法的导出包名称');

    const nonEmpty = path.join(root, 'exports', 'existing');
    fs.mkdirSync(nonEmpty, { recursive: true });
    fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'hi');
    expect(() => resolveExportDir(root, 'exports/existing', 'demo', false)).toThrow('已存在且非空');
    expect(resolveExportDir(root, 'exports/existing', 'demo', true)).toBe(nonEmpty);
  });

  it.skipIf(!hasFfmpeg)(
    'exports exact re-encoded shots, aligned audio stems, subtitles, README and self-consistent draft skeleton',
    async () => {
      const root = makeTempDir('onset-jy-proj-');
      const fps = 30;
      const width = 320;
      const height = 240;
      writeFrameMd(root, width, height, fps);

      // 构造 2 个真实合成镜头 MP4（第 1 镜 30 帧=1.0s，第 2 镜 45 帧=1.5s，合计 75 帧=2.5s）。
      const s1Dir = path.join(root, 'scenes', 'scene-001');
      const s2Dir = path.join(root, 'scenes', 'scene-002');
      fs.mkdirSync(s1Dir, { recursive: true });
      fs.mkdirSync(s2Dir, { recursive: true });

      runFfmpeg(
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x1e3a8a:s=${width}x${height}:r=${fps}:d=1`,
        '-frames:v',
        '30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        path.join(s1Dir, 'scene.mp4'),
      );
      runFfmpeg(
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0xb91c1c:s=${width}x${height}:r=${fps}:d=1.5`,
        '-frames:v',
        '45',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        path.join(s2Dir, 'scene.mp4'),
      );

      fs.writeFileSync(
        path.join(s1Dir, 'scene.json'),
        JSON.stringify({
          id: 'scene-001',
          duration_seconds: 1.0,
          output: 'scene.mp4',
          timing: { fps, start_frame: 0, end_frame_exclusive: 30, chapter: '开场' },
        }),
      );
      fs.writeFileSync(
        path.join(s2Dir, 'scene.json'),
        JSON.stringify({
          id: 'scene-002',
          duration_seconds: 1.5,
          output: 'scene.mp4',
          timing: { fps, start_frame: 30, end_frame_exclusive: 75, chapter: '展开' },
        }),
      );
      fs.mkdirSync(path.join(root, 'production', 'audio'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'production', 'scene-plan.json'),
        JSON.stringify({ scenes: [{ dir: 'scenes/scene-001' }, { dir: 'scenes/scene-002' }] }),
      );

      // 真实合成旁白 voice.wav（440Hz）与 BGM music.wav（220Hz）以及 SFX sfx.wav（880Hz）。
      runFfmpeg(
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=2.5',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        path.join(root, 'production', 'audio', 'voice.wav'),
      );
      runFfmpeg(
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000:duration=2.5',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        path.join(root, 'production', 'audio', 'music.wav'),
      );
      runFfmpeg(
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=48000:duration=0.4',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        path.join(root, 'production', 'audio', 'sfx.wav'),
      );

      const srtBody = [
        '1',
        '00:00:00,000 --> 00:00:01,000',
        '第一句开场白',
        '',
        '2',
        '00:00:01,000 --> 00:00:02,500',
        '第二句核心观点',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(root, 'transcription.srt'), srtBody, 'utf8');

      const result = await exportJianying(root, {
        name: 'pilot-demo',
        includeDraft: true,
        env: envMap(),
      });

      expect(result.output_dir).toBe(path.join(root, 'exports', 'jianying-pilot-demo'));
      expect(result.clips).toEqual(['clips/shot-01.mp4', 'clips/shot-02.mp4']);
      expect(result.audio_tracks).toEqual(['audio/voice.wav', 'audio/bgm.wav', 'audio/sfx.wav']);
      expect(result.subtitles).toBe('subtitles.srt');
      expect(result.total_frames).toBe(75);
      expect(result.total_duration_us).toBe(2_500_000);

      // 1. ffprobe 校验分镜精准帧数、h264、yuv420p、无音轨、首帧为关键帧。
      const tc = newToolchain(envMap());
      const clip1 = path.join(result.output_dir, 'clips', 'shot-01.mp4');
      const clip2 = path.join(result.output_dir, 'clips', 'shot-02.mp4');
      expect(tc.countFrames(clip1)).toBe(30);
      expect(tc.countFrames(clip2)).toBe(45);
      for (const clip of [clip1, clip2]) {
        const media = tc.probe(clip);
        expect(media.video?.codec).toBe('h264');
        expect(media.video?.pixel_format).toBe('yuv420p');
        expect(media.video?.width_px).toBe(width);
        expect(media.video?.height_px).toBe(height);
        expect(Math.round(videoFPS(media.video!))).toBe(fps);
        expect(media.audio).toBeNull();
        const kf = probeFirstFrameKeyframe(clip);
        expect(kf.keyFrame).toBe(1);
        expect(kf.pictType).toBe('I');
      }

      // 2. 分轨音频校验：48kHz 立体声且时长对齐 2.5s。
      for (const rel of ['audio/voice.wav', 'audio/bgm.wav', 'audio/sfx.wav']) {
        const full = path.join(result.output_dir, ...rel.split('/'));
        expect(fs.existsSync(full), rel).toBe(true);
        const m = tc.probe(full);
        expect(m.audio?.sample_rate).toBe(48_000);
        expect(m.audio?.channels).toBe(2);
        expect(Math.abs(m.duration_seconds - 2.5)).toBeLessThan(0.02);
      }

      // 3. 字幕、shots.json、audio.json、README.md 校验。
      const exportedSrt = fs.readFileSync(path.join(result.output_dir, 'subtitles.srt'), 'utf8');
      expect(exportedSrt).toContain('第一句开场白');
      expect(exportedSrt).toContain('第二句核心观点');

      const shotsJson = JSON.parse(fs.readFileSync(path.join(result.output_dir, 'shots.json'), 'utf8'));
      expect(shotsJson.total_frames).toBe(75);
      expect(shotsJson.total_duration_us).toBe(2_500_000);
      expect(shotsJson.shots).toHaveLength(2);
      expect(shotsJson.shots[0]).toMatchObject({
        index: 1,
        scene_id: 'scene-001',
        start_frame: 0,
        end_frame_exclusive: 30,
        frames: 30,
        start_us: 0,
        duration_us: 1_000_000,
      });
      expect(shotsJson.shots[1]).toMatchObject({
        index: 2,
        scene_id: 'scene-002',
        start_frame: 30,
        end_frame_exclusive: 75,
        frames: 45,
        start_us: 1_000_000,
        duration_us: 1_500_000,
      });

      const audioJson = JSON.parse(fs.readFileSync(path.join(result.output_dir, 'audio.json'), 'utf8'));
      expect(audioJson.tracks.map((t: { role: string }) => t.role)).toEqual(['voice', 'bgm', 'sfx']);
      expect(audioJson.total_duration_us).toBe(2_500_000);

      const readme = fs.readFileSync(path.join(result.output_dir, 'README.md'), 'utf8');
      expect(readme).toContain('clips/');
      expect(readme).toContain('audio/');
      expect(readme).toContain('subtitles.srt');
      expect(readme).toContain('未绑定特定剪映宿主版本');

      // 4. draft_content.json & draft_meta_info.json 三轨微秒时间码与总时长严格自洽。
      expect(result.draft).not.toBeNull();
      expect(result.draft?.compatibility_note).toBe(DraftCompatibilityNote);
      const draftContent = JSON.parse(fs.readFileSync(path.join(result.output_dir, 'draft_content.json'), 'utf8'));
      const draftMeta = JSON.parse(fs.readFileSync(path.join(result.output_dir, 'draft_meta_info.json'), 'utf8'));
      expect(draftContent.duration).toBe(2_500_000);
      expect(draftMeta.tm_duration).toBe(2_500_000);
      expect(draftContent.tracks.map((t: { type: string }) => t.type)).toEqual(['video', 'audio', 'text']);

      const [videoTrack, audioTrack, textTrack] = draftContent.tracks;
      const videoMatIds = new Set(draftContent.materials.videos.map((m: { id: string }) => m.id));
      const audioMatIds = new Set(draftContent.materials.audios.map((m: { id: string }) => m.id));
      const textMatIds = new Set(draftContent.materials.texts.map((m: { id: string }) => m.id));

      expect(videoTrack.segments).toHaveLength(2);
      expect(videoTrack.segments[0].target_timerange).toEqual({ start: 0, duration: 1_000_000 });
      expect(videoTrack.segments[1].target_timerange).toEqual({ start: 1_000_000, duration: 1_500_000 });
      const sumVideoUs = videoTrack.segments.reduce(
        (acc: number, seg: { target_timerange: { duration: number } }) => acc + seg.target_timerange.duration,
        0,
      );
      expect(sumVideoUs).toBe(draftContent.duration);
      for (const seg of videoTrack.segments) expect(videoMatIds.has(seg.material_id)).toBe(true);

      expect(audioTrack.segments).toHaveLength(3);
      for (const seg of audioTrack.segments) {
        expect(audioMatIds.has(seg.material_id)).toBe(true);
        expect(seg.target_timerange).toEqual({ start: 0, duration: 2_500_000 });
      }

      expect(textTrack.segments).toHaveLength(2);
      expect(textTrack.segments[0].target_timerange).toEqual({ start: 0, duration: 1_000_000 });
      expect(textTrack.segments[1].target_timerange).toEqual({ start: 1_000_000, duration: 1_500_000 });
      for (const seg of textTrack.segments) expect(textMatIds.has(seg.material_id)).toBe(true);
    },
    30_000,
  );

  it.skipIf(!hasFfmpeg)(
    'cuts frame-exact shots from silent-master.mp4 when per-scene MP4s are absent',
    async () => {
      const root = makeTempDir('onset-jy-master-');
      writeFrameMd(root, 320, 240, 30);
      fs.mkdirSync(path.join(root, 'production'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scenes', 'scene-001'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scenes', 'scene-002'), { recursive: true });

      runFfmpeg(
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30:duration=2',
        '-frames:v',
        '60',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        path.join(root, 'production', 'silent-master.mp4'),
      );
      fs.writeFileSync(
        path.join(root, 'scenes', 'scene-001', 'scene.json'),
        JSON.stringify({
          id: 'scene-001',
          duration_seconds: 0.8,
          output: 'scene.mp4',
          timing: { fps: 30, start_frame: 0, end_frame_exclusive: 24 },
        }),
      );
      fs.writeFileSync(
        path.join(root, 'scenes', 'scene-002', 'scene.json'),
        JSON.stringify({
          id: 'scene-002',
          duration_seconds: 1.2,
          output: 'scene.mp4',
          timing: { fps: 30, start_frame: 24, end_frame_exclusive: 60 },
        }),
      );

      const dest = path.join(makeTempDir('onset-jy-out-'), 'cut-pack');
      const res = await exportJianying(root, { dest, includeDraft: false, env: envMap() });
      expect(res.draft).toBeNull();
      expect(fs.existsSync(path.join(dest, 'draft_content.json'))).toBe(false);
      const tc = newToolchain(envMap());
      expect(tc.countFrames(path.join(dest, 'clips', 'shot-01.mp4'))).toBe(24);
      expect(tc.countFrames(path.join(dest, 'clips', 'shot-02.mp4'))).toBe(36);
    },
    30_000,
  );
});
