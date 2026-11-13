// 移植自 internal/validate/validate.go。
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '../assets';
import { formatG, goPathError, goTrimSpace } from '../gofmt';
import { compareBytes } from '../gojson';
import * as preset from '../preset';
import * as styleimage from '../styleimage';
import { decodeFrontmatterYAML, get, hasKey, isGoInt, isGoMap, GoFloat, deepEqual, type GoMap } from './yamlany';

/** 写给用户看的输出（Go 的 io.Writer）。 */
export interface Writer {
  write(chunk: string): unknown;
}

const hexColor = /^#[0-9A-Fa-f]{6}$/;

function readFile(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw new Error(goPathError(err && (err as NodeJS.ErrnoException).code === 'EISDIR' ? 'read' : 'open', file, err), { cause: err });
  }
}

/** frontmatter：读文件并解析 YAML frontmatter，返回字段与正文。 */
export function frontmatter(file: string): [GoMap | null, string] {
  return parseFrontmatter(file, readFile(file));
}

/** bytes.SplitN(body, "---", 3)。 */
function splitN(body: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = body;
  while (out.length < n - 1) {
    const index = rest.indexOf(sep);
    if (index < 0) break;
    out.push(rest.slice(0, index));
    rest = rest.slice(index + sep.length);
  }
  out.push(rest);
  return out;
}

export function parseFrontmatter(file: string, body: Buffer | string): [GoMap | null, string] {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  const parts = splitN(text, '---', 3);
  if (parts.length !== 3 || goTrimSpace(parts[0]).length !== 0) throw new Error(`${file} 缺少 YAML frontmatter`);
  return [decodeFrontmatterYAML(parts[1]), parts[2]];
}

/** Go filepath.EvalSymlinks：失败时给出「lstat <第一个不存在的前缀>: …」。 */
function evalSymlinks(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    const abs = path.resolve(p);
    let current: string = path.sep;
    for (const part of abs.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        fs.lstatSync(current);
      } catch (inner) {
        throw new Error(goPathError('lstat', current, inner), { cause: inner });
      }
    }
    throw new Error(goPathError('lstat', abs, err), { cause: err });
  }
}

/** 路径必须是项目内的相对路径；解析符号链接后仍要落在项目里。非字符串或空串不查。 */
export function safeRelative(root: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') return;
  const p = value;
  if (path.isAbsolute(p) || p.includes('://')) throw new Error(`路径必须位于项目内：${p}`);
  const absRoot = path.resolve(root);
  const target = path.resolve(path.join(absRoot, p));
  const resolvedRoot = evalSymlinks(absRoot);
  const resolvedTarget = resolveExisting(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === '..' || rel.startsWith('..' + path.sep)) throw new Error(`路径逃出项目目录：${p}`);
}

/**
 * 解析路径里已经存在的那一段，再接上还不存在的部分。
 *
 * 只解析直接父目录不够：目标在一个还没建出来的子目录里时（例如还没出图的
 * covers/），父目录解析失败，路径就停留在未解析的形态；而项目根是解析过的
 * （macOS 的临时目录 /var 实际是 /private/var），两者一比就误判成逃出项目。
 */
export function resolveExisting(target: string): string {
  let rest = '';
  for (let dir = target; ; dir = path.dirname(dir)) {
    try {
      const resolved = fs.realpathSync(dir);
      return rest === '' ? resolved : path.join(resolved, rest);
    } catch {
      // 继续往上找。
    }
    const parent = path.dirname(dir);
    if (parent === dir) return target;
    rest = rest === '' ? path.basename(dir) : path.join(path.basename(dir), rest);
  }
}

