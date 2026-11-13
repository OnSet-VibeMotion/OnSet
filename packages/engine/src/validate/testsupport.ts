// 本包测试共用的辅助，对应 Go 测试文件里的包级辅助（validate_test.go、custom_style_test.go、
// cover_images_test.go）。不从 index.ts 导出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { onTestFinished } from 'vitest';
import * as assets from '../assets';
import * as preset from '../preset';

/** t.TempDir()：测试结束时删掉。 */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-validate-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 仓库根下的 assets/。 */
export function repoAssets(...parts: string[]): string {
  return path.join(assets.assetsBase(), 'assets', ...parts);
}

/** 风格素材 assets/styles/<默认风格>/<默认画幅>/…。 */
export function presetSource(...parts: string[]): string {
  return repoAssets('styles', preset.defaultStyle().id, preset.defaultPreset().id, ...parts);
}

/** 共用素材 assets/shared/…。 */
export function sharedSource(...parts: string[]): string {
  return repoAssets('shared', ...parts);
}

export const read = (file: string) => fs.readFileSync(file, 'utf8');

/** 只替换第一处；找不到时原样返回。 */
export function replaceOnce(body: string, old: string, replacement: string): string {
  const index = body.indexOf(old);
  if (index < 0) return body;
  return body.slice(0, index) + replacement + body.slice(index + old.length);
}

/**
 * 按 am init 的叠加方式搭一个只含风格相关文件的项目：frame.md、说明书、示例图来自风格 × 画幅树，
 * 字体来自共用树与风格树。
 */
export function styleFixtureForStyle(style: preset.Style, presetID: string, frameBody: string, guideBody: string): string {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frame.md'), frameBody);
  fs.writeFileSync(path.join(root, preset.guideDoc(style)), guideBody);
  const styleDir = repoAssets('styles', style.id, presetID);
  for (const [source, destination] of [
    [path.join(styleDir, 'assets', 'style-guide', 'examples'), path.join('assets', 'style-guide', 'examples')],
    [sharedSource('assets', 'fonts'), path.join('assets', 'fonts')],
    [path.join(styleDir, 'assets', 'fonts'), path.join('assets', 'fonts')],
  ]) {
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.join(root, destination), { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      fs.copyFileSync(path.join(source, entry.name), path.join(root, destination, entry.name));
    }
  }
  // 风格独有的字体来自字体池，按 am init 的方式拷进 assets/fonts/。
  for (const font of style.fonts) {
    for (const name of [font.file, font.license]) {
      fs.copyFileSync(repoAssets('fontpool', name), path.join(root, 'assets', 'fonts', name));
    }
  }
  return root;
}

export function styleFixtureFor(presetID: string, frameBody: string, guideBody: string): string {
  return styleFixtureForStyle(preset.defaultStyle(), presetID, frameBody, guideBody);
}

export function styleFixture(frameBody: string, guideBody: string): string {
  return styleFixtureFor(preset.defaultPreset().id, frameBody, guideBody);
}

export function builtinFixture(style: preset.Style, presetID: string): string {
  const dir = repoAssets('styles', style.id, presetID);
  return styleFixtureForStyle(style, presetID, read(path.join(dir, 'frame.md')), read(path.join(dir, preset.guideDoc(style))));
}

/** 铺一份该画幅预设的完整项目。 */
export function presetFixture(presetID: string): string {
  return builtinFixture(preset.defaultStyle(), presetID);
}

/** 同时改 frame.md 与默认风格说明书。 */
export function tamperBoth(root: string, from: string, to: string): void {
  for (const name of ['frame.md', preset.guideDoc(preset.defaultStyle())]) {
    const file = path.join(root, name);
    const body = read(file);
    const replaced = body.replace(from, () => to);
    if (replaced === body) throw new Error(`${name} 里找不到 ${JSON.stringify(from)}`);
    fs.writeFileSync(file, replaced);
  }
}

/** 把 PATH 指到 dir，测试结束时还原。 */
export function setPath(dir: string): void {
  const original = process.env.PATH;
  process.env.PATH = dir;
  onTestFinished(() => {
    process.env.PATH = original;
  });
}

/** 写一张指定尺寸的灰度 PNG（对应 Go 测试里的 png.Encode(image.NewGray(...))）。 */
export function writeImage(file: string, w: number, h: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h);
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** 期待 fn 抛错并返回错误；不抛时让测试失败。 */
export function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('期待报错，实际没有报错');
}
