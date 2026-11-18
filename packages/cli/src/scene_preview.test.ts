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
fs.appendFileSync('commands.log', JSON.stringify(args) + '\\n');
if (args[0] === 'check') {
  if (fs.existsSync('bad-composition')) { console.error('layout failed'); process.exit(1); }
  console.log(JSON.stringify({ ok: true }));
} else {
  const dir = args[args.indexOf('--output') + 1];
  const sheet = path.resolve(dir, 'contact-sheet.jpg');
  const frames = args[args.indexOf('--at') + 1].split(',').map((time, i) => {
    const file = path.resolve(dir, 'frame-' + i + '.png');
    fs.writeFileSync(file, 'frame');
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
  const [check, snapshot] = fs.readFileSync(path.join(dir, 'commands.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(check.slice(0, 2)).toEqual(['check', '--json']);
  expect(snapshot).toEqual(expect.arrayContaining(['snapshot', '--no-end', '--describe', 'false', '--at', '0.000000,0.400000,0.966667']));
  expect(fs.existsSync(path.join(dir, 'one.mp4'))).toBe(false);
});

it('validates frame bounds before starting and leaves the check error without taking screenshots', async () => {
  const dir = fixture();
  const invalid = await runIn(dir, ['scene', 'preview-check', '--frames', '30']);
  expect(invalid.code).toBe(1);
  expect(invalid.out).toContain('0–29');
  expect(fs.existsSync(path.join(dir, 'commands.log'))).toBe(false);
  fs.writeFileSync(path.join(dir, 'bad-composition'), '');
  const failure = await runIn(dir, ['scene', 'preview-check']);
  expect(failure.code).toBe(1);
  expect(failure.out).toContain('layout failed');
  expect(fs.readFileSync(path.join(dir, 'commands.log'), 'utf8')).not.toContain('snapshot');
});