/** 校验旧版风格文件：frame.md 与说明书 token 一致、schema 合法、字体与示例图齐备。 */
export function style(projectRoot: string): void {
  const [frameData] = frontmatter(path.join(projectRoot, 'frame.md'));
  const frame = frameData ?? {};
  // 说明书文件名随风格而定，从 frame.md 的 style_id 反查，不写死某一套风格。
  const styleID = typeof frame.style_id === 'string' ? frame.style_id : '';
  let s: preset.Style;
  try {
    s = styleOf(styleID);
  } catch (err) {
    throw new Error(`frame.md: ${(err as Error).message}`, { cause: err });
  }
  const [guideData] = frontmatter(path.join(projectRoot, preset.guideDoc(s)));
  const guide = guideData ?? {};
  let active: preset.Preset;
  try {
    active = validateStyleSchema(frame);
  } catch (err) {
    throw new Error(`frame.md: ${(err as Error).message}`, { cause: err });
  }
  try {
    validateStyleSchema(guide);
  } catch (err) {
    throw new Error(`风格说明书: ${(err as Error).message}`, { cause: err });
  }
  if (!deepEqualMaps(frameData, guideData)) throw new Error('frame.md 与人类可读风格说明的 token 不一致');
  const fontFiles = (frame.typography as GoMap).font_files as unknown[];
  fontFiles.forEach((item, index) => {
    const file = (item as GoMap).file as string;
    try {
      safeRelative(projectRoot, file);
    } catch (err) {
      throw new Error(`typography.font_files[${index}].file: ${(err as Error).message}`, { cause: err });
    }
    if (!isRegular(path.join(projectRoot, file))) throw new Error(`typography.font_files[${index}] 声明的字体文件不存在：${file}`);
  });
  try {
    validateMoodRefs(projectRoot, get(frame, 'mood_refs'));
  } catch (err) {
    throw new Error(`frame.md: ${(err as Error).message}`, { cause: err });
  }
  for (const item of frame.scene_archetypes as unknown[]) {
    const file = (item as GoMap).example_png as string;
    try {
      safeRelative(projectRoot, file);
    } catch (err) {
      throw new Error(`example_png: ${(err as Error).message}`, { cause: err });
    }
    const [width, height] = pngDimensions(path.join(projectRoot, file));
    if (width !== active.canvas.widthPx || height !== active.canvas.heightPx) {
      throw new Error(`风格示例必须为 ${active.canvas.widthPx}x${active.canvas.heightPx}，实际 ${width}x${height}：${file}`);
    }
  }
}

/** reflect.DeepEqual 两个 map[string]any（nil 与空 map 不相等）。 */
function deepEqualMaps(a: GoMap | null, b: GoMap | null): boolean {
  if (a === null || b === null) return a === b;
  return deepEqual(a, b);
}

function isRegular(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 从 frame.md 的 style_id 找出风格身份。
 *
 * 内置风格查表。自定义风格（custom-*）统一返回 preset.CustomStyle：它的说明书
 * 路径固定，不从用户写的 style_name 拼，名字里出现什么字符都不影响找文件。
 * 草稿单独拦下并说清还差哪一步——否则用户看到的是示例图缺失之类的连带错误。
 */
function styleOf(id: string): preset.Style {
  if (id === preset.DraftStyleID) {
    throw new Error(
      `自定义风格尚未定稿（style_id 仍为 ${id}），定风格阶段未完成：` +
        `按 docs/style-brief.md 的描述改写 frame.md 与 ${preset.guideDoc(preset.CustomStyle)}、画好四张示例图后再校验`,
    );
  }
  if (preset.isCustomStyleID(id)) return preset.CustomStyle;
  return preset.styleByIDOrError(id);
}

/** 氛围参照图允许的格式：生图工具的产物多为 PNG，也可能是用户自己放进来的照片。 */
const moodRefExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** filepath.Ext。 */
function goFileExt(p: string): string {
  for (let i = p.length - 1; i >= 0 && p[i] !== '/'; i--) {
    if (p[i] === '.') return p.slice(i);
  }
  return '';
}

/**
 * 校验可选的氛围参照图。
 *
 * 不查尺寸：生图工具不能指定像素尺寸，参照图也只取质感与装饰语言，不当版式
 * 基准用——版式基准是 scene_archetypes 的示例图，那边才严格要求画布尺寸。
 */
function validateMoodRefs(projectRoot: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (!Array.isArray(value)) throw new Error('mood_refs 必须是路径数组');
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item === '') throw new Error(`mood_refs[${index}] 必须是非空字符串`);
    try {
      safeRelative(projectRoot, item);
    } catch (err) {
      throw new Error(`mood_refs[${index}]: ${(err as Error).message}`, { cause: err });
    }
    if (!moodRefExtensions.has(goFileExt(item).toLowerCase())) throw new Error(`mood_refs[${index}] 必须是 PNG / JPEG / WebP 图片：${item}`);
    if (!isRegular(path.join(projectRoot, item))) throw new Error(`mood_refs[${index}] 声明的参照图不存在：${item}`);
  });
}

