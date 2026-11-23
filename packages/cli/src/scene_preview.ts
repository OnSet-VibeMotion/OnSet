import fs from 'node:fs';
import path from 'node:path';
import * as determinism from '@onset/engine/determinism';
import { formatFixed, goRound } from '@onset/engine/gofmt';
import * as hyperframes from '@onset/engine/hyperframes';
import { contactSheetImages, cropImage, newToolchain, type Region } from '@onset/engine/mediaprobe';
import { rejectSymlinkPath } from '@onset/engine/project';
import * as scene from '@onset/engine/scene';
import { currentEnvironment } from './cli';
import { compactHyperFrames } from './hfoutput';
import { defineOp, ParamError } from './ops/op';
import { bool, str } from './ops/common';
import { cachedArtifact, loadPreviewCache, previewKey, rememberArtifact, savePreviewCache } from './preview_cache';

const maxFrames = 12;
const maxZoomFrames = 4;
const previewStatsWindowMs = 2 * 60 * 60 * 1000;
const previewCallBudget = 4;
const previewZoomBudget = 3;
const previewRoundBudget = 3;
const checkSections = [
  ['lint', '源码'], ['runtime', '运行时'], ['layout', '布局'],
  ['motion', '动效'], ['contrast', '对比度'], ['craft', '画面工艺'],
] as const;

interface PreviewStats {
  updated_at: number;
  last_key: string;
  total_calls: number;
  zoom_calls: number;
  rounds: number;
}

function recordPreviewStats(artifacts: string, key: string, isZoom: boolean): PreviewStats {
  const file = path.join(artifacts, 'preview-stats.json');
  const now = Date.now();
  let stats: PreviewStats = { updated_at: now, last_key: '', total_calls: 0, zoom_calls: 0, rounds: 0 };
  try {
    rejectSymlinkPath(artifacts, file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PreviewStats>;
    if (typeof raw.updated_at === 'number' && now - raw.updated_at <= previewStatsWindowMs) {
      stats = {
        updated_at: now,
        last_key: typeof raw.last_key === 'string' ? raw.last_key : '',
        total_calls: typeof raw.total_calls === 'number' && raw.total_calls >= 0 ? raw.total_calls : 0,
        zoom_calls: typeof raw.zoom_calls === 'number' && raw.zoom_calls >= 0 ? raw.zoom_calls : 0,
        rounds: typeof raw.rounds === 'number' && raw.rounds >= 0 ? raw.rounds : 0,
      };
    }
  } catch {
    // 缺失、符号链接或损坏时重新计数。
  }
  stats.total_calls += 1;
  if (isZoom) stats.zoom_calls += 1;
  if (key === '' || stats.last_key !== key) {
    stats.rounds += 1;
    stats.last_key = key;
  }
  try {
    rejectSymlinkPath(artifacts, file);
    fs.writeFileSync(file, JSON.stringify(stats) + '\n');
  } catch {
    // 统计写入失败不影响主流程。
  }
  return stats;
}

function previewFrames(value: string, last: number): number[] {
  const frames = value.trim() === ''
    ? [0, goRound(last / 4), goRound(last / 2), goRound(last * 3 / 4), last]
    : value.split(',').map(frame => /^[0-9]+$/.test(frame.trim()) ? Number(frame) : NaN);
  if (frames.some(frame => !Number.isSafeInteger(frame) || frame < 0 || frame > last)) {
    throw new ParamError(`frames 要用镜头内帧号，范围 0–${last}`);
  }
  const unique = [...new Set(frames)].sort((a, b) => a - b);
  if (unique.length > maxFrames) throw new ParamError(`frames 最多 ${maxFrames} 个不同的采样点`);
  return unique;
}

function parseZoomFrame(value: string, last: number): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^[0-9]+$/.test(trimmed)) throw new ParamError(`zoom_frame 要用镜头内整数帧号，范围 0–${last}`);
  const frame = Number(trimmed);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame > last) {
    throw new ParamError(`zoom_frame 要用镜头内整数帧号，范围 0–${last}`);
  }
  return frame;
}

