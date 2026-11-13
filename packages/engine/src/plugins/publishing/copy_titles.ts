// 移植自 internal/validate/copy_titles.go。
import { goQuote, goTrimSpace } from '../../gofmt';
import { compareBytes } from '../../gojson';
import { coverSpecs } from './cover_images';
import { get, isGoMap, type GoMap } from '../../validate/yamlany';

/**
 * 一个平台发布标题的字数上限，按字符计（一个汉字、一个字母、
 * 一个标点都算一个字）。平台输入框就是这么数的，按字节或按「汉字算一、
 * 字母算半」数都会放过超长标题，上传时被截断或拒收。
 */
interface TitleLimit {
  name: string;
  max: number;
}

/**
 * 平台标题字数表，依据 2026-10 作者在各平台上传时给出的上限：
 *
 *     抖音：标题最多 30 字
 *     小红书：标题最多 20 字
 *
 * 没有列出的平台不查字数。平台规则变了改这里，制作提示词「发布配置」一节同步改。
 */
export const titleLimits: ReadonlyMap<string, TitleLimit> = new Map([
  ['douyin', { name: '抖音', max: 30 }],
  ['xiaohongshu', { name: '小红书', max: 20 }],
]);

function titlePlatforms(): string {
  return [...titleLimits.keys()].sort(compareBytes).join(' / ');
}

/**
 * 按平台字数上限校验发布标题。
 *
 * copy.primary_title 对照 publish.md 的 platform；可选的 copy.platform_titles
 * 为同一条视频发多个平台时逐平台写标题，每条对照它自己的平台。一次报出全部
 * 超长项，免得改一条、重跑一次、再发现下一条。
 */
export function validateCopyTitles(data: GoMap): void {
  const copyBlock = get(data, 'copy');
  if (!isGoMap(copyBlock)) throw new Error('copy 必须是对象');
  const problems: string[] = [];
  const check = (field: string, platform: string, value: unknown) => {
    const limit = titleLimits.get(platform);
    if (!limit) return;
    const title = typeof value === 'string' ? value : '';
    const n = [...goTrimSpace(title)].length;
    if (n > limit.max) problems.push(`${field}：${limit.name}标题最多 ${limit.max} 个字，当前 ${n} 个字（${title}）`);
  };
  const platform = typeof data.platform === 'string' ? data.platform : '';
  check('copy.primary_title', platform, get(copyBlock, 'primary_title'));
  const raw = get(copyBlock, 'platform_titles');
  if (raw !== null) {
    if (!isGoMap(raw)) throw new Error('copy.platform_titles 必须是「平台: 标题」的对象');
    for (const k of Object.keys(raw).sort(compareBytes)) {
      if (!titleLimits.has(k) && !coverSpecs.has(k)) {
        problems.push(`copy.platform_titles 里有未知平台 ${goQuote(k)}（已知：${titlePlatforms()}）`);
        continue;
      }
      const title = raw[k];
      if (typeof title !== 'string') {
        problems.push(`copy.platform_titles.${k} 必须是字符串`);
        continue;
      }
      check('copy.platform_titles.' + k, k, title);
    }
  }
  if (problems.length > 0) throw new Error(`发布标题超出平台字数：\n- ${problems.join('\n- ')}`);
}