/** 校验风格 token，并返回该 frame.md 对应的画幅预设，供调用方继续按画幅校验示例图尺寸。 */
export function validateStyleSchema(tokens: GoMap): preset.Preset {
  const required = ['schema_version', 'style_id', 'style_name', 'scope', 'canvas', 'safe_area', 'colors', 'typography', 'spacing', 'radius', 'scene_archetypes', 'motion', 'audio', 'subtitles', 'cover', 'forbidden'];
  requireKeys(tokens, required, '');
  if (tokens.schema_version !== 1) throw new Error('schema_version 必须为 1');
  if (typeof tokens.style_id !== 'string') throw new Error('style_id 必须是字符串');
  if (typeof tokens.style_name !== 'string') throw new Error('style_name 必须是字符串');
  if (!Array.isArray(tokens.scope) || tokens.scope.length === 0) throw new Error('scope 必须是非空数组');
  const canvas = requireMap(tokens.canvas, 'canvas');
  const { width_px: width, height_px: height, fps, orientation } = canvas;
  if (!isGoInt(width) || !isGoInt(height) || !isGoInt(fps) || typeof orientation !== 'string') {
    throw new Error('canvas 必须包含整数 width_px、height_px、fps 与字符串 orientation');
  }
  const active = preset.byCanvas(width, height, fps, orientation);
  if (!active) throw new Error(`canvas ${width}x${height}、${fps}fps、${orientation} 不是内置画幅，可选：${preset.ids().join(' ')}`);
  const safeArea = requireMap(tokens.safe_area, 'safe_area');
  // 逐值比对 anchor 推导结果，而不只是检查字段齐全非负：手改一个 top_px
  // 在旧校验下完全查不出来，成片才会发现字幕压线。
  const expected = preset.resolveSafeArea(active);
  if (Object.keys(safeArea).length !== expected.length) {
    throw new Error(`safe_area 必须恰好包含 ${expected.length} 个安全区，实际 ${Object.keys(safeArea).length} 个`);
  }
  for (const item of expected) {
    const box = requireMap(get(safeArea, item.name), 'safe_area.' + item.name);
    requireKeys(box, ['left_px', 'right_px', 'top_px', 'bottom_px'], 'safe_area.' + item.name);
    for (const [name, want] of [
      ['left_px', item.box.leftPx],
      ['right_px', item.box.rightPx],
      ['top_px', item.box.topPx],
      ['bottom_px', item.box.bottomPx],
    ] as const) {
      const got = box[name];
      if (!isGoInt(got)) throw new Error(`safe_area.${item.name}.${name} 必须是整数`);
      if (got !== want) throw new Error(`safe_area.${item.name}.${name} = ${got}，按 ${active.id} 画幅应为 ${want}`);
    }
  }
  let colors: GoMap;
  try {
    colors = requireMap(tokens.colors, 'colors');
  } catch {
    throw new Error('colors 必须是非空对象');
  }
  if (Object.keys(colors).length === 0) throw new Error('colors 必须是非空对象');
  // Go 遍历 map 的顺序是随机的；这里按键排序。
  for (const name of Object.keys(colors).sort(compareBytes)) {
    const value = colors[name];
    if (typeof value !== 'string' || !hexColor.test(value)) throw new Error(`colors.${name} 必须是六位十六进制颜色`);
  }
  const typography = requireMap(tokens.typography, 'typography');
  requireKeys(typography, ['primary_stack', 'mono_stack', 'sizes_px', 'weights', 'line_heights', 'font_files'], 'typography');
  validateFontStacks(typography);
  for (const [name, min] of [
    ['sizes_px', 1],
    ['weights', 1],
    ['line_heights', 0.5],
  ] as const) {
    const mapping = requireMap(typography[name], 'typography.' + name);
    validateNumericMap(mapping, 'typography.' + name, min);
  }
  for (const name of ['spacing', 'radius']) {
    const mapping = requireMap(tokens[name], name);
    validateNumericMap(mapping, name, 0);
  }
  const radius = tokens.radius as GoMap;
  if (get(radius, 'pill_px') !== 999) throw new Error('radius.pill_px 必须为 999');
  const archetypes = tokens.scene_archetypes;
  const canonical = preset.ArchetypeIDs;
  if (!Array.isArray(archetypes) || archetypes.length !== canonical.length) throw new Error('scene_archetypes 必须包含四种标准类型');
  archetypes.forEach((item, index) => {
    const entry = requireMap(item, `scene_archetypes[${index}]`);
    if (get(entry, 'id') !== canonical[index]) throw new Error('scene_archetypes 必须按标准顺序声明');
    if (typeof get(entry, 'name') !== 'string') throw new Error(`scene_archetypes[${index}].name 必须是字符串`);
    if (typeof get(entry, 'example_png') !== 'string') throw new Error(`scene_archetypes[${index}].example_png 必须是字符串`);
  });
  const motion = requireMap(tokens.motion, 'motion');
  requireKeys(motion, ['phases', 'entrance_seconds', 'exit_seconds', 'transition_seconds', 'entrance_ease', 'exit_ease', 'verbs'], 'motion');
  const phases = requireMap(motion.phases, 'motion.phases');
  validateNumericMap(phases, 'motion.phases', 0);
  let total = 0;
  for (const value of Object.values(phases)) total += number(value);
  if (total < 0.999999 || total > 1.000001) throw new Error('motion.phases 之和必须为 1');
  const audio = requireMap(tokens.audio, 'audio');
  requireKeys(audio, ['sample_rate_hz', 'channels', 'final_integrated_lufs', 'final_lufs_tolerance', 'true_peak_max_dbtp', 'bgm_ducking_db', 'bgm_fade_seconds', 'sfx_max_simultaneous'], 'audio');
  if (audio.sample_rate_hz !== 48000 || audio.channels !== 2) throw new Error('audio 必须为 48000Hz 双声道');
  const subtitles = requireMap(tokens.subtitles, 'subtitles');
  requireKeys(subtitles, ['required', 'font_size_px', 'max_lines', 'max_fullwidth_chars_per_line', 'line_height', 'background', 'text_color', 'padding_px', 'radius_px', 'break_rules'], 'subtitles');
  const cover = requireMap(tokens.cover, 'cover');
  requireKeys(cover, ['frame_zero_complete', 'default_lines', 'max_lines', 'font_size_px', 'max_width_px', 'contrast_ratio_min', 'stable_frames'], 'cover');
  const stableFrames = cover.stable_frames;
  if (cover.frame_zero_complete !== true || !isGoInt(stableFrames) || stableFrames < 18) {
    throw new Error('cover 必须从第零帧完整显示并稳定至少 18 帧');
  }
  const forbidden = tokens.forbidden;
  if (!Array.isArray(forbidden) || forbidden.length === 0) throw new Error('forbidden 必须是非空字符串数组');
  for (const item of forbidden) {
    if (typeof item !== 'string') throw new Error('forbidden 必须是非空字符串数组');
  }
  return active;
}

