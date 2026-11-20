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
const checkSections = [
  ['lint', '源码'], ['runtime', '运行时'], ['layout', '布局'],
  ['motion', '动效'], ['contrast', '对比度'], ['craft', '画面工艺'],
] as const;

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
  summary: '一次做合成检查、关键帧联系表或单帧细节图',
  description: '在当前镜头检查布局、运动和对比度，再截取指定的本地帧。默认输出关键帧联系表；传 zoom_frame 时返回该帧原分辨率（或配合 crop 返回局部裁剪）细节图并优先复用已缓存的帧。合成检查报错时先修复。',
  examples: [
    'scene_preview_check({"frames":"0,45,89"})',
    'scene_preview_check({"zoom_frame":"45"})',
    'scene_preview_check({"zoom_frame":"45","crop":"0,720,1080,360"})',
  ],
  params: {
    frames: { type: 'string', description: `逗号分隔的本镜头整数帧号，最多 ${maxFrames} 个；默认首帧、四分位和末帧` },
    zoom_frame: { type: 'string', description: '单帧细节检查的本镜头整数帧号；传入时返回该帧原分辨率或局部裁剪图，不拼联系表' },
    crop: { type: 'string', description: '配合 zoom_frame 使用的局部裁剪区域 "x,y,w,h"（画布像素），省略时返回该帧原分辨率全图' },
    refresh: { type: 'boolean', description: '重新检查并截图，跳过已缓存的结果' },
  },
  run: async (p, { out, signal }) => {
    const s = scene.load('.');
    const { fps, widthPx, heightPx } = scene.sceneCanvas(s);
    const last = goRound(s.duration_seconds * fps) - 1;
    const zoomFrame = parseZoomFrame(str(p.zoom_frame), last);
    const crop = parseCrop(str(p.crop), widthPx, heightPx);
    if (crop !== null && zoomFrame === null) throw new ParamError('crop 需要配合 zoom_frame 使用');
    const frames = zoomFrame !== null ? [zoomFrame] : previewFrames(str(p.frames), last);
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
      return await runPreview(s, frames, zoomFrame, crop, fps, env, cli, artifacts, index, bool(p.refresh), out, signal);
    } finally {
      release();
    }
  },
});

async function runPreview(
  s: scene.Scene, frames: number[], zoomFrame: number | null, crop: Region | null, fps: number,
  env: Record<string, string>, cli: string,
  artifacts: string, index: string, refresh: boolean, out: { write(text: string): unknown }, signal: AbortSignal,
) {
  signal.throwIfAborted();
  const source = determinism.scan(s.directory);
  if (!source.ok) throw new Error(`合成源码存在确定性问题：\n  - ${determinism.problems(source).join('\n  - ')}`);
  const key = previewKey(s, source, cli, env);
  const cache = loadPreviewCache(index, refresh ? '' : key);
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
  let sheet = zoomFrame === null && missing.length === 0 ? cachedArtifact(artifacts, cache.sheets[frameList]) : '';
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
    if (zoomFrame === null && missing.length === frames.length && result.contactSheets?.length === 1) sheet = artifact(dir, result.contactSheets[0]);
  }
  const details = cache.details ??= {};
  let cropKey = '';
  if (zoomFrame !== null) {
    const still = stills.get(zoomFrame)!;
    if (crop !== null) {
      cropKey = `${zoomFrame}:${crop.x},${crop.y},${crop.w},${crop.h}`;
      sheet = cachedArtifact(artifacts, details[cropKey]);
      if (!sheet) {
        sheet = path.join(outputDir(), `detail-f${zoomFrame}-${crop.x}-${crop.y}-${crop.w}-${crop.h}.png`);
        await cropImage(newToolchain(env), still, crop, sheet, signal);
        if (key) details[cropKey] = rememberArtifact(artifacts, sheet);
      }
    } else {
      sheet = still;
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
      if (zoomFrame === null) cache.sheets[frameList] = rememberArtifact(artifacts, sheet);
      savePreviewCache(index, key, cache);
    }
  }
  if (zoomFrame !== null) {
    const cropNote = crop ? `（局部 ${crop.x},${crop.y},${crop.w}×${crop.h}）` : '（原分辨率）';
    out.write(`检查通过。细节图：${sheet}，帧 ${zoomFrame}${cropNote}。\n`);
  } else {
    out.write(`检查通过。联系表：${sheet}，帧序 ${frames.join(', ')}。\n`);
  }
  const { warnings, passed } = summary;
  if (Array.isArray(passed) && passed.length) out.write(`本次通过：${passed.join('、')}。完整日志可用于排查具体问题。\n`);
  const reusedFrames = frames.length - missing.length;
  if (reusedCheck || reusedFrames) out.write(`缓存命中：${reusedCheck ? '合成检查，' : ''}${reusedFrames} 张截图。\n`);
  if (!workspace) out.write(`${zoomFrame !== null ? '细节图' : '联系表'}与上次完全相同。本会话已看过这张图时，可直接沿用上次的视觉判断。\n`);
  for (const warning of warnings.slice(0, 5)) out.write(`提示：${warning}\n`);
  if (warnings.length > 5) out.write(`另有 ${warnings.length - 5} 条提示，见完整记录。\n`);
  out.write(`完整检查记录：${checkReport}\n`);
  return {
    data: {
      sheet,
      ...(zoomFrame !== null ? { detail: sheet, zoom_frame: zoomFrame, ...(crop ? { crop: `${crop.x},${crop.y},${crop.w},${crop.h}` } : {}) } : {}),
      frames,
      reused_check: reusedCheck,
      reused_frames: reusedFrames,
    },
  };
}
