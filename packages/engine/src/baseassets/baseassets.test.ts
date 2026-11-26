import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTree } from '../fsutil';
import { newToolchain } from '../mediaprobe';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import {
  BaseSfxBitDepth,
  BaseSfxChannels,
  BaseSfxMaxTruePeakDB,
  BaseSfxSampleRate,
  type BuiltinAssetsManifest,
  BuiltinAssetsRelDir,
  BuiltinLicense,
  BuiltinManifestFile,
  generateBaseAssets,
  measurePcm16Metrics,
} from './index';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const createdDirs: string[] = [];
function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-baseassets-'));
  createdDirs.push(dir);
  return dir;
}

const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    if (fs.existsSync(dir)) removeTree(dir);
  }
});

describe('baseassets procedural generation', () => {
  it('generates all 3 SVG textures and 2 WAV SFX deterministically with identical SHA-256 across runs', () => {
    const dirA = makeTempProject();
    const dirB = makeTempProject();

    const resA = generateBaseAssets(dirA);
    const resB = generateBaseAssets(dirB);

    expect(resA.license).toBe(BuiltinLicense);
    expect(resA.created_count).toBe(5);
    expect(resA.unchanged_count).toBe(0);
    expect(resA.preserved_count).toBe(0);
    expect(resA.assets.map((a) => a.id)).toEqual(['grain', 'grid', 'impact', 'paper', 'whoosh']);

    const expectedFiles = ['paper.svg', 'grain.svg', 'grid.svg', 'whoosh.wav', 'impact.wav', BuiltinManifestFile];
    for (const fileName of expectedFiles) {
      const fileA = path.join(dirA, BuiltinAssetsRelDir, fileName);
      const fileB = path.join(dirB, BuiltinAssetsRelDir, fileName);
      expect(fs.existsSync(fileA), `缺少 ${fileName}`).toBe(true);
      expect(fs.existsSync(fileB), `缺少 ${fileName}`).toBe(true);
      expect(sha256(fileA), `${fileName} 两次生成 SHA-256 必须逐字节一致`).toBe(sha256(fileB));
    }

    // SVG 内容校验：有效 SVG 根节点且无危险脚本
    for (const svgName of ['paper.svg', 'grain.svg', 'grid.svg']) {
      const text = fs.readFileSync(path.join(dirA, BuiltinAssetsRelDir, svgName), 'utf8');
      expect(text).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(text).toContain('</svg>');
      expect(text.toLowerCase()).not.toContain('<script');
    }

    // 清单元数据校验
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dirA, BuiltinAssetsRelDir, BuiltinManifestFile), 'utf8'),
    ) as BuiltinAssetsManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.license).toBe('MIT');
    expect(manifest.assets).toHaveLength(5);
    for (const entry of manifest.assets) {
      expect(entry.license).toBe('MIT');
      expect(entry.user_modified).toBe(false);
      expect(entry.sha256).toBe(sha256(path.join(dirA, entry.file)));
    }
    expect(resA.assets.map((a) => a.sha256)).toEqual(resB.assets.map((a) => a.sha256));
  });

  it('produces valid 48kHz 16-bit stereo WAV headers with zero DC offset, zero boundary clicks, and peak <= -1.0 dBFS/dBTP', () => {
    const dir = makeTempProject();
    generateBaseAssets(dir);

    for (const wavName of ['whoosh.wav', 'impact.wav']) {
      const abs = path.join(dir, BuiltinAssetsRelDir, wavName);
      const buf = fs.readFileSync(abs);

      // 校验标准 44 字节 PCM WAV 头
      expect(buf.length).toBeGreaterThan(44);
      expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
      expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(buf.subarray(12, 16).toString('ascii')).toBe('fmt ');
      expect(buf.readUInt32LE(16)).toBe(16);
      expect(buf.readUInt16LE(20)).toBe(1); // Linear PCM
      expect(buf.readUInt16LE(22)).toBe(BaseSfxChannels);
      expect(buf.readUInt32LE(24)).toBe(BaseSfxSampleRate);
      expect(buf.readUInt16LE(34)).toBe(BaseSfxBitDepth);
      expect(buf.subarray(36, 40).toString('ascii')).toBe('data');
      const dataBytes = buf.readUInt32LE(40);
      expect(dataBytes).toBe(buf.length - 44);
      expect(dataBytes % (BaseSfxChannels * 2)).toBe(0);

      // 首末帧归零（淡入淡出无爆音）
      expect(buf.readInt16LE(44)).toBe(0);
      expect(buf.readInt16LE(46)).toBe(0);
      expect(buf.readInt16LE(buf.length - 4)).toBe(0);
      expect(buf.readInt16LE(buf.length - 2)).toBe(0);

      // 实测 RMS / 样本峰值 / 真峰值 / 直流偏移
      const metrics = measurePcm16Metrics(buf);
      expect(metrics.sample_rate).toBe(BaseSfxSampleRate);
      expect(metrics.channels).toBe(BaseSfxChannels);
      expect(metrics.bit_depth).toBe(BaseSfxBitDepth);
      expect(metrics.duration_seconds).toBeGreaterThan(0.5);
      expect(metrics.dc_offset).toBeLessThan(0.005);
      expect(metrics.sample_peak_db).toBeLessThanOrEqual(BaseSfxMaxTruePeakDB);
      expect(metrics.true_peak_dbtp).toBeLessThanOrEqual(BaseSfxMaxTruePeakDB);
      expect(metrics.rms_db).toBeGreaterThan(-40);

      // 本机有 ffmpeg 时额外用 ITU-R BS.1770 loudnorm 交叉验证真峰值 ≤ -1.0 dBTP
      if (hasFfmpeg) {
        const tc = newToolchain(process.env as Record<string, string>);
        const loud = tc.measureProgramLoudness(abs);
        expect(loud.true_peak_dbtp, `${wavName} loudnorm 真峰值应 ≤ -1.0 dBTP`).toBeLessThanOrEqual(
          BaseSfxMaxTruePeakDB,
        );
      }
    }
  });

  it('never overwrites user-modified files unless force is true', () => {
    const dir = makeTempProject();
    const first = generateBaseAssets(dir);
    expect(first.created_count).toBe(5);

    // 二次运行全部保持 unchanged
    const second = generateBaseAssets(dir);
    expect(second.created_count).toBe(0);
    expect(second.unchanged_count).toBe(5);
    expect(second.preserved_count).toBe(0);

    // 用户手动修改 paper.svg 与 whoosh.wav
    const customPaper = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#123456"/></svg>\n';
    const customWhoosh = Buffer.from('user-custom-sfx-content');
    const paperPath = path.join(dir, BuiltinAssetsRelDir, 'paper.svg');
    const whooshPath = path.join(dir, BuiltinAssetsRelDir, 'whoosh.wav');
    fs.writeFileSync(paperPath, customPaper, 'utf8');
    fs.writeFileSync(whooshPath, customWhoosh);

    const third = generateBaseAssets(dir);
    expect(third.preserved_count).toBe(2);
    expect(third.unchanged_count).toBe(3);
    expect(fs.readFileSync(paperPath, 'utf8')).toBe(customPaper);
    expect(fs.readFileSync(whooshPath).equals(customWhoosh)).toBe(true);

    const paperEntry = third.assets.find((a) => a.id === 'paper')!;
    expect(paperEntry.status).toBe('preserved');
    expect(paperEntry.user_modified).toBe(true);

    // 显式 force: true 才恢复内置版本
    const forced = generateBaseAssets(dir, { force: true });
    expect(forced.overwritten_count).toBe(2);
    expect(fs.readFileSync(paperPath, 'utf8')).toContain('Warm Paper (MIT)');
  });

  it('wires thinly into projectinit.create by default and honors includeBaseAssets: false', () => {
    const dirWith = makeTempProject();
    projectinit.create({
      target: dirWith,
      canvas: preset.defaultPreset().id,
      delivery: projectinit.DeliverySpeech,
      narration: projectinit.NarrationSolo,
    });
    expect(fs.existsSync(path.join(dirWith, BuiltinAssetsRelDir, BuiltinManifestFile))).toBe(true);
    expect(fs.existsSync(path.join(dirWith, BuiltinAssetsRelDir, 'whoosh.wav'))).toBe(true);

    const dirWithout = makeTempProject();
    projectinit.create({
      target: dirWithout,
      canvas: preset.defaultPreset().id,
      delivery: projectinit.DeliverySpeech,
      narration: projectinit.NarrationSolo,
      includeBaseAssets: false,
    });
    expect(fs.existsSync(path.join(dirWithout, BuiltinAssetsRelDir, BuiltinManifestFile))).toBe(false);
  });

  it('parses WAV with intermediate odd-sized JUNK chunk in measurePcm16Metrics', () => {
    const dir = makeTempProject();
    generateBaseAssets(dir);
    const baseWav = fs.readFileSync(path.join(dir, BuiltinAssetsRelDir, 'whoosh.wav'));
    const fmtChunk = baseWav.subarray(12, 36);
    const dataChunk = baseWav.subarray(36);
    // 插入奇数长度 JUNK 块（5 字节 + 1 字节偶对齐补零）
    const junkHeader = Buffer.alloc(8);
    junkHeader.write('JUNK', 0, 'ascii');
    junkHeader.writeUInt32LE(5, 4);
    const junkBody = Buffer.from([1, 2, 3, 4, 5, 0]);
    const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, junkHeader, junkBody, dataChunk]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    const withJunk = Buffer.concat([riff, body]);

    const expected = measurePcm16Metrics(baseWav);
    const actual = measurePcm16Metrics(withJunk);
    expect(actual).toEqual(expected);
  });
});