/**
 * HyperFrames 0.8.225 会自动内联的字体族（CANONICAL_FONTS，背后是 @fontsource/* 包）。
 * 清单里没有任何简体中文字体：唯一的 CJK 项 Noto Sans JP 缺失大量简体字，不能当替代品。
 *
 * 0.8.185 之后编译器对清单外的字体族多了两条兜底：渲染时向 Google Fonts 现取，
 * 取不到再从本机字体目录抓取内联。两条都让结果取决于网络或渲染那台机器，
 * 所以这里仍只认清单与项目里显式声明的字体，不把兜底当作「会自动内联」。
 */
const autoEmbeddedFonts = new Set([
  'archivo black', 'eb garamond', 'ibm plex mono', 'inter',
  'jetbrains mono', 'lato', 'league gothic', 'montserrat',
  'noto sans jp', 'nunito', 'open sans', 'oswald',
  'outfit', 'playfair display', 'poppins', 'roboto',
  'source code pro', 'space mono',
]);

/** CSS 内建的兜底关键字，不需要字体文件。 */
const genericFontFamilies = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive',
  'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif',
  'ui-monospace', 'emoji', 'math', 'fangsong',
]);

/** strings.Trim(s, `"'`)。 */
function trimQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === '"' || s[start] === "'")) start++;
  while (end > start && (s[end - 1] === '"' || s[end - 1] === "'")) end--;
  return s.slice(start, end);
}

