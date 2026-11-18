// 移植自 internal/validate/cover_images.go。
import path from 'node:path';
import { goQuote } from '../../gofmt';
import { compareBytes } from '../../gojson';
import { decodeConfig } from '../../validate/imageconfig';
import { safeRelative } from '../../validate/validate';
import { get, GoFloat, isGoInt, isGoMap, type GoMap } from '../../validate/yamlany';

/**
 * 平台封面短边的下限。低于 1080 的封面在手机全屏和
 * 网页端都会被放大发虚；B 站常见的 1146×717 因此不够，16:10 用 1920×1200。
 */
export const minCoverShortSide = 1080;

/** 一个平台接受的封面比例，以及 ready 前必须备齐的比例；横屏成片要的不一样时另写 landscapeRequired。 */
export interface CoverSpec {
  name: string;
  allowed: string[];
  required: string[];
  landscapeRequired?: string[];
}

/**
 * 平台封面规格表。依据是 2026-10 对各平台上传界面与创作者
 * 资料的检索（官方帮助页多需登录，按两个以上来源一致取值）：
 *
 *     抖音：网页端上传要横封面（有效区 4:3）与竖封面（3:4，个人主页与双列信息流）
 *     小红书：首页只透出 3:4、1:1、4:3，其他比例会被裁切；封面跟着成片的方向，
 *             横屏成片的封面编辑器就是 4:3（与抖音的横版封面同一张，2026-11 作者实测），竖屏成片用 3:4
 *     视频号：竖版 3:4，横版 16:9；只有一个封面选择区域
 *     B 站：上传 16:10，各展示位再裁成 16:9 或 4:3，标题要放在中间安全区
 *     知乎：视频封面 16:10（来源单一，可信度低）
 *
 * 平台规则变了改这里，制作提示词第十二阶段的表格同步改。
 */
export const coverSpecs: ReadonlyMap<string, CoverSpec> = new Map([
  ['douyin', { name: '抖音', allowed: ['4:3', '3:4'], required: ['4:3', '3:4'] }],
  ['xiaohongshu', { name: '小红书', allowed: ['3:4', '1:1', '4:3'], required: ['3:4'], landscapeRequired: ['4:3'] }],
  ['channels', { name: '微信视频号', allowed: ['3:4', '16:9'], required: ['3:4'] }],
  ['bilibili', { name: 'B 站', allowed: ['16:10'], required: ['16:10'] }],
  ['zhihu', { name: '知乎', allowed: ['16:10'], required: ['16:10'] }],
]);

/** 成片是横屏吗：看 video.width_px / height_px，没写按竖屏。 */
export function landscapeVideo(data: GoMap): boolean {
  const video = get(data, 'video');
  if (!isGoMap(video)) return false;
  const w = intField(get(video, 'width_px'));
  const h = intField(get(video, 'height_px'));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w > h;
}

/** 这个平台在 ready 前必须备齐的封面比例。 */
export function requiredCovers(spec: CoverSpec, landscape: boolean): string[] {
  return landscape && spec.landscapeRequired ? spec.landscapeRequired : spec.required;
}

const coverExtensions = new Set(['.png', '.jpg', '.jpeg']);

function coverPlatforms(): string {
  return [...coverSpecs.keys()].sort(compareBytes).join(' / ');
}

/**
 * 校验 publish.md 里可选的 cover.images：平台封面图。
 *
 * 尺寸以文件实测为准，声明值只用来对账：手填的宽高与实际不符，说明封面
 * 改过却没回填 publish.md，发布时上传的就不是记录里那张。同一张图可以
 * 登记给多个平台（例如 3:4 竖封面同时给抖音与小红书）。
 */
export function validateCoverImages(projectRoot: string, data: GoMap): void {
  const coverRaw = get(data, 'cover');
  const cover = isGoMap(coverRaw) ? coverRaw : null;
  const have = new Map<string, Set<string>>();
  const raw = get(cover, 'images');
  if (raw !== null) {
    if (!Array.isArray(raw)) throw new Error('cover.images 必须是数组');
    raw.forEach((item, index) => {
      if (!isGoMap(item)) throw new Error(`cover.images[${index}] 必须是对象`);
      const [platform, ratio] = checkCoverImage(projectRoot, index, item);
      if (!have.has(platform)) have.set(platform, new Set());
      have.get(platform)!.add(ratio);
    });
  }
  if (get(data, 'publish_status') !== 'ready') return;
  const platform = typeof data.platform === 'string' ? data.platform : '';
  const spec = coverSpecs.get(platform);
  if (!spec) return;
  const missing = requiredCovers(spec, landscapeVideo(data)).filter((ratio) => !have.get(platform)?.has(ratio));
  if (missing.length > 0) throw new Error(`${spec.name}发布还缺 ${missing.join('、')} 封面，cover.images 不全时不能是 ready`);
}

