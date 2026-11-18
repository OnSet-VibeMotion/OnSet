// 移植自 internal/validate/cover_images_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorOf, read, replaceOnce, sharedSource, tempDir, writeImage } from '../../validate/testsupport';
import { publish } from './publish';

interface CoverImage {
  platform: string;
  ratio: string;
  path: string;
  w: number;
  h: number;
  /** 追加到条目里的字段，例如 orientation。 */
  extra: string;
}

const img = (platform: string, ratio: string, file: string, w: number, h: number, extra = ''): CoverImage => ({ platform, ratio, path: file, w, h, extra });

/** 在模板基础上声明封面图，并按声明尺寸写出图片（create 为真时）。 */
function publishWithCovers(status: string, platform: string, images: CoverImage[], create: boolean): [string, string] {
  const root = tempDir();
  let lines = '  images:\n';
  for (const image of images) {
    lines += `    - {platform: ${image.platform}, ratio: "${image.ratio}", path: ${image.path}, width_px: ${image.w}, height_px: ${image.h}${image.extra}}\n`;
    if (create) writeImage(path.join(root, image.path), image.w, image.h);
  }
  let text = replaceOnce(read(sharedSource('templates', 'publish.md')), '  images: []\n', lines);
  text = replaceOnce(text, 'publish_status: draft', 'publish_status: ' + status);
  text = replaceOnce(text, 'platform: unspecified', 'platform: ' + platform);
  const file = path.join(root, 'publish.md');
  fs.writeFileSync(file, text);
  return [root, file];
}

describe('cover images', () => {
  describe("accepts each platform's covers", () => {
    const cases: Record<string, CoverImage[]> = {
      douyin: [img('douyin', '4:3', 'covers/douyin-1440x1080.png', 1440, 1080), img('douyin', '3:4', 'covers/douyin-1080x1440.png', 1080, 1440)],
      xiaohongshu: [img('xiaohongshu', '3:4', 'covers/xhs-1080x1440.png', 1080, 1440)],
      channels: [img('channels', '3:4', 'covers/channels-1080x1440.png', 1080, 1440)],
      bilibili: [img('bilibili', '16:10', 'covers/bilibili-1920x1200.png', 1920, 1200)],
      zhihu: [img('zhihu', '16:10', 'covers/zhihu-1920x1200.png', 1920, 1200)],
    };
    for (const [platform, images] of Object.entries(cases)) {
      it(platform, () => {
        const [root, file] = publishWithCovers('ready', platform, images, true);
        publish(file, root);
      });
    }
  });

  // 同一张 3:4 竖封面可以登记给多个平台。
  it('allows one image for several platforms', () => {
    const [root, file] = publishWithCovers(
      'ready',
      'douyin',
      [img('douyin', '4:3', 'covers/a-4x3.png', 1440, 1080), img('douyin', '3:4', 'covers/a-3x4.png', 1080, 1440), img('xiaohongshu', '3:4', 'covers/a-3x4.png', 1080, 1440)],
      true,
    );
    publish(file, root);
  });

  describe('rejects bad cover images', () => {
    const cases: Array<{ name: string; img: CoverImage; actualW: number; actualH: number; create: boolean; wantPart: string }> = [
      { name: '平台不支持该比例', img: img('bilibili', '4:3', 'covers/a.png', 1440, 1080), actualW: 1440, actualH: 1080, create: true, wantPart: '16:10' },
      { name: '未知平台', img: img('weibo', '16:9', 'covers/a.png', 1920, 1080), actualW: 1920, actualH: 1080, create: true, wantPart: 'douyin' },
      { name: '比例与尺寸不符', img: img('douyin', '4:3', 'covers/a.png', 1440, 1000), actualW: 1440, actualH: 1000, create: true, wantPart: '4:3' },
      { name: '朝向与比例矛盾', img: img('douyin', '4:3', 'covers/a.png', 1440, 1080, ', orientation: portrait'), actualW: 1440, actualH: 1080, create: true, wantPart: 'orientation' },
      { name: '声明与实际不符', img: img('douyin', '4:3', 'covers/a.png', 1440, 1080), actualW: 1600, actualH: 1200, create: true, wantPart: '实际' },
      { name: '分辨率太低', img: img('bilibili', '16:10', 'covers/a.png', 1152, 720), actualW: 1152, actualH: 720, create: true, wantPart: '1080' },
      { name: '文件不存在', img: img('douyin', '4:3', 'covers/a.png', 1440, 1080), actualW: 0, actualH: 0, create: false, wantPart: '不存在' },
      { name: '逃出项目', img: img('douyin', '4:3', '../a.png', 1440, 1080), actualW: 0, actualH: 0, create: false, wantPart: '项目' },
      { name: '不是图片', img: img('douyin', '4:3', 'covers/a.txt', 1440, 1080), actualW: 0, actualH: 0, create: false, wantPart: 'PNG' },
    ];
    for (const tc of cases) {
      it(tc.name, () => {
        const [root, file] = publishWithCovers('draft', 'douyin', [tc.img], false);
        if (tc.create) writeImage(path.join(root, tc.img.path), tc.actualW, tc.actualH);
        expect(errorOf(() => publish(file, root)).message).toContain(tc.wantPart);
      });
    }
  });

  // 状态声称 ready 却缺发布平台要的封面，要到上传时才会发现。
  describe('ready requires the platform covers', () => {
    const cases: Array<{ platform: string; images: CoverImage[]; want: string }> = [
      { platform: 'douyin', images: [img('douyin', '4:3', 'covers/a.png', 1440, 1080)], want: '3:4' },
      { platform: 'xiaohongshu', images: [img('xiaohongshu', '1:1', 'covers/a.png', 1080, 1080)], want: '3:4' },
      { platform: 'bilibili', images: [], want: '16:10' },
    ];
    for (const tc of cases) {
      it(tc.platform, () => {
        const [root, file] = publishWithCovers('ready', tc.platform, tc.images, true);
        expect(errorOf(() => publish(file, root)).message).toContain(tc.want);
        // 草稿阶段放行。
        const [root2, file2] = publishWithCovers('draft', tc.platform, tc.images, true);
        publish(file2, root2);
      });
    }
  });
});

