import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { directoryLink } from '@onset/engine/testsupport/windowsfixtures';
import path from 'node:path';
import { expect, it } from 'vitest';
import { hasFfmpeg, lookPath, runCLI, tempDir } from './testutil';
import { marshalIndent } from '@onset/engine/gojson';
import * as dialogue from '@onset/engine/dialogue';
import { formatFixed } from '@onset/engine/gofmt';

/** runCLI 失败时返回 [输出, 错误]，对应 Go 的 (string, error)。 */
async function tryCLI(root: string, ...args: string[]): Promise<[string, Error | null]> {
  try {
    return [await runCLI(root, ...args), null];
  } catch (err) {
    return ['', err as Error];
  }
}

it('cast new then validate', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const dir = path.join(root, 'cast', 'heiwa');
  for (const name of ['character.yaml', 'rig.svg', 'dna.md', 'character.json']) {
    expect(fs.existsSync(path.join(dir, name)), `骨架缺 ${name}`).toBe(true);
  }
  await runCLI(root, 'cast', 'validate');
});

it('cast new rejects an existing non-empty dir', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const [, err] = await tryCLI(root, 'cast', 'new', 'heiwa');
  expect(err, '期望拒绝覆盖已存在的角色包目录').not.toBeNull();
});

it('cast validate reports a rig problem', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const rig = path.join(root, 'cast', 'heiwa', 'rig.svg');
  const body = fs.readFileSync(rig, 'utf8');
  fs.writeFileSync(rig, body.replace('</svg>', '<animate attributeName="opacity"/></svg>'));
  const [out, err] = await tryCLI(root, 'cast', 'validate');
  expect(err, '期望校验失败').not.toBeNull();
  expect(out + err!.message).toContain('animate');
});

it('cast add rejects an invalid pack and leaves nothing', async () => {
  const root = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'character.yaml'), 'schema: cast/v0\n');
  const [, err] = await tryCLI(root, 'cast', 'add', source);
  expect(err, '期望拒绝不合规的包').not.toBeNull();
  const entries = fs.existsSync(path.join(root, 'cast')) ? fs.readdirSync(path.join(root, 'cast')) : [];
  expect(entries.length, '不合规的包不应落地').toBe(0);
});

it('cast add copies, registers and writes JSON', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  // 把 new 生成的骨架当作“外部角色包”，改个 id 后用 add 引入到另一个项目。
  const source = path.join(root, 'cast', 'heiwa');
  const body = fs.readFileSync(path.join(source, 'character.yaml'), 'utf8');
  fs.writeFileSync(path.join(source, 'character.yaml'), body.replace('id: heiwa', 'id: xiaoming').replace('name: heiwa', 'name: xiaoming'));
  const project = tempDir();
  await runCLI(project, 'cast', 'add', source);
  const dest = path.join(project, 'cast', 'xiaoming');
  for (const name of ['character.yaml', 'rig.svg', 'dna.md', 'character.json']) {
    expect(fs.existsSync(path.join(dest, name)), `拷贝后缺 ${name}`).toBe(true);
  }
  const roster = fs.readFileSync(path.join(project, 'cast.yaml'), 'utf8');
  expect(roster).toContain('cast/xiaoming');
  expect(roster).toContain('ground_y');
});

it('cast add rejects a symlink in the source', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const source = path.join(root, 'cast', 'heiwa');
  const outside = path.join(tempDir(), 'outside.txt');
  fs.writeFileSync(outside, 'x');
  if (process.platform === 'win32') directoryLink(path.dirname(outside), path.join(source, 'evil-link'));
  else fs.symlinkSync(outside, path.join(source, 'evil-link'));
  const project = tempDir();
  const [, err] = await tryCLI(project, 'cast', 'add', source);
  expect(err, '期望拒绝含符号链接的源目录').not.toBeNull();
  const entries = fs.existsSync(path.join(project, 'cast')) ? fs.readdirSync(path.join(project, 'cast')) : [];
  expect(entries.length, '拒绝符号链接后不应留下任何文件').toBe(0);
});

