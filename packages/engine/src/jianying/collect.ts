/**
 * 剪映导出前的项目素材发现与路径安全校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goRound } from '../gofmt';
import { compareBytes } from '../gojson';
import { canvasOf, contained } from '../scene';
import * as srt from '../srt';

export interface DiscoveredShot {
  sceneId: string;
  sourceFile: string;
  sourceRel: string;
  chapter?: string;
  /** 若需从整片母版切镜，记录整数帧起止（左闭右开）；独立镜头 MP4 为 undefined。 */
  trimStartFrame?: number;
  trimEndFrame?: number;
}

export interface DiscoveredAudioCue {
  kind: 'music' | 'sfx';
  assetRel: string;
  file: string;
  startFrame: number;
  durationFrames: number;
  sourceStartFrame: number;
  gainDB: number;
  fadeInFrames: number;
  fadeOutFrames: number;
}

export interface DiscoveredAudioStem {
  role: 'voice' | 'bgm' | 'sfx';
  file?: string;
  sourceRel: string;
  cues: DiscoveredAudioCue[];
}

export interface ProjectSources {
  root: string;
  fps?: number;
  widthPx?: number;
  heightPx?: number;
  shots: DiscoveredShot[];
  audio: DiscoveredAudioStem[];
  subtitleFile: string | null;
  subtitleRel: string | null;
  subtitles: srt.Cue[];
}

/** 清理素材包名称，拒绝路径穿越或空名。 */
export function sanitizeBundleName(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed === '.' ||
    trimmed === '..'
  ) {
    throw new Error(`非法的导出包名称：${raw}`);
  }
  const clean = trimmed.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_').replace(/^\.+/, '');
  if (clean === '') throw new Error(`导出包名称不能为空：${raw}`);
  return clean;
}

/**
 * 解析并校验剪映素材包输出目录：
 * - 留空时默认落到 <project>/exports/jianying-<name>/；
 * - 相对路径必须落在项目根目录内，拒绝 `..` 路径穿越；
 * - 拒绝指向项目根目录本身、其祖先目录，以及项目内的 `scenes/` 或 `.git/`；
 * - 拒绝非空目标目录（除非显式 overwrite=true）。
 */
export function resolveExportDir(
  projectRoot: string,
  dest: string | undefined,
  name: string,
  overwrite: boolean,
): string {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const safeName = sanitizeBundleName(name);
  let target: string;
  if (!dest || dest.trim() === '') {
    target = path.join(resolvedRoot, 'exports', `jianying-${safeName}`);
  } else {
    const raw = dest.trim();
    if (raw.includes('\0')) throw new Error('输出目录路径包含非法空字节');
    if (path.isAbsolute(raw)) {
      target = path.resolve(raw);
    } else {
      target = path.resolve(resolvedRoot, raw);
      const rel = path.relative(resolvedRoot, target);
      if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw new Error(`输出目录不能越出项目根目录：${dest}`);
      }
    }
  }
  if (target === resolvedRoot || resolvedRoot.startsWith(target + path.sep)) {
    throw new Error(`输出目录不能是项目根目录或其上级目录：${target}`);
  }
  const relToRoot = path.relative(resolvedRoot, target).split(path.sep).join('/');
  if (
    relToRoot === 'scenes' ||
    relToRoot.startsWith('scenes/') ||
    relToRoot === '.git' ||
    relToRoot.startsWith('.git/')
  ) {
    throw new Error(`输出目录不能落在受保护的项目子目录下：${relToRoot}`);
  }
  if (fs.existsSync(target)) {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`输出目标不是普通目录：${target}`);
    if (!overwrite && fs.readdirSync(target).length > 0) {
      throw new Error(`输出目录已存在且非空，拒绝覆盖：${target}（如需覆盖请设置 overwrite=true）`);
    }
  }
  return target;
}

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function safeInside(root: string, rel: string, label: string): string | null {
  try {
    const full = contained(root, rel, label);
    return isRegularFile(full) ? full : null;
  } catch {
    return null;
  }
}

interface RawSceneInfo {
  id: string;
  dir: string;
  output: string;
  durationSeconds: number;
  transcript: string;
  chapter?: string;
  timing?: { fps?: number; start_frame?: number; end_frame_exclusive?: number; chapter?: string };
}