/** strings.ToLower：Unicode 小写（与 JS 的 toLowerCase 在常见字符上一致）。 */
function fontStackFamilies(stack: string): string[] {
  const families: string[] = [];
  for (const part of stack.split(',')) {
    const name = trimQuotes(goTrimSpace(part)).toLowerCase();
    if (name !== '') families.push(name);
  }
  return families;
}

/**
 * 保证字体栈里的每个字体族要么被 HyperFrames 自动内联，要么由项目自带文件。渲染机是干净的无头 Chrome：
 * 写一个只存在于本机的系统字体（PingFang SC、Hiragino Sans GB 等），本地渲染会因为回退而"看着正常"，
 * 云端和 CI 上排版却是错的，而且没有任何报错。
 */
export function validateFontStacks(typography: GoMap): void {
  const declared = new Set<string>();
  const entries = get(typography, 'font_files');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('typography.font_files 必须是非空数组');
  entries.forEach((item, index) => {
    const entry = requireMap(item, `typography.font_files[${index}]`);
    const family = get(entry, 'family');
    const file = get(entry, 'file');
    const weight = number(get(entry, 'weight'));
    if (typeof family !== 'string' || family === '' || typeof file !== 'string' || file === '' || weight < 1) {
      throw new Error(`typography.font_files[${index}] 必须声明 family、weight 和 file`);
    }
    declared.add(family.toLowerCase());
  });
  const used = new Set<string>();
  // display_stack 可选：游戏与编辑类风格的展示字（像素字、手写字、粗黑展示体）
  // 不能放进 primary_stack 的首位，否则渲染器会拿它排正文。
  const keys = ['primary_stack', 'mono_stack'];
  if (hasKey(typography, 'display_stack')) keys.push('display_stack');
  for (const key of keys) {
    const stack = get(typography, key);
    if (typeof stack !== 'string' || stack === '') throw new Error(`typography.${key} 必须是非空字符串`);
    for (const family of fontStackFamilies(stack)) {
      if (genericFontFamilies.has(family)) continue;
      used.add(family);
      if (autoEmbeddedFonts.has(family) || declared.has(family)) continue;
      throw new Error(
        `typography.${key} 使用了既不会被 HyperFrames 自动内联、` +
          `也没有在 typography.font_files 中自带文件的字体：${family}（渲染机没有本机系统字体，` +
          '排版会静默回退）',
      );
    }
  }
  // Go 遍历 map 的顺序是随机的；这里按名字排序。
  for (const family of [...declared].sort(compareBytes)) {
    if (!used.has(family)) throw new Error(`typography.font_files 声明了字体 ${family}，但没有任何字体栈使用它`);
  }
}

function requireMap(value: unknown, name: string): GoMap {
  if (!isGoMap(value)) throw new Error(`${name} 必须是对象`);
  return value;
}

function requireKeys(mapping: GoMap, keys: string[], name: string): void {
  for (const key of keys) {
    if (!hasKey(mapping, key)) {
      if (name === '') throw new Error(`缺少必填字段：${key}`);
      throw new Error(`缺少必填字段：${name}.${key}`);
    }
  }
}

/** int 与 float64 取数值，其余为 -1。 */
function number(value: unknown): number {
  if (isGoInt(value)) return value;
  if (value instanceof GoFloat) return value.value;
  return -1;
}

export function validateNumericMap(mapping: GoMap, name: string, minimum: number): void {
  // Go 遍历 map 的顺序是随机的；这里按键排序。
  for (const key of Object.keys(mapping).sort(compareBytes)) {
    const numeric = number(mapping[key]);
    if (!Number.isFinite(numeric) || numeric < minimum) throw new Error(`${name}.${key} 必须是大于等于 ${formatG(minimum)} 的数字`);
  }
}

/** 读 PNG 头里的宽高。 */
export function pngDimensions(file: string): [number, number] {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    throw new Error(goPathError('open', file, err), { cause: err });
  }
  try {
    const header = Buffer.alloc(24);
    let read = 0;
    try {
      while (read < 24) {
        const n = fs.readSync(fd, header, read, 24 - read, null);
        if (n === 0) break;
        read += n;
      }
    } catch (err) {
      throw new Error(`读取 PNG ${file}: ${goPathError('read', file, err)}`, { cause: err });
    }
    if (read < 24) throw new Error(`读取 PNG ${file}: ${read === 0 ? 'EOF' : 'unexpected EOF'}`);
    if (!header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error(`不是 PNG：${file}`);
    return [header.readUInt32BE(16), header.readUInt32BE(20)];
  } finally {
    fs.closeSync(fd);
  }
}