it('cast validate with explicit args', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  await runCLI(root, 'cast', 'validate', path.join('cast', 'heiwa'));
});

it('cast validate without roster or cast dir succeeds', async () => {
  await runCLI(tempDir(), 'cast', 'validate');
});

// onset cast validate 顺带提醒音色缺口：通过但带提醒，真正的硬校验在 onset validate cast。
it('cast validate warns about a missing voice with an explicit provider', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const out = await runCLI(root, 'cast', 'validate', '--provider', 'minimax');
  expect(out).toContain('缺少 voiceId');
  expect(out).toContain('validate_cast()');
});

// 解析不出完整项目配置时安静跳过音色检查。
it('cast validate is silent on voices when the provider is unresolvable', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const out = await runCLI(root, 'cast', 'validate');
  expect(out).not.toContain('voiceId');
});

// 不传 --provider 时按 config_get TTS_PROVIDER 的规则解析（缺省按平台：Apple Silicon 是 breeze，其余 minimax；骨架两家都有空的 voiceId）。
it('cast validate resolves the default provider from config', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
  const out = await runCLI(root, 'cast', 'validate');
  expect(out).toContain('缺少 voiceId');
});

it('cast preview generates a contact sheet', async (ctx) => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const [out, err] = await tryCLI(root, 'cast', 'preview', path.join('cast', 'heiwa'));
  if (err) {
    if (err.message.includes('rsvg-convert') || err.message.includes('magick')) ctx.skip();
    throw err;
  }
  expect(out).toContain('cast-preview');
});

/** 三视图角色包夹具：默认视图 front，加 three-quarter、side 两个。 */
function writeMultiViewCastPack(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const yamlBody = `schema: cast/v1
id: heiwa
name: 黑娃
summary: 多视图预览的 CLI 测试夹具
voice:
  minimax: { voiceId: "v-1", speed: 0.98, pitch: 0 }
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head:     { pivot: [200, 168], rotate: [-18, 18] }
    frontLeg: { pivot: [176, 330], rotate: [-40, 55] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
  pointing: { frontLeg: 48, head: -6 }
views:
  three-quarter:
    file: rig-tq.svg
    viewBox: [0, 0, 400, 520]
    baselineY: 512
    joints:
      head:     { pivot: [186, 170], rotate: [-22, 22] }
      frontLeg: { pivot: [168, 332], rotate: [-40, 55] }
  side:
    file: rig-side.svg
    viewBox: [0, 0, 400, 520]
    baselineY: 512
    joints:
      head:     { pivot: [172, 174], rotate: [-26, 26] }
      frontLeg: { pivot: [160, 334], rotate: [-45, 60] }
turns:
  front->side: { via: [three-quarter], durationMs: 200 }
`;
  fs.writeFileSync(path.join(dir, 'character.yaml'), yamlBody);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520">
  <g id="j-head"><circle cx="200" cy="168" r="60" fill="#fff" stroke="#000" stroke-width="6"/></g>
  <g id="j-frontLeg"><path d="M176 330 L176 420" stroke="#000" stroke-width="6"/></g>
</svg>`;
  for (const name of ['rig.svg', 'rig-tq.svg', 'rig-side.svg']) fs.writeFileSync(path.join(dir, name), svg);
}

// onset cast preview 的逐视图打印：每个视图各占一行，且这一行同时含视图名与它自己的 contact sheet 文件名。
it.skipIf(lookPath('rsvg-convert') === '' || lookPath('magick') === '')('cast preview prints every view', async () => {
  const root = tempDir();
  writeMultiViewCastPack(path.join(root, 'cast', 'heiwa'));
  const out = await runCLI(root, 'cast', 'preview', path.join('cast', 'heiwa'));
  const lines = out.trim().split('\n');
  expect(lines.length, `输出应恰好 3 行：${out}`).toBe(3);
  for (const view of ['front', 'three-quarter', 'side']) {
    const wantSheet = `heiwa-${view}-contact-sheet.png`;
    expect(
      lines.some((line) => line.includes('视图 ' + view + '）') && line.includes(wantSheet)),
      `输出缺视图 ${view} 对应的一行：${out}`,
    ).toBe(true);
  }
});

// 缺 plan.json 时失败，失败信息里能看到 plan 字样——原样透出 dialogue.assemble 的错误。
it('dialogue assemble requires a plan', async () => {
  const [out, err] = await tryCLI(tempDir(), 'dialogue', 'assemble');
  expect(err, '缺 plan.json 时应失败').not.toBeNull();
  expect(out + err!.message).toContain('plan');
});

function dialogueTone(file: string, seconds: number): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${formatFixed(seconds, 3)}`, '-ar', '22050', '-ac', '2', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`生成测试音频失败：${r.stderr}`);
}