function parseZoomFrames(value: string, last: number): number[] | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const frames = trimmed.split(',').map(frame => /^[0-9]+$/.test(frame.trim()) ? Number(frame) : NaN);
  if (frames.some(frame => !Number.isSafeInteger(frame) || frame < 0 || frame > last)) {
    throw new ParamError(`zoom_frames 要用镜头内整数帧号，范围 0–${last}`);
  }
  const unique = [...new Set(frames)].sort((a, b) => a - b);
  if (unique.length > maxZoomFrames) throw new ParamError(`zoom_frames 最多 ${maxZoomFrames} 个不同的帧`);
  return unique;
}

function parseCrop(value: string, widthPx: number, heightPx: number): Region | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(',').map(part => part.trim());
  if (parts.length !== 4 || parts.some(part => !/^[0-9]+$/.test(part))) {
    throw new ParamError('crop 写法应为 "x,y,w,h"（四个非负整数像素）');
  }
  const [x, y, w, h] = parts.map(Number) as [number, number, number, number];
  if (w <= 0 || h <= 0 || x + w > widthPx || y + h > heightPx) {
    throw new ParamError(`crop 超出画布范围 ${widthPx}×${heightPx}：${trimmed}`);
  }
  return { x, y, w, h };
}

function artifact(dir: string, file: unknown): string {
  if (typeof file !== 'string' || file === '') throw new Error('截图结果缺少文件路径');
  const resolved = scene.contained(dir, path.isAbsolute(file) ? path.relative(dir, file) : file, '截图路径');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error(`截图文件为空：${file}`);
  return resolved;
}

function summarizeCheck(text: string, report: string): { warnings: string[]; passed: string[] } {
  const result = JSON.parse(text);
  if (result?.ok !== true) throw new Error(`合成检查未通过，完整记录：${report}`);
  const sections = result as Record<string, { ok?: boolean; findings?: Array<{
    code?: string;
    severity?: string;
    message?: string;
    selector?: string;
    time?: number;
  }> } | null>;
  const warnings = checkSections
    .flatMap(([name]) => (sections[name]?.findings ?? []).filter(finding => {
      if (finding.severity !== 'warning') return false;
      // Scene output is required to be silent. The preview shell's own warning is unrelated to the HTML.
      if (name === 'craft' && finding.code === 'film_silent') return false;
      return !(name === 'runtime' && finding.code === 'console_warning'
        && finding.message?.startsWith('Electron Security Warning (Insecure Content-Security-Policy)'));
    }))
    .map(finding => {
      const time = typeof finding.time === 'number' ? ` @ ${formatFixed(finding.time, 3)} 秒` : '';
      return `${(finding.message ?? '').slice(0, 220)} ${finding.selector ?? ''}${time}`.trim();
    });
  const passed = checkSections.filter(([name]) => sections[name]?.ok === true).map(([, label]) => label);
  return { warnings: [...new Set(warnings)], passed };
}

