import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as hyperframes from '@onset/engine/hyperframes';
import { fakeCLI } from '@onset/engine/hyperframes/hftest';
import { runIn, setenv, tempDir } from './testutil';

function fixture() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"one","duration_seconds":1,"output":"one.mp4","transcript":"transcript.srt","text":"内容"}');
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\n内容\n');
  fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  const cli = tempDir();
  fakeCLI(cli);
  const script = path.join(cli, 'node_modules', 'hyperframes', 'cli.cjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync('.onset/commands.log', JSON.stringify(args) + '\\n');
if (args[0] === 'check') {
  if (fs.existsSync('bad-composition')) { console.error('layout failed'); process.exit(1); }
  fs.mkdirSync('.hyperframes', { recursive: true });
  fs.writeFileSync('.hyperframes/history-id', 'history');
  fs.appendFileSync('.hyperframes/video-state.json', 'inspection');
  console.log(fs.existsSync('.onset/check-fixture.json')
    ? fs.readFileSync('.onset/check-fixture.json', 'utf8') : JSON.stringify({ ok: true }));
} else {
  if (fs.existsSync('.onset/change-during-preview')) fs.appendFileSync('index.html', '<!-- changed -->');
  const dir = args[args.indexOf('--output') + 1];
  const sheet = path.resolve(dir, 'contact-sheet.jpg');
  const frames = args[args.indexOf('--at') + 1].split(',').map((time, i) => {
    const file = path.resolve(dir, 'frame-' + i + '.png');
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8wwACLGCSAQANBAECv1AVswAAAABJRU5ErkJggg==', 'base64'));
    return { path: file, time: Number(time) };
  });
  fs.writeFileSync(sheet, 'sheet');
  console.log(JSON.stringify({ ok: true, contactSheets: [sheet], frames }));
}`);
  if (process.platform !== 'win32') {
    fs.writeFileSync(hyperframes.cliBinary(cli), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  setenv(hyperframes.CLIDirEnv, cli);
  return dir;
}

it('checks once and generates one contact sheet for exact integer frames', async () => {
  const dir = fixture();
  const { code, out } = await runIn(dir, ['scene', 'preview-check', '--frames', '0,12,29']);
  expect(code, out).toBe(0);
  expect(out).toContain('contact-sheet.jpg');
  expect(out).toContain('0, 12, 29');
  const [check, snapshot] = commands(dir);
  expect(check.slice(0, 2)).toEqual(['check', '--json']);
  expect(snapshot).toEqual(expect.arrayContaining(['snapshot', '--no-end', '--describe', 'false', '--at', '0.000000,0.400000,0.966667']));
  expect(fs.existsSync(path.join(dir, 'one.mp4'))).toBe(false);
});

it('checks all ten requested frames in one call', async () => {
  const dir = fixture();
  const frames = '0,6,12,15,18,20,22,24,27,29';
  const result = await runIn(dir, ['scene', 'preview-check', '--frames', frames]);
  expect(result.code, result.out).toBe(0);
  expect(result.out).toContain(frames.split(',').join(', '));
  expect(commands(dir).map(args => args[0])).toEqual(['check', 'snapshot']);
});

it('validates frame bounds before starting and leaves the check error without taking screenshots', async () => {
  const dir = fixture();
  const invalid = await runIn(dir, ['scene', 'preview-check', '--frames', '30']);
  expect(invalid.code).toBe(1);
  expect(invalid.out).toContain('0–29');
  expect(fs.existsSync(path.join(dir, '.onset/commands.log'))).toBe(false);
  fs.writeFileSync(path.join(dir, 'bad-composition'), '');
  const failure = await runIn(dir, ['scene', 'preview-check']);
  expect(failure.code).toBe(1);
  expect(failure.out).toContain('layout failed');
  expect(commands(dir).map(args => args[0])).toEqual(['check']);
});

it('keeps preview findings actionable while retaining the complete check report', async () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, '.onset'));
  const runtimeWarnings = [
    { code: 'console_warning', severity: 'warning', message: 'Electron Security Warning (Insecure Content-Security-Policy) from the preview shell' },
    { code: 'console_warning', severity: 'warning', message: 'Refused to load the title font because it violates the Content Security Policy' },
  ];
  const layoutWarning = { code: 'overflow', severity: 'warning', message: 'Title overflows', selector: '#title', time: 0.25 };
  const report = {
    ok: true,
    runtime: { ok: true, findings: runtimeWarnings },
    craft: { findings: [{ code: 'film_silent', severity: 'warning', message: 'This film has no sound source' }] },
    layout: { ok: true, findings: [layoutWarning, layoutWarning, { ...layoutWarning, time: 0.5 }] },
  };
  fs.writeFileSync(path.join(dir, '.onset/check-fixture.json'), JSON.stringify(report));
  const args = ['scene', 'preview-check', '--frames', '0'];
  for (const result of [await runIn(dir, args), await runIn(dir, args)]) {
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain('no sound source');
    expect(result.out).not.toContain('from the preview shell');
    expect(result.out).toContain(runtimeWarnings[1]!.message);
    expect(result.out).toContain('本次通过：运行时、布局');
    expect(result.out.match(/Title overflows/g)).toHaveLength(2);
    const saved = result.out.match(/完整检查记录：([^\n\r]+)/)?.[1];
    expect(JSON.parse(fs.readFileSync(saved!, 'utf8'))).toEqual(report);
  }
  expect(commands(dir).map(args => args[0])).toEqual(['check', 'snapshot']);
});

function commands(dir: string): string[][] {
  return fs.readFileSync(path.join(dir, '.onset/commands.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

it('reuses successful previews, invalidates on asset changes, and can force a fresh preview', async () => {
  const dir = fixture();
  const args = ['scene', 'preview-check', '--frames', '0,29'];
  fs.writeFileSync(path.join(dir, 'local-font.woff2'), 'first font');
  const original = await runIn(dir, args);
  const repeat = await runIn(dir, args);
  expect(original.code, original.out).toBe(0);
  expect(repeat.code, repeat.out).toBe(0);
  expect(commands(dir).map(cmd => cmd[0])).toEqual(['check', 'snapshot']);
  expect(repeat.out).toContain('缓存命中');

  fs.writeFileSync(path.join(dir, 'local-font.woff2'), 'new font');
  expect((await runIn(dir, args)).code).toBe(0);
  expect(commands(dir)).toHaveLength(4);

  expect((await runIn(dir, [...args, '--refresh'])).code).toBe(0);
  expect(commands(dir)).toHaveLength(6);
});

it('reshoots only the missing or corrupted frame without repeating the composition check', async () => {
  const dir = fixture();
  const initial = await runIn(dir, ['scene', 'preview-check', '--frames', '0,29']);
  expect(initial.code, initial.out).toBe(0);
  const [, snapshot] = commands(dir);
  fs.writeFileSync(path.join(snapshot![snapshot!.indexOf('--output') + 1]!, 'frame-1.png'), 'corrupted');

  const repaired = await runIn(dir, ['scene', 'preview-check', '--frames', '0,29']);
  expect(repaired.code, repaired.out).toBe(0);
  expect(repaired.out).toContain('缓存命中：合成检查，1 张截图');
  const [, , recapture] = commands(dir);
  expect(recapture).toEqual(expect.arrayContaining(['snapshot', '--at', '0.966667']));
});

it('reuses previews with the bundled local GSAP, and rejects modified copies for caching', async () => {
  const dir = fixture();
  const cli = hyperframes.requireCLI(process.env);
  const bundled = path.join(cli, 'node_modules/hyperframes/dist/vendor/npm/gsap@3.15.0/dist/gsap.min.js');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  const gsap = '/*! License at https://gsap.com */ window.gsap = {};';
  fs.writeFileSync(bundled, gsap);
  const vendor = path.join(dir, 'vendor');
  fs.mkdirSync(vendor);
  const asset = path.join(vendor, 'gsap.min.js');
  fs.writeFileSync(asset, gsap);
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="./vendor/gsap.min.js"></script>');
  const args = ['scene', 'preview-check', '--frames', '0'];
  expect((await runIn(dir, args)).code).toBe(0);
  expect((await runIn(dir, args)).out).toContain('缓存命中');
  expect(commands(dir)).toHaveLength(2);

  fs.appendFileSync(asset, '\nnew Image().src = "https://example.invalid/pixel";');
  expect((await runIn(dir, args)).code).toBe(0);
  expect((await runIn(dir, args)).out).not.toContain('缓存命中');
  expect(commands(dir)).toHaveLength(6);
});

it('runs fresh previews when the composition uses a remote script', async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>');
  const args = ['scene', 'preview-check', '--frames', '0'];
  const first = await runIn(dir, args);
  const second = await runIn(dir, args);
  expect(first.code, first.out).toBe(0);
  expect(second.code, second.out).toBe(0);
  expect(commands(dir).map(cmd => cmd[0])).toEqual(['check', 'snapshot', 'check', 'snapshot']);
});

it('rejects a stale preview when the composition changes during capture', async () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, '.onset'));
  const marker = path.join(dir, '.onset/change-during-preview');
  fs.writeFileSync(marker, '');
  const args = ['scene', 'preview-check', '--frames', '0'];
  const stale = await runIn(dir, args);
  expect(stale.code).toBe(1);
  expect(stale.out).toContain('预览期间合成源码或资源发生变化');
  expect(fs.existsSync(path.join(dir, '.onset/preview-cache/index.json'))).toBe(false);

  fs.unlinkSync(marker);
  const fresh = await runIn(dir, args);
  expect(fresh.code, fresh.out).toBe(0);
  expect(commands(dir).map(cmd => cmd[0])).toEqual(['check', 'snapshot', 'check', 'snapshot']);
});

it('zoom_frame reuses a cached frame with zero extra snapshot calls and supports cached local crop', async () => {
  const dir = fixture();
  const initial = await runIn(dir, ['scene', 'preview-check', '--frames', '0,15,29']);
  expect(initial.code, initial.out).toBe(0);
  expect(commands(dir).map(cmd => cmd[0])).toEqual(['check', 'snapshot']);

  // 单帧原分辨率放大直接命中上一步缓存，不再调 check 或 snapshot。
  const zoom = await runIn(dir, ['scene', 'preview-check', '--zoom-frame', '15']);
  expect(zoom.code, zoom.out).toBe(0);
  expect(zoom.out).toContain('细节图：');
  expect(zoom.out).toContain('帧 15（原分辨率）');
  expect(zoom.out).toContain('缓存命中：合成检查，1 张截图');
  expect(commands(dir)).toHaveLength(2);

  // 局部裁剪：fixture 里的 PNG 是 2x2，裁 0,0,2,2 验证裁剪与缓存复用。
  const crop1 = await runIn(dir, ['scene', 'preview-check', '--zoom-frame', '15', '--crop', '0,0,2,2']);
  expect(crop1.code, crop1.out).toBe(0);
  expect(crop1.out).toContain('detail-f15-0-0-2-2.png');
  expect(crop1.out).toContain('局部 0,0,2×2');
  expect(commands(dir)).toHaveLength(2);

  const crop2 = await runIn(dir, ['scene', 'preview-check', '--zoom-frame', '15', '--crop', '0,0,2,2']);
  expect(crop2.code, crop2.out).toBe(0);
  expect(crop2.out).toContain('细节图与上次完全相同');
  expect(commands(dir)).toHaveLength(2);
});

it('rejects invalid zoom_frame or crop parameters before running CLI', async () => {
  const dir = fixture();
  const cropAlone = await runIn(dir, ['scene', 'preview-check', '--crop', '0,0,100,100']);
  expect(cropAlone.code).toBe(1);
  expect(cropAlone.out).toContain('crop 需要配合 zoom_frame 使用');

  const outOfRange = await runIn(dir, ['scene', 'preview-check', '--zoom-frame', '30']);
  expect(outOfRange.code).toBe(1);
  expect(outOfRange.out).toContain('0–29');

  const badCrop = await runIn(dir, ['scene', 'preview-check', '--zoom-frame', '0', '--crop', '0,0,999,999']);
  expect(badCrop.code).toBe(1);
  expect(badCrop.out).toContain('超出画布范围');
  expect(fs.existsSync(path.join(dir, '.onset/commands.log'))).toBe(false);
});