/** strings.NewReplacer(pairs...)：从左到右扫描，同一位置按参数顺序取第一个匹配。 */
class Replacer {
  constructor(private readonly pairs: Array<[string, string]>) {}

  replace(s: string): string {
    if (this.pairs.length === 0) return s;
    let out = '';
    let i = 0;
    outer: while (i < s.length) {
      for (const [from, to] of this.pairs) {
        if (from !== '' && s.startsWith(from, i)) {
          out += to;
          i += from.length;
          continue outer;
        }
      }
      out += s[i];
      i++;
    }
    return out;
  }
}

/**
 * 重新生成风格示例：写出四种骨架的 SVG、渲染 PNG 并拼 contact sheet。内置 SVG 是不变的模板，
 * 重新生成从不依赖上一次留下的文件。
 *
 * 项目改过配色时，示例图要跟着换色：以内置 frame.md 的配色为基准，把 SVG 里
 * 每个基准色替换成项目 frame.md 同名 token 的值。基准取自项目所用风格自己的
 * 内置 frame.md，而不是写死某一套风格的色板。
 *
 * 自定义风格没有内置模板，示例 SVG 是定风格阶段画进项目的：直接渲染项目里的
 * SVG，不改写、不重着色。草稿也放行，画示例图本来就在定稿之前。
 */
export function regenerateExamples(projectRoot: string, output: Writer): void {
  const [frameData] = frontmatter(path.join(projectRoot, 'frame.md'));
  const frame = frameData ?? {};
  const colors = get(frame, 'colors');
  if (!isGoMap(colors)) throw new Error('frame.md 的 colors 必须是对象');
  const active = frameCanvas(frame);
  const styleID = typeof frame.style_id === 'string' ? frame.style_id : '';
  if (preset.isCustomStyleID(styleID)) {
    regenerateCustomExamples(projectRoot, active, colors, output);
    return;
  }
  let s: preset.Style;
  try {
    s = preset.styleByIDOrError(styleID);
  } catch (err) {
    throw new Error(`frame.md: ${(err as Error).message}`, { cause: err });
  }
  const templateDir = 'assets/styles/' + s.id + '/' + active.id;
  const recolor = recolorMap(templateDir + '/frame.md', colors);
  const source = (name: string): string => {
    const rel = templateDir + '/assets/style-guide/examples/' + name + '.svg';
    return recolor.replace(readEmbedded(rel, `读取内置示例 ${name}`));
  };
  renderExamples(projectRoot, active, source, recolor.replace(s.sheetBackground), output);
}