defineOp({
  name: 'scene_preview_check',
  cli: ['scene', 'preview-check'],
  scopes: ['renderer'],
  summary: '一次做合成检查、关键帧联系表或高分细节图',
  description: '在当前镜头检查布局、运动和对比度，再截取指定的本地帧。默认输出关键帧联系表；核查多个疑点帧时用 zoom_frames（最多 4 帧，拼成一张高分细节图，减少多次往返），单帧局部细节用 zoom_frame（优先配合 crop 局部裁剪，复用已缓存的帧）。正常修改源码会自动失效缓存，一般无需传 refresh。合成检查报错时先修复。',
  examples: [
    'scene_preview_check({"frames":"0,45,89"})',
    'scene_preview_check({"zoom_frames":"45,89"})',
    'scene_preview_check({"zoom_frame":"45","crop":"0,720,1080,360"})',
  ],
  params: {
    frames: { type: 'string', description: `逗号分隔的本镜头整数帧号，最多 ${maxFrames} 个；默认首帧、四分位和末帧` },
    zoom_frame: { type: 'string', description: '单帧细节检查的本镜头整数帧号；仅对单帧局部细节使用，多帧放大请用 zoom_frames' },
    zoom_frames: { type: 'string', description: `逗号分隔的多个疑点帧号（最多 ${maxZoomFrames} 帧），一次拼成高分细节图（720px/格，支持配合 crop），避免反复单独调 zoom_frame` },
    crop: { type: 'string', description: '配合 zoom_frame 或 zoom_frames 使用的局部裁剪区域 "x,y,w,h"（画布像素），省略时返回整帧细节' },
    refresh: { type: 'boolean', description: '强制跳过缓存重新检查并截图（正常修改源码会自动失效缓存，一般无需传入）' },
  },
  run: async (p, { out, signal }) => {
    const s = scene.load('.');
    const { fps, widthPx, heightPx } = scene.sceneCanvas(s);
    const last = goRound(s.duration_seconds * fps) - 1;
    const zoomFrame = parseZoomFrame(str(p.zoom_frame), last);
    const zoomFramesParam = parseZoomFrames(str(p.zoom_frames), last);
    if (zoomFrame !== null && zoomFramesParam !== null) throw new ParamError('zoom_frame 与 zoom_frames 不要同时传入');
    const zoomFrames = zoomFramesParam ?? (zoomFrame !== null ? [zoomFrame] : null);
    const crop = parseCrop(str(p.crop), widthPx, heightPx);
    if (crop !== null && zoomFrames === null) throw new ParamError('crop 需要配合 zoom_frame 或 zoom_frames 使用');
    const frames = zoomFrames ?? previewFrames(str(p.frames), last);
    const env = currentEnvironment();
    const cli = hyperframes.requireCLI(env);
    const artifacts = scene.contained(s.directory, '.onset', '预览目录');
    rejectSymlinkPath(s.directory, path.join(s.directory, '.onset', 'preview-cache', 'index.json'));
    fs.mkdirSync(artifacts, { recursive: true });
    const index = path.join(artifacts, 'preview-cache', 'index.json');
    const lock = path.join(artifacts, 'preview.lock');
    rejectSymlinkPath(s.directory, lock);
    const release = await hyperframes.lockFile(lock, signal);
    try {
      return await runPreview(s, frames, zoomFrames, crop, fps, env, cli, artifacts, index, bool(p.refresh), out, signal);
    } finally {
      release();
    }
  },
});