// 小红书的封面跟着成片方向：横屏成片的封面编辑器就是 4:3（与抖音的横版同一张），竖屏是 3:4。
describe('xiaohongshu covers follow the film orientation', () => {
  const withVideo = (file: string, w: number | string, h: number) =>
    fs.writeFileSync(file, replaceOnce(replaceOnce(fs.readFileSync(file, 'utf8'), '  width_px: null\n', `  width_px: ${w}\n`), '  height_px: null\n', `  height_px: ${h}\n`));
  const wide = img('xiaohongshu', '4:3', 'covers/xhs-1440x1080.png', 1440, 1080);
  const tall = img('xiaohongshu', '3:4', 'covers/xhs-1080x1440.png', 1080, 1440);

  it('a landscape film needs the 4:3 cover, not 3:4', () => {
    let [root, file] = publishWithCovers('ready', 'xiaohongshu', [wide], true);
    withVideo(file, 1920, 1080);
    publish(file, root);
    [root, file] = publishWithCovers('ready', 'xiaohongshu', [tall], true);
    withVideo(file, 1920, 1080);
    expect(errorOf(() => publish(file, root)).message).toContain('小红书发布还缺 4:3 封面');
  });

  it('a vertical film requires and accepts the 3:4 cover', () => {
    let [root, file] = publishWithCovers('ready', 'xiaohongshu', [wide], true);
    withVideo(file, 1080, 1920);
    expect(errorOf(() => publish(file, root)).message).toContain('小红书发布还缺 3:4 封面');
    [root, file] = publishWithCovers('ready', 'xiaohongshu', [tall], true);
    withVideo(file, 1080, 1920);
    publish(file, root);
  });

  it.each([null, '[1920]', '"1920"'])('defaults to 3:4 when the video width is %s', (width) => {
    for (const cover of [wide, tall]) {
      const [root, file] = publishWithCovers('ready', 'xiaohongshu', [cover], true);
      if (width !== null) withVideo(file, width, 1080);
      if (cover === tall) publish(file, root);
      else expect(errorOf(() => publish(file, root)).message).toContain('小红书发布还缺 3:4 封面');
    }
  });
});