/** assets.Files.ReadFile：rel 是相对仓库根的 embed 路径（assets/...）。 */
function readEmbedded(rel: string, context: string): string {
  const inner = rel.replace(/^assets\//, '');
  const tree = assets.files();
  if (!tree.exists(inner) || fs.statSync(path.join(tree.dir, inner)).isDirectory()) {
    throw new Error(`${context}: open ${rel}: file does not exist`);
  }
  return tree.readText(inner);
}

/**
 * 从项目 frame.md 的 canvas 反查画幅预设。
 *
 * 示例图模板按画幅分目录，必须从项目自己的 canvas 反查，不能取默认预设：
 * 拿 3:4 的模板铺进 9:16 项目，style 会立刻拒绝，但用户看到的是尺寸报错而
 * 不是「模板取错了」。
 */
function frameCanvas(frame: GoMap): preset.Preset {
  const canvas = get(frame, 'canvas');
  if (!isGoMap(canvas)) throw new Error('frame.md 的 canvas 必须是对象');
  const width = isGoInt(canvas.width_px) ? canvas.width_px : 0;
  const height = isGoInt(canvas.height_px) ? canvas.height_px : 0;
  const fps = isGoInt(canvas.fps) ? canvas.fps : 0;
  const orientation = typeof canvas.orientation === 'string' ? canvas.orientation : '';
  const active = preset.byCanvas(width, height, fps, orientation);
  if (!active) throw new Error(`frame.md 的画幅 ${width}x${height} 不是内置画幅，无法定位示例模板`);
  return active;
}

/** 渲染自定义风格画进项目的示例 SVG。缺的 SVG 一次列全，免得「补一张、重跑、再发现下一张」。 */
function regenerateCustomExamples(projectRoot: string, active: preset.Preset, colors: GoMap, output: Writer): void {
  const dir = path.join(projectRoot, 'assets', 'style-guide', 'examples');
  const missing: string[] = [];
  for (const name of preset.ArchetypeIDs) {
    if (!isRegular(path.join(dir, name + '.svg'))) missing.push('assets/style-guide/examples/' + name + '.svg');
  }
  if (missing.length > 0) throw new Error(`自定义风格的示例图要先画成 SVG，缺少：${missing.join('、')}`);
  const source = (name: string): string => readFile(path.join(dir, name + '.svg')).toString('utf8');
  let background = preset.CustomStyle.sheetBackground;
  const value = get(colors, 'canvas');
  if (typeof value === 'string' && hexColor.test(value)) background = value;
  renderExamples(projectRoot, active, source, background, output);
}

/** filepath.Glob(dir/*.woff2)：按名字排序。 */
function globWoff2(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.woff2'))
    .sort(compareBytes)
    .map((name) => path.join(dir, name));
}

/**
 * 把四种骨架的 SVG 写进项目并渲染成 PNG，再拼 contact sheet。
 * source 返回的内容与项目里已有的 SVG 相同时不重写，项目自带的 SVG 保持原样。
 */
function renderExamples(projectRoot: string, active: preset.Preset, source: (name: string) => string, background: string, output: Writer): void {
  const outputDir = path.join(projectRoot, 'assets', 'style-guide', 'examples');
  fs.mkdirSync(outputDir, { recursive: true });
  styleimage.checkRenderer();
  const projectFonts = globWoff2(path.join(projectRoot, 'assets', 'fonts'));
  const [fontDir, cleanup] = styleimage.decompressFonts(projectFonts);
  try {
    const pngPaths: string[] = [];
    for (const name of preset.ArchetypeIDs) {
      const svg = source(name);
      const svgPath = path.join(outputDir, name + '.svg');
      const pngPath = path.join(outputDir, name + '.png');
      let existing: string | null = null;
      try {
        existing = fs.readFileSync(svgPath, 'utf8');
      } catch {
        existing = null;
      }
      if (existing !== svg) fs.writeFileSync(svgPath, svg, { mode: 0o644 });
      styleimage.renderSVG(svgPath, pngPath, fontDir);
      output.write(`generated assets/style-guide/examples/${name}.svg\ngenerated assets/style-guide/examples/${name}.png\n`);
      pngPaths.push(pngPath);
    }
    const contactPath = path.join(outputDir, 'contact-sheet.png');
    const thumbnailWidthPx = 405;
    const thumb = `${thumbnailWidthPx}x${Math.trunc((thumbnailWidthPx * active.canvas.heightPx) / active.canvas.widthPx)}`;
    styleimage.contactSheet(pngPaths, contactPath, thumb, background, '4x1');
    output.write('generated assets/style-guide/examples/contact-sheet.png\n');
  } finally {
    cleanup();
  }
}

/**
 * 以内置 frame.md 的配色为基准，生成「基准色 → 项目色」的替换器。
 * 基准色按大小写不敏感匹配，SVG 里手写的十六进制色大小写不一。
 */
function recolorMap(embeddedFrame: string, colors: GoMap): Replacer {
  const body = readEmbedded(embeddedFrame, `读取内置风格 ${embeddedFrame}`);
  const [builtin] = parseFrontmatter(embeddedFrame, body);
  const baseline = get(builtin, 'colors');
  if (!isGoMap(baseline)) throw new Error(`内置风格 ${embeddedFrame} 的 colors 不是对象`);
  const pairs: Array<[string, string]> = [];
  for (const name of Object.keys(baseline).sort(compareBytes)) {
    const original = typeof baseline[name] === 'string' ? (baseline[name] as string) : '';
    const value = get(colors, name);
    if (typeof value !== 'string' || !hexColor.test(value)) throw new Error(`frame.md 的 colors.${name} 必须是六位十六进制颜色`);
    if (original.toLowerCase() === value.toLowerCase()) continue;
    pairs.push([original.toUpperCase(), value], [original.toLowerCase(), value]);
  }
  return new Replacer(pairs);
}