it.skipIf(!hasFfmpeg)('dialogue assemble end to end', async () => {
  const root = tempDir();
  const audioDir = path.join(root, 'production', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  dialogueTone(path.join(audioDir, 'seg-001-heiwa.wav'), 1.0);
  dialogueTone(path.join(audioDir, 'seg-002-zhaocai.wav'), 0.5);
  const plan: dialogue.Plan = {
    schema: dialogue.SchemaVersion,
    segments: [
      { index: 1, speaker: 'heiwa', voiceId: 'v-1', audio: 'production/audio/seg-001-heiwa.wav', gapAfterMs: 200, lines: [{ text: '第一句', startSeconds: 0, endSeconds: 1.0 }] },
      { index: 2, speaker: 'zhaocai', voiceId: 'v-2', audio: 'production/audio/seg-002-zhaocai.wav', gapAfterMs: 0, lines: [{ text: '等一下', startSeconds: 0, endSeconds: 0.5 }] },
    ],
  };
  fs.writeFileSync(path.join(audioDir, 'plan.json'), marshalIndent(dialogue.planToJSON(plan)));
  const out = await runCLI(root, 'dialogue', 'assemble');
  for (const rel of ['production/audio/voice.wav', 'transcription-production.srt', 'production/dialogue.json']) {
    expect(fs.existsSync(path.join(root, rel)), `缺产物 ${rel}`).toBe(true);
    expect(out, `输出未提到产物路径 ${rel}`).toContain(process.platform === 'win32' ? rel.replaceAll('/', '\\') : rel);
  }
  expect(out.includes('1.7') || out.includes('1.700'), `输出应提到总时长（约 1.7 秒）：${out}`).toBe(true);
});

// new 必须自己登记进班底。
it('cast new registers into the roster', async () => {
  const root = tempDir();
  await runCLI(root, 'cast', 'new', 'heiwa');
  const roster = fs.readFileSync(path.join(root, 'cast.yaml'), 'utf8');
  expect(roster).toContain('cast/heiwa');
  expect(roster).toContain('ground_y');
});

// onset init --narration cast 的真实起点：cast.yaml 已存在且 packs 为空列表；new 追加而不是重建。
it('cast new appends to an existing roster', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'cast.yaml'), 'schema: cast/v1\npacks: []\ndefaults:\n    ground_y: 0.66\n    gap_ms:\n        turn: 240\n        interject: 100\n');
  for (const id of ['heiwa', 'zhaocai']) await runCLI(root, 'cast', 'new', id);
  const roster = fs.readFileSync(path.join(root, 'cast.yaml'), 'utf8');
  for (const want of ['cast/heiwa', 'cast/zhaocai']) expect(roster).toContain(want);
  // 已有 defaults 必须原样保留，不能被新建时的约定默认值覆盖。
  expect(roster).toContain('0.66');
});

// 验收：new 之后项目级 onset validate cast 不再报「班底为空」。
it('cast new leaves no empty-roster complaint', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'cast.yaml'), 'schema: cast/v1\npacks: []\ndefaults:\n    ground_y: 0.78\n    gap_ms:\n        turn: 240\n        interject: 100\n');
  // onset validate cast 先解析项目配置，配置不全会在走到班底检查之前就退出。
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
  await runCLI(root, 'cast', 'new', 'heiwa');
  const [out, err] = await tryCLI(root, 'validate', 'cast');
  expect(out + (err?.message ?? '')).not.toContain('班底为空');
});