async function runPreview(
  s: scene.Scene, frames: number[], zoomFrames: number[] | null, crop: Region | null, fps: number,
  env: Record<string, string>, cli: string,
  artifacts: string, index: string, refresh: boolean, out: { write(text: string): unknown }, signal: AbortSignal,
) {
  signal.throwIfAborted();
  const source = determinism.scan(s.directory);
  if (!source.ok) throw new Error(`合成源码存在确定性问题：\n  - ${determinism.problems(source).join('\n  - ')}`);
  const key = previewKey(s, source, cli, env);
  const cache = loadPreviewCache(index, refresh ? '' : key);
  const isZoom = zoomFrames !== null;
  const singleZoom = zoomFrames !== null && zoomFrames.length === 1 ? zoomFrames[0]! : null;
  let workspace: string | undefined;
  const outputDir = () => workspace ??= fs.mkdtempSync(path.join(artifacts, 'preview-'));
  const run = async (args: string[]): Promise<string> => {
    const spec = hyperframes.cliCommandFor(cli, env, args);
    let stdout = '';
    let stderr = '';
    const report = path.join(outputDir(), args[0] + '.log');
    try {
      await hyperframes.runCommand(spec.file, spec.args, {
        cwd: s.directory, env: spec.env, signal,
        stdout: { write: chunk => { stdout += chunk; } },
        stderr: { write: chunk => { stderr += chunk; } },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = compactHyperFrames(stdout + '\n' + stderr).text.trim().slice(-3000);
      throw new Error(`${args[0]} 失败：${detail || (error as Error).message}\n完整记录：${report}`, { cause: error });
    } finally {
      fs.writeFileSync(report, stdout + (stderr ? '\n' + stderr : ''));
    }
    return stdout;
  };
  let checkReport = cachedArtifact(artifacts, cache.check);
  const reusedCheck = checkReport !== '' && Array.isArray(cache.check?.warnings)
    && cache.check.warnings.every(warning => typeof warning === 'string');
  let summary: { warnings: string[]; passed?: string[] };
  if (reusedCheck) {
    summary = cache.check!;
  } else {
    checkReport = path.join(outputDir(), 'check.log');
    summary = summarizeCheck(await run(['check', '--json', '--max-issues', '20']), checkReport);
    if (key) cache.check = { ...rememberArtifact(artifacts, checkReport), ...summary };
  }

  const stills = new Map(frames.map(frame => [frame, cachedArtifact(artifacts, cache.frames[frame])]));
  const missing = frames.filter(frame => !stills.get(frame));
  const frameList = frames.join(',');
  let sheet = !isZoom && missing.length === 0 ? cachedArtifact(artifacts, cache.sheets[frameList]) : '';
  if (missing.length > 0) {
    const dir = outputDir();
    const timePoints = missing.map(frame => formatFixed(frame / fps, 6)).join(',');
    const result = JSON.parse((await run([
      'snapshot', '--json', '--describe', 'false', '--no-end', '--output', dir, '--at', timePoints,
    ])).trim()) as { ok?: boolean; frames?: { path: unknown }[]; contactSheets?: unknown[] };
    if (result.ok !== true || result.frames?.length !== missing.length) {
      throw new Error(`截图帧数与请求不一致，完整记录：${path.join(dir, 'snapshot.log')}`);
    }
    result.frames.forEach((frame, i) => {
      const file = artifact(dir, frame.path);
      stills.set(missing[i]!, file);
      if (key) cache.frames[missing[i]!] = rememberArtifact(artifacts, file);
    });
    if (!isZoom && missing.length === frames.length && result.contactSheets?.length === 1) sheet = artifact(dir, result.contactSheets[0]);
  }
  const details = cache.details ??= {};
  if (singleZoom !== null) {
    const still = stills.get(singleZoom)!;
    if (crop !== null) {
      const cropKey = `${singleZoom}:${crop.x},${crop.y},${crop.w},${crop.h}`;
      sheet = cachedArtifact(artifacts, details[cropKey]);
      if (!sheet) {
        sheet = path.join(outputDir(), `detail-f${singleZoom}-${crop.x}-${crop.y}-${crop.w}-${crop.h}.png`);
        await cropImage(newToolchain(env), still, crop, sheet, signal);
        if (key) details[cropKey] = rememberArtifact(artifacts, sheet);
      }
    } else {
      sheet = still;
    }
  } else if (zoomFrames !== null) {
    const multiKey = crop !== null
      ? `multi:${zoomFrames.join(',')}:${crop.x},${crop.y},${crop.w},${crop.h}`
      : `multi:${zoomFrames.join(',')}`;
    sheet = cachedArtifact(artifacts, details[multiKey]);
    if (!sheet) {
      const tc = newToolchain(env);
      const inputs: string[] = [];
      for (const frame of zoomFrames) {
        const still = stills.get(frame)!;
        if (crop !== null) {
          const cropKey = `${frame}:${crop.x},${crop.y},${crop.w},${crop.h}`;
          let cropped = cachedArtifact(artifacts, details[cropKey]);
          if (!cropped) {
            cropped = path.join(outputDir(), `detail-f${frame}-${crop.x}-${crop.y}-${crop.w}-${crop.h}.png`);
            await cropImage(tc, still, crop, cropped, signal);
            if (key) details[cropKey] = rememberArtifact(artifacts, cropped);
          }
          inputs.push(cropped);
        } else {
          inputs.push(still);
        }
      }
      const thumbWidth = crop !== null ? Math.max(2, Math.min(crop.w, 720)) : 720;
      const suffix = crop !== null ? `-${crop.x}-${crop.y}-${crop.w}-${crop.h}` : '';
      sheet = path.join(outputDir(), `detail-sheet-f${zoomFrames.join('-')}${suffix}.png`);
      await contactSheetImages(tc, inputs, sheet, signal, Math.min(zoomFrames.length, 2), thumbWidth);
      if (key) details[multiKey] = rememberArtifact(artifacts, sheet);
    }
  } else if (!sheet) {
    sheet = path.join(outputDir(), 'contact-sheet.png');
    await contactSheetImages(newToolchain(env), frames.map(frame => stills.get(frame)!), sheet, signal);
  }
  signal.throwIfAborted();
  if (key) {
    if (previewKey(s, determinism.scan(s.directory), cli, env) !== key) {
      throw new Error('预览期间合成源码或资源发生变化，请重新检查');
    }
    if (workspace) {
      if (!isZoom) cache.sheets[frameList] = rememberArtifact(artifacts, sheet);
      savePreviewCache(index, key, cache);
    }
  }
  const stats = recordPreviewStats(artifacts, key, isZoom);
  if (singleZoom !== null) {
    const cropNote = crop ? `（局部 ${crop.x},${crop.y},${crop.w}×${crop.h}）` : '（原分辨率）';
    out.write(`检查通过。细节图：${sheet}，帧 ${singleZoom}${cropNote}。\n`);
  } else if (zoomFrames !== null) {
    const cropNote = crop ? `（局部 ${crop.x},${crop.y},${crop.w}×${crop.h}）` : '（每格 720px 高分细节）';
    out.write(`检查通过。细节拼图：${sheet}，帧序 ${zoomFrames.join(', ')}${cropNote}。\n`);
  } else {
    out.write(`检查通过。联系表：${sheet}，帧序 ${frames.join(', ')}。\n`);
  }
  const { warnings, passed } = summary;
  if (Array.isArray(passed) && passed.length) out.write(`本次通过：${passed.join('、')}。完整日志可用于排查具体问题。\n`);
  const reusedFrames = frames.length - missing.length;
  if (reusedCheck || reusedFrames) out.write(`缓存命中：${reusedCheck ? '合成检查，' : ''}${reusedFrames} 张截图。\n`);
  if (!workspace) out.write(`${isZoom ? '细节图' : '联系表'}与上次完全相同。本会话已看过这张图时，可直接沿用上次的视觉判断。\n`);
  for (const warning of warnings.slice(0, 5)) out.write(`提示：${warning}\n`);
  if (warnings.length > 5) out.write(`另有 ${warnings.length - 5} 条提示，见完整记录。\n`);
  if (stats.total_calls >= previewCallBudget || stats.zoom_calls >= previewZoomBudget || stats.rounds >= previewRoundBudget) {
    out.write(`提示：本镜头已执行 ${stats.total_calls} 次预览检查（${stats.rounds} 轮源码、${stats.zoom_calls} 次细节放大）。若画面核心问题已解决，请立即输出交接信号结束会话，避免继续细调拉高耗时与 token。\n`);
  }
  out.write(`完整检查记录：${checkReport}\n`);
  return {
    data: {
      sheet,
      ...(singleZoom !== null ? { detail: sheet, zoom_frame: singleZoom, ...(crop ? { crop: `${crop.x},${crop.y},${crop.w},${crop.h}` } : {}) } : {}),
      ...(zoomFrames !== null && zoomFrames.length > 1 ? { detail: sheet, zoom_frames: zoomFrames, ...(crop ? { crop: `${crop.x},${crop.y},${crop.w},${crop.h}` } : {}) } : {}),
      frames,
      reused_check: reusedCheck,
      reused_frames: reusedFrames,
      preview_calls: stats.total_calls,
    },
  };
}
