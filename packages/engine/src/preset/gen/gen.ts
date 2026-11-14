/**
 * 画幅生成器：把 preset 的画幅表渲染成每个画幅下发到项目根的 frame.md。
 *
 *   assets/presets/<画幅>/frame.md   画布、安全区、字幕版式与响度目标
 *
 * 模板是本目录的 templates/frame.md：canvas 与 safe_area 两个块整体替换，其余占位符按画幅填，
 * 不做 YAML 重序列化（flow 映射、保留尾零的浮点写法与人工排定的键序还原不出来，会让「产物与签入版本逐字节相同」失守）。
 *
 * 制作提示词不经生成器：段落在 assets/prompts/<站>/，开工时按流程组合（flow.composeFlowPrompt）；
 * 这里的 substituteCanvas 也给它换画幅占位符。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goQuote } from '../../gofmt';
import { PinnedVersion } from '../../hyperframes/constants';
import * as preset from '../index';

export const canvasMarker = '# @@CANVAS_AND_SAFE_AREA@@';

/** 画幅模板：仓库里的 packages/engine/src/preset/gen/templates/frame.md。 */
export function templateFile(repo: string): string {
  return path.join(repo, 'packages', 'engine', 'src', 'preset', 'gen', 'templates', 'frame.md');
}

export function loadTemplate(repo: string): string {
  return fs.readFileSync(templateFile(repo), 'utf8');
}

/** frontmatter 里随画幅变化的两个块；safe_area 用 flow 映射单行表示。 */
export function canvasAndSafeArea(p: preset.Preset): string {
  const boxes = preset.resolveSafeArea(p);
  const lines = ['canvas:', `  width_px: ${p.canvas.widthPx}`, `  height_px: ${p.canvas.heightPx}`, `  fps: ${p.canvas.fps}`, '  orientation: ' + p.canvas.orientation, 'safe_area:'];
  for (const item of boxes) {
    lines.push(`  ${item.name}: {left_px: ${item.box.leftPx}, right_px: ${item.box.rightPx}, top_px: ${item.box.topPx}, bottom_px: ${item.box.bottomPx}}`);
  }
  return lines.join('\n');
}

/**
 * 替换随画幅变化的固定占位符。版本号从 hyperframes 取，不在模板里写字面量：改了常量忘了模板，
 * 下发给渲染工具的锁定指令会停在旧版本上，而 onset init 装的已经是新版。
 */
function substitute(p: preset.Preset, s: string): string {
  return s.split('{{CANVAS}}').join(preset.canvasLabel(p.canvas)).split('{{HYPERFRAMES_VERSION}}').join(PinnedVersion);
}

/** {{NAME}} 或带整数偏移的 {{NAME+8}} / {{NAME-16}}。 */
const numericPlaceholder = /\{\{([A-Z_]+)([+-][0-9]+)?\}\}/g;

/**
 * 替换随画幅变化的占位符：像素一律从已推导的安全区算出，措辞取自画幅表。
 * 未知占位符直接报错，不原样留在产物里。
 */
export function substituteCanvas(p: preset.Preset, s: string): string {
  const box = new Map(preset.resolveSafeArea(p).map((item) => [item.name, item.box]));
  const get = (name: string) => box.get(name) ?? { leftPx: 0, rightPx: 0, topPx: 0, bottomPx: 0 };
  const width = p.canvas.widthPx;
  const numbers: Record<string, number> = {
    CONTENT_LEFT_PX: get('main_content').leftPx,
    CONTENT_WIDTH_PX: width - get('main_content').leftPx - get('main_content').rightPx,
    SUBTITLE_MAX_WIDTH_PX: width - get('subtitles').leftPx - get('subtitles').rightPx,
    COVER_MAX_WIDTH_PX: width - get('cover_title').leftPx - get('cover_title').rightPx,
    CRITICAL_LEFT_PX: get('critical_text').leftPx,
    CRITICAL_WIDTH_PX: width - get('critical_text').leftPx - get('critical_text').rightPx,
  };
  const words: Record<string, string> = {
    ORIENTATION: p.platform.orientation,
    PLATFORM_UI: p.platform.ui,
    UI_ZONE: p.platform.zone,
    AVOIDANCE_ZONES: p.platform.avoidance(get('critical_text')),
  };
  const unknown: string[] = [];
  const out = s.replace(numericPlaceholder, (match: string, name: string, offset: string | undefined) => {
    if (name in numbers) return String(numbers[name] + (offset ? parseInt(offset, 10) : 0));
    if (name in words && !offset) return words[name];
    if (name === 'CANVAS' || name === 'HYPERFRAMES_VERSION' || name.startsWith('SCENE_')) return match;
    unknown.push(match);
    return match;
  });
  if (unknown.length > 0) throw new Error(`预设 ${p.id} 遇到未知占位符：${unknown.join(' ')}`);
  return substitute(p, out);
}

/** 一个画幅的 frame.md。 */
export function renderFrame(p: preset.Preset, template: string): string {
  if (!template.includes(canvasMarker)) throw new Error(`画幅模板缺少标记 ${canvasMarker}`);
  let text = substituteCanvas(p, template.replace(canvasMarker, canvasAndSafeArea(p)));
  if (p.layoutNotes) text = text.replace(/\n+$/, '\n') + p.layoutNotes.replace(/^\n+/, '\n');
  return text;
}

/** 画幅 id 为空时全部画幅。 */
export function selectTargets(id: string): preset.Preset[] {
  if (id === '') return preset.all();
  const p = preset.byID(id);
  if (!p) throw new Error(`未知预设 ${goQuote(id)}，可选：${preset.ids().join(' ')}`);
  return [p];
}

export interface Log {
  write(text: string): void;
}

/** frame.md 在资产里的位置（相对仓库根，/ 分隔）。 */
export function frameAssetPath(p: Pick<preset.Preset, 'id'>): string {
  return `assets/presets/${p.id}/frame.md`;
}

/** 把每个画幅的 frame.md 写进 root/assets/presets/，按画幅表顺序输出日志。 */
export function generate(repo: string, root: string, targets: preset.Preset[], out: Log): void {
  const template = loadTemplate(repo);
  for (const p of targets) {
    let body: string;
    try {
      body = renderFrame(p, template);
    } catch (err) {
      throw new Error(`渲染画幅 ${p.id}: ${(err as Error).message}`);
    }
    const rel = frameAssetPath(p);
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o644 });
    out.write(`generated ${rel}\n`);
  }
}

/** 从 start 向上找到仓库根：同时有 assets/shared 与 package.json 的那一层。 */
export function repoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'assets', 'shared'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('找不到仓库根目录（向上未发现含 assets/shared 的 package.json 目录）');
    dir = parent;
  }
}
