/**
 * audio_mix 的 cue-sheet.json 解析与音效峰值反推入点。
 *
 * 100% 兼容既有 music / event_id / phrase_id 格式，并扩展 SFX cue 的
 * anchor_id / anchor_frame + peak_seconds 峰值反推与负入点自动截断换算。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '@onset/engine/beat';
import { goRound } from '@onset/engine/gofmt';
import { type MixCue, MixSampleRate } from '@onset/engine/mediaprobe';
import { loadInventory } from '@onset/engine/reads';
import { contained, parsePhraseTimeline } from '@onset/engine/scene';

export function inputFile(root: string, relative: string): string {
  const file = contained(root, relative, '混音输入');
  const parts = path.relative(root, file).split(path.sep);
  if (parts.some((part) => part.startsWith('.')) || !fs.statSync(file).isFile()) {
    throw new Error(`混音输入必须是项目内的非隐藏文件：${relative}`);
  }
  return file;
}

export function readProjectJSON(root: string, name: string): unknown {
  return JSON.parse(fs.readFileSync(inputFile(root, name), 'utf8'));
}

export function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

export function expectFrame(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${label} 必须是至少为 ${min} 的整数帧数`);
  }
  return value;
}

function nonNegNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} 必须是有限且非负的数字`);
  }
  return value;
}

function loadAnchorTable(root: string, anchorsRel: string, fps: number, frames: number): beat.ResolvedAnchorTable {
  const file = inputFile(root, anchorsRel);
  const raw = beat.readAnchorsFile(file);
  if (beat.enabled(root) && fs.existsSync(path.join(root, beat.GridFile))) {
    const grid = beat.loadGrid(root);
    const segments = fs.existsSync(path.join(root, beat.PlanFile))
      ? beat.layout(grid, beat.loadPlan(root), fps)
      : undefined;
    return beat.resolveAnchors(raw, { grid, segments, fps, totalFrames: frames });
  }
  return beat.resolveAnchors(raw, { fps, totalFrames: frames });
}

export interface ReadMixCuesOptions {
  anchorsFile?: string;
}

/** 读取并校验 cue-sheet.json，完成锚点查找与音效峰值反推入点，输出供 mixProgram 消费的 MixCue[]。 */
export function readMixCues(
  root: string,
  file: string,
  fps: number,
  frames: number,
  opts: ReadMixCuesOptions = {},
): MixCue[] {
  const sheet = asObject(readProjectJSON(root, file), 'cue sheet');
  if (sheet.schema !== 1 || !Array.isArray(sheet.cues)) {
    throw new Error('cue sheet 需要 schema: 1 和 cues 数组');
  }
  const sheetAnchors =
    opts.anchorsFile || (typeof sheet.anchors === 'string' && sheet.anchors ? sheet.anchors : beat.AnchorsFile);

  let events: Map<string, number> | undefined;
  let phrases: Map<string, number> | undefined;
  let anchors: beat.ResolvedAnchorTable | undefined;

  const ensureAnchors = (): beat.ResolvedAnchorTable => {
    anchors ??= loadAnchorTable(root, sheetAnchors, fps, frames);
    return anchors;
  };

  const resolveSfxTarget = (
    cue: Record<string, unknown>,
    label: string,
  ): { anchorFrame: number; peakSeconds: number } => {
    const hasEvent = typeof cue.event_id === 'string' && cue.event_id !== '';
    const hasPhrase = typeof cue.phrase_id === 'string' && cue.phrase_id !== '';
    const hasAnchorId = typeof cue.anchor_id === 'string' && cue.anchor_id !== '';
    const hasAnchorFrame = cue.anchor_frame !== undefined;

    const bindingCount = (hasEvent ? 1 : 0) + (hasPhrase ? 1 : 0) + (hasAnchorId || hasAnchorFrame ? 1 : 0);
    if (bindingCount !== 1) {
      throw new Error(label + ' 需要一个有效的 event_id、phrase_id 或 anchor_id/anchor_frame');
    }

    if (hasEvent) {
      if (!events) {
        const inventory = loadInventory(inputFile(root, 'production/visible-event-inventory.json'));
        if (inventory.fps !== fps) throw new Error('可见事件清单帧率与画幅不符');
        events = new Map(inventory.events.map((event) => [event.event_id, event.enter_frame]));
      }
      const anchorFrame = expectFrame(events.get(cue.event_id as string), label + ' event_id 的起始帧');
      const peakSeconds = cue.peak_seconds !== undefined ? nonNegNumber(cue.peak_seconds, label + ' peak_seconds') : 0;
      return { anchorFrame, peakSeconds };
    }

    if (hasPhrase) {
      phrases ??= new Map(
        parsePhraseTimeline(fs.readFileSync(inputFile(root, 'production/phrase-timeline.json')), fps).phrases!.map(
          (phrase) => [phrase.phrase_id, phrase.start_frame],
        ),
      );
      const anchorFrame = expectFrame(phrases.get(cue.phrase_id as string), label + ' phrase_id 的起始帧');
      const peakSeconds = cue.peak_seconds !== undefined ? nonNegNumber(cue.peak_seconds, label + ' peak_seconds') : 0;
      return { anchorFrame, peakSeconds };
    }

    if (hasAnchorId) {
      const table = ensureAnchors();
      const anchorId = cue.anchor_id as string;
      const anchor = table.by_id[anchorId];
      if (!anchor) throw new Error(`${label} 引用了未知锚点：${anchorId}`);
      if (hasAnchorFrame) {
        const explicit = expectFrame(cue.anchor_frame, label + ' anchor_frame');
        if (explicit !== anchor.global_frame) {
          throw new Error(
            `${label} anchor_frame（${explicit}）与锚点 ${anchorId}（第 ${anchor.global_frame} 帧）不一致`,
          );
        }
      }
      let peakSeconds = 0;
      if (cue.peak_seconds !== undefined) {
        peakSeconds = nonNegNumber(cue.peak_seconds, label + ' peak_seconds');
      } else if (typeof cue.cue_id === 'string' && cue.cue_id !== '') {
        const matched = anchor.sfx.find((item) => item.cue_id === cue.cue_id);
        if (matched) peakSeconds = matched.peak_seconds;
      } else if (anchor.sfx.length === 1) {
        peakSeconds = anchor.sfx[0].peak_seconds;
      }
      return { anchorFrame: anchor.global_frame, peakSeconds };
    }

    const anchorFrame = expectFrame(cue.anchor_frame, label + ' anchor_frame');
    const peakSeconds = cue.peak_seconds !== undefined ? nonNegNumber(cue.peak_seconds, label + ' peak_seconds') : 0;
    return { anchorFrame, peakSeconds };
  };

  const samples = (f: number) => goRound((f / fps) * MixSampleRate);

  return sheet.cues.map((item, i) => {
    const label = `cue ${i + 1}`;
    const cue = asObject(item, label);
    if (cue.kind !== 'music' && cue.kind !== 'sfx') throw new Error(label + ' kind 必须是 music 或 sfx');
    if (typeof cue.asset !== 'string' || !cue.asset) throw new Error(label + ' 缺少 asset');

    const baseSourceStart = expectFrame(cue.source_start_frame ?? 0, label + ' source_start_frame');
    const hasTrimSeconds = cue.trim_start_seconds !== undefined;
    const baseTrimSeconds = hasTrimSeconds ? nonNegNumber(cue.trim_start_seconds, label + ' trim_start_seconds') : 0;
    if (
      hasTrimSeconds &&
      cue.source_start_frame !== undefined &&
      Math.abs(baseTrimSeconds * fps - baseSourceStart) > 0.5
    ) {
      throw new Error(label + ' trim_start_seconds 与 source_start_frame 不一致');
    }

    let start: number;
    let sourceStartFrame = baseSourceStart;
    let trimmedFrames = 0;
    if (cue.kind === 'music') {
      start = expectFrame(cue.start_frame ?? 0, label + ' start_frame');
    } else {
      const target = resolveSfxTarget(cue, label);
      const timing = beat.resolveSfxPeakTiming(target.anchorFrame, target.peakSeconds, fps, baseSourceStart);
      start = timing.start_frame;
      sourceStartFrame = timing.source_start_frame;
      trimmedFrames = timing.trimmed_frames;
    }

    if (cue.start_frame !== undefined && cue.start_frame !== start) {
      throw new Error(label + ' start_frame 与绑定的事件不一致');
    }

    const rawLength = expectFrame(cue.duration_frames, label + ' duration_frames', 1);
    const length = rawLength - trimmedFrames;
    if (length < 1) throw new Error(label + ' 反推入点截断后剩余帧数不足 1 帧');
    if (start + length > frames) throw new Error(label + ' 越过节目终点');

    const gain = cue.gain_db ?? (cue.kind === 'music' ? -18 : -12);
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < -90 || gain > 12) {
      throw new Error(label + ' gain_db 必须在 -90 到 12 之间');
    }
    const rawFadeIn = expectFrame(cue.fade_in_frames ?? 0, label + ' fade_in_frames');
    const fadeIn = Math.max(0, rawFadeIn - trimmedFrames);
    const fadeOut = expectFrame(cue.fade_out_frames ?? 0, label + ' fade_out_frames');
    if (fadeIn + fadeOut > length) throw new Error(label + ' 淡入淡出超过 cue 长度');
    if (cue.allow_clip !== undefined && typeof cue.allow_clip !== 'boolean') {
      throw new Error(label + ' allow_clip 必须是布尔值');
    }

    const sourceStartSamples = hasTrimSeconds
      ? goRound((baseTrimSeconds + trimmedFrames / fps) * MixSampleRate)
      : samples(sourceStartFrame);

    return {
      kind: cue.kind,
      file: inputFile(root, cue.asset),
      start: samples(start),
      length: samples(start + length) - samples(start),
      sourceStart: sourceStartSamples,
      gainDB: gain,
      fadeIn: samples(fadeIn),
      fadeOut: samples(fadeOut),
      ...(cue.allow_clip ? { allowClip: true } : {}),
    };
  });
}