function readSceneJSON(root: string, sceneDir: string): RawSceneInfo | null {
  const file = path.join(sceneDir, 'scene.json');
  if (!isRegularFile(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : path.basename(sceneDir);
    const output = typeof raw.output === 'string' && raw.output.trim() !== '' ? raw.output.trim() : 'scene.mp4';
    const durationSeconds =
      typeof raw.duration_seconds === 'number' && raw.duration_seconds > 0 ? raw.duration_seconds : 0;
    const transcript = typeof raw.transcript === 'string' ? raw.transcript.trim() : '';
    const timing =
      raw.timing && typeof raw.timing === 'object' && !Array.isArray(raw.timing)
        ? (raw.timing as RawSceneInfo['timing'])
        : undefined;
    const chapter = typeof timing?.chapter === 'string' && timing.chapter ? timing.chapter : undefined;
    // 确保镜头目录仍在项目根内。
    contained(root, path.relative(root, sceneDir), '镜头目录');
    return { id, dir: sceneDir, output, durationSeconds, transcript, chapter, timing };
  } catch {
    return null;
  }
}

function discoverRawScenes(root: string): RawSceneInfo[] {
  const orderedDirs: string[] = [];
  const planFile = path.join(root, 'production', 'scene-plan.json');
  if (isRegularFile(planFile)) {
    try {
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as { scenes?: Array<{ dir?: unknown }> };
      for (const entry of plan.scenes ?? []) {
        if (typeof entry?.dir === 'string' && entry.dir.trim() !== '') {
          const full = contained(root, entry.dir.trim(), '分镜镜头目录');
          if (fs.existsSync(full)) orderedDirs.push(full);
        }
      }
    } catch {
      // 计划文件不可读时退回扫描 scenes/。
    }
  }
  if (orderedDirs.length === 0) {
    const scenesRoot = path.join(root, 'scenes');
    if (fs.existsSync(scenesRoot) && fs.statSync(scenesRoot).isDirectory()) {
      const entries = fs.readdirSync(scenesRoot, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
      for (const entry of entries) {
        if (entry.isDirectory()) orderedDirs.push(path.join(scenesRoot, entry.name));
      }
    }
  }
  const out: RawSceneInfo[] = [];
  for (const dir of orderedDirs) {
    const info = readSceneJSON(root, dir);
    if (info) out.push(info);
  }
  return out;
}

function readCueSheet(root: string): DiscoveredAudioCue[] {
  const file = safeInside(root, 'production/audio/cue-sheet.json', 'cue sheet');
  if (!file) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { cues?: unknown[] };
    if (!Array.isArray(raw.cues)) return [];
    const out: DiscoveredAudioCue[] = [];
    for (const item of raw.cues) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const cue = item as Record<string, unknown>;
      if (cue.kind !== 'music' && cue.kind !== 'sfx') continue;
      if (typeof cue.asset !== 'string' || cue.asset.trim() === '') continue;
      const assetFile = safeInside(root, cue.asset.trim(), '音频 cue 素材');
      if (!assetFile) continue;
      const startFrame =
        typeof cue.start_frame === 'number' && Number.isSafeInteger(cue.start_frame) && cue.start_frame >= 0
          ? cue.start_frame
          : 0;
      const durationFrames =
        typeof cue.duration_frames === 'number' && Number.isSafeInteger(cue.duration_frames) && cue.duration_frames > 0
          ? cue.duration_frames
          : 0;
      if (durationFrames <= 0) continue;
      out.push({
        kind: cue.kind,
        assetRel: cue.asset.trim().replaceAll('\\', '/'),
        file: assetFile,
        startFrame,
        durationFrames,
        sourceStartFrame:
          typeof cue.source_start_frame === 'number' && cue.source_start_frame >= 0
            ? Math.trunc(cue.source_start_frame)
            : 0,
        gainDB:
          typeof cue.gain_db === 'number' && Number.isFinite(cue.gain_db)
            ? cue.gain_db
            : cue.kind === 'music'
              ? -18
              : -12,
        fadeInFrames:
          typeof cue.fade_in_frames === 'number' && cue.fade_in_frames >= 0 ? Math.trunc(cue.fade_in_frames) : 0,
        fadeOutFrames:
          typeof cue.fade_out_frames === 'number' && cue.fade_out_frames >= 0 ? Math.trunc(cue.fade_out_frames) : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function discoverSubtitles(
  root: string,
  scenes: readonly RawSceneInfo[],
): { file: string | null; rel: string | null; cues: srt.Cue[] } {
  const candidates = [
    'transcription.srt',
    'transcription-production.srt',
    'production/audio/voice.srt',
    'production/audio/production-srt.srt',
  ];
  for (const sc of scenes) {
    if (sc.transcript) {
      const rel = path.relative(root, path.resolve(sc.dir, sc.transcript)).split(path.sep).join('/');
      if (!rel.startsWith('..')) candidates.push(rel);
    }
  }
  for (const rel of candidates) {
    const file = safeInside(root, rel, '字幕文件');
    if (!file) continue;
    try {
      const cues = srt.readCues(file);
      return { file, rel, cues };
    } catch {
      // 跳过空或损坏候选，继续找下一份合法 SRT。
    }
  }
  return { file: null, rel: null, cues: [] };
}

/** 扫描片场项目中的镜头视频、分轨音频与字幕文件。 */
export function collectProjectSources(projectRoot: string): ProjectSources {
  const root = fs.realpathSync(projectRoot);
  let fps: number | undefined;
  let widthPx: number | undefined;
  let heightPx: number | undefined;
  if (isRegularFile(path.join(root, 'frame.md'))) {
    try {
      const c = canvasOf(root, 'frame.md');
      fps = c.fps;
      widthPx = c.widthPx;
      heightPx = c.heightPx;
    } catch {
      // 允许无标准 frame.md 的项目从镜头视频本身读取画幅与帧率。
    }
  }

  const rawScenes = discoverRawScenes(root);
  const sceneShots: DiscoveredShot[] = [];
  for (const sc of rawScenes) {
    const outRel = path.relative(root, path.resolve(sc.dir, sc.output)).split(path.sep).join('/');
    const outFile = safeInside(root, outRel, `镜头 ${sc.id} 视频`);
    if (outFile) {
      sceneShots.push({ sceneId: sc.id, sourceFile: outFile, sourceRel: outRel, chapter: sc.chapter });
    }
  }

  let shots: DiscoveredShot[] = [];
  if (sceneShots.length > 0 && sceneShots.length === rawScenes.length) {
    shots = sceneShots;
  } else {
    // 若缺少逐镜 MP4，尝试从整片母版按镜头边界切镜。
    const masterCandidates = ['production/silent-master.mp4', 'production/audio/candidate.mp4', 'final.mp4'];
    const masterRel = masterCandidates.find((rel) => safeInside(root, rel, '母版视频') !== null);
    const masterFile = masterRel ? safeInside(root, masterRel, '母版视频') : null;
    if (masterFile && masterRel && rawScenes.length > 0) {
      let cursor = 0;
      const fallbackFps = fps ?? 30;
      for (const sc of rawScenes) {
        const startFrame =
          typeof sc.timing?.start_frame === 'number' && sc.timing.start_frame >= 0 ? sc.timing.start_frame : cursor;
        const endFrame =
          typeof sc.timing?.end_frame_exclusive === 'number' && sc.timing.end_frame_exclusive > startFrame
            ? sc.timing.end_frame_exclusive
            : startFrame + Math.max(1, goRound(sc.durationSeconds * fallbackFps));
        shots.push({
          sceneId: sc.id,
          sourceFile: masterFile,
          sourceRel: masterRel,
          chapter: sc.chapter,
          trimStartFrame: startFrame,
          trimEndFrame: endFrame,
        });
        cursor = endFrame;
      }
    } else if (sceneShots.length > 0) {
      shots = sceneShots;
    } else if (masterFile && masterRel) {
      shots = [{ sceneId: 'scene-001', sourceFile: masterFile, sourceRel: masterRel }];
    }
  }

  if (shots.length === 0) {
    throw new Error(`项目中找不到可导出的镜头 MP4 或母版视频：${root}`);
  }

  const cues = readCueSheet(root);
  const musicCues = cues.filter((c) => c.kind === 'music');
  const sfxCues = cues.filter((c) => c.kind === 'sfx');

  const audio: DiscoveredAudioStem[] = [];
  const voiceRel = ['production/audio/voice.wav', 'audio/voice.wav'].find(
    (r) => safeInside(root, r, '旁白音轨') !== null,
  );
  if (voiceRel) {
    audio.push({ role: 'voice', file: safeInside(root, voiceRel, '旁白音轨')!, sourceRel: voiceRel, cues: [] });
  }
  const bgmRel = ['production/audio/music.wav', 'production/audio/bgm.wav', 'audio/bgm.wav'].find(
    (r) => safeInside(root, r, 'BGM 音轨') !== null,
  );
  if (bgmRel) {
    audio.push({ role: 'bgm', file: safeInside(root, bgmRel, 'BGM 音轨')!, sourceRel: bgmRel, cues: musicCues });
  } else if (musicCues.length > 0) {
    audio.push({ role: 'bgm', sourceRel: 'production/audio/cue-sheet.json', cues: musicCues });
  }
  const sfxRel = ['production/audio/sfx.wav', 'audio/sfx.wav'].find((r) => safeInside(root, r, '音效音轨') !== null);
  if (sfxRel) {
    audio.push({ role: 'sfx', file: safeInside(root, sfxRel, '音效音轨')!, sourceRel: sfxRel, cues: sfxCues });
  } else if (sfxCues.length > 0) {
    audio.push({ role: 'sfx', sourceRel: 'production/audio/cue-sheet.json', cues: sfxCues });
  }

  const subs = discoverSubtitles(root, rawScenes);
  return {
    root,
    fps,
    widthPx,
    heightPx,
    shots,
    audio,
    subtitleFile: subs.file,
    subtitleRel: subs.rel,
    subtitles: subs.cues,
  };
}