/** filepath.Ext。 */
function goFileExt(p: string): string {
  for (let i = p.length - 1; i >= 0 && p[i] !== '/'; i--) {
    if (p[i] === '.') return p.slice(i);
  }
  return '';
}

function checkCoverImage(projectRoot: string, index: number, entry: GoMap): [string, string] {
  const str = (key: string) => (typeof entry[key] === 'string' ? (entry[key] as string) : '');
  const platform = str('platform');
  const ratio = str('ratio');
  const file = str('path');
  if (platform === '' || ratio === '' || file === '') throw new Error(`cover.images[${index}] 必须声明 platform、ratio 与 path`);
  const spec = coverSpecs.get(platform);
  if (!spec) throw new Error(`cover.images[${index}] 的平台 ${goQuote(platform)} 不在规格表里，可选：${coverPlatforms()}`);
  if (!spec.allowed.includes(ratio)) throw new Error(`cover.images[${index}]：${spec.name}封面只接受 ${spec.allowed.join('、')}，不接受 ${ratio}`);
  let rw: number;
  let rh: number;
  try {
    [rw, rh] = parseRatio(ratio);
  } catch (err) {
    throw new Error(`cover.images[${index}]: ${(err as Error).message}`, { cause: err });
  }
  const orientation = get(entry, 'orientation');
  if (typeof orientation === 'string' && orientation !== orientationOf(rw, rh)) {
    throw new Error(`cover.images[${index}] 的 orientation ${orientation} 与比例 ${ratio} 矛盾`);
  }
  try {
    safeRelative(projectRoot, file);
  } catch (err) {
    throw new Error(`cover.images[${index}]: ${(err as Error).message}`, { cause: err });
  }
  if (!coverExtensions.has(goFileExt(file).toLowerCase())) throw new Error(`cover.images[${index}] 必须是 PNG / JPEG 图片：${file}`);
  const full = path.join(projectRoot, file);
  let config;
  try {
    config = decodeConfig(full);
  } catch (err) {
    // 打不开（Node 的文件错误带 code）对应 Go 的 os.Open 失败；其余是解码失败。
    if ((err as NodeJS.ErrnoException).code !== undefined) throw new Error(`cover.images[${index}] 声明的封面不存在：${file}`, { cause: err });
    throw new Error(`cover.images[${index}] 读不出图片尺寸：${file}：${(err as Error).message}`, { cause: err });
  }
  const w = config.width;
  const h = config.height;
  const dw = intField(get(entry, 'width_px'));
  const dh = intField(get(entry, 'height_px'));
  if (dw !== w || dh !== h) throw new Error(`cover.images[${index}] 声明 ${dw}x${dh}，实际 ${w}x${h}：${file}`);
  if (w * rh !== h * rw) throw new Error(`cover.images[${index}] 必须正好 ${ratio}，实际 ${w}x${h}：${file}`);
  if (Math.min(w, h) < minCoverShortSide) throw new Error(`cover.images[${index}] 短边不足 ${minCoverShortSide} 像素（实际 ${w}x${h}）：${file}`);
  return [platform, ratio];
}

/** strconv.Atoi：可带正负号的十进制整数，超出 int64 报错。 */
function atoi(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const value = BigInt(s);
  if (value > 9223372036854775807n || value < -9223372036854775808n) return null;
  return Number(value);
}

export function parseRatio(ratio: string): [number, number] {
  const parts = ratio.split(':');
  if (parts.length === 2) {
    const w = atoi(parts[0]);
    const h = atoi(parts[1]);
    if (w !== null && h !== null && w > 0 && h > 0) return [w, h];
  }
  throw new Error(`ratio 必须写成「宽:高」，例如 4:3：${goQuote(ratio)}`);
}

function orientationOf(w: number, h: number): string {
  if (w > h) return 'landscape';
  if (w < h) return 'portrait';
  return 'square';
}

function intField(value: unknown): number {
  if (isGoInt(value)) return value;
  if (value instanceof GoFloat) return Math.trunc(value.value);
  return -1;
}

/** 平台的中文名，不认识的原样返回。Studio 发布页用它显示平台。 */
export function platformName(id: string): string {
  return coverSpecs.get(id)?.name ?? id;
}
