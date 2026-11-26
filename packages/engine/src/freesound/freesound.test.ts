import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeWavPcm16 } from '../baseassets';
import { removeTree } from '../fsutil';
import {
  analyzeWavBuffer,
  audioManifestPath,
  buildSearchFilter,
  computeSafeGain,
  downloadSound,
  type FetchLike,
  FreesoundApiKeyEnv,
  FreesoundApiKeyError,
  readAudioManifest,
  resolveApiKey,
  searchSounds,
} from './index';

const createdDirs: string[] = [];
function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-freesound-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    if (fs.existsSync(dir)) removeTree(dir);
  }
});

/**
 * 构造一条高波峰因数（crest factor）的短促脉冲 WAV：
 * 头部短促正弦爆发达到约 -2.7 dBFS 峰值，后接较长尾音使整段 RMS 落在约 -24 dBFS（建议增益约 +8 dB）。
 */
function synthesizeImpulsiveWav(): Buffer {
  const sampleRate = 48_000;
  const frames = sampleRate; // 1.0s
  const ch = new Float64Array(frames);
  // 前 15ms 突发脉冲：占总能量主力但仅占 1.5% 时长 -> 实测 RMS 约 -24 dBFS（原建议增益 > +8 dB）
  const burstFrames = Math.round(sampleRate * 0.015);
  let maxAbs = 0;
  for (let i = 0; i < burstFrames; i++) {
    const env = Math.sin((Math.PI * i) / (burstFrames - 1));
    const v = env * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    ch[i] = v;
    if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  }
  // 精确将峰值归一化到 -2.7 dBFS，保证实测 sample_peak_db ≈ -2.7 dBFS、safe_gain_db ≤ +1.7 dB
  const targetPeak = 10 ** (-2.7 / 20);
  const scale = maxAbs > 0 ? targetPeak / maxAbs : 1;
  for (let i = 0; i < burstFrames; i++) ch[i] *= scale;
  return encodeWavPcm16([ch], sampleRate);
}

/** 构造一条平稳低幅度正弦 WAV（RMS ≈ -18 dBFS、峰值 ≈ -15 dBFS），不需要峰值夹取。 */
function synthesizeSteadyToneWav(): Buffer {
  const sampleRate = 48_000;
  const frames = Math.round(sampleRate * 0.5);
  const ch = new Float64Array(frames);
  const amp = 10 ** (-15 / 20);
  for (let i = 0; i < frames; i++) {
    ch[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return encodeWavPcm16([ch], sampleRate);
}

describe('freesound API key handling and search filters', () => {
  it('returns clear configuration guidance when FREESOUND_API_KEY is missing', async () => {
    expect(() => resolveApiKey({ env: {} })).toThrow(FreesoundApiKeyError);
    expect(() => resolveApiKey({ env: {} })).toThrow(new RegExp(FreesoundApiKeyEnv));
    expect(() => resolveApiKey({ env: {} })).toThrow(/\.env/);

    await expect(searchSounds({ query: 'whoosh', env: {} })).rejects.toThrow(FreesoundApiKeyError);
  });

  it('builds Freesound search requests with keyword, duration bounds, CC0/CC-BY license filters, and Token header', async () => {
    expect(buildSearchFilter({ minDuration: 0.2, maxDuration: 2.5, license: 'CC0' })).toBe(
      'duration:[0.2 TO 2.5] license:"Creative Commons 0"',
    );
    expect(buildSearchFilter({ license: 'CC0,CC-BY' })).toBe('(license:"Creative Commons 0" OR license:"Attribution")');
    expect(buildSearchFilter({ maxDuration: 3, license: 'CC-BY' })).toBe('duration:[* TO 3] license:"Attribution"');

    let capturedUrl = '';
    let capturedAuth = '';
    const mockFetch: FetchLike = async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(
        JSON.stringify({
          count: 2,
          results: [
            {
              id: 101,
              name: 'Soft Whoosh',
              duration: 0.85,
              username: 'alice',
              license: 'https://creativecommons.org/publicdomain/zero/1.0/',
              url: 'https://freesound.org/people/alice/sounds/101/',
              tags: ['whoosh', 'transition'],
              description: 'Clean transition whoosh',
              type: 'wav',
              filesize: 84000,
              samplerate: 48000,
              channels: 2,
              avg_rating: 4.8,
              num_downloads: 520,
              previews: {
                'preview-hq-mp3': 'https://cdn.freesound.org/previews/0/101_hq.mp3',
              },
            },
            {
              id: 102,
              name: 'Crisp Click',
              duration: 0.35,
              username: 'bob',
              license: 'https://creativecommons.org/licenses/by/4.0/',
              url: 'https://freesound.org/people/bob/sounds/102/',
              tags: ['ui', 'click'],
              description: 'UI click sound',
              type: 'wav',
              filesize: 32000,
              samplerate: 48000,
              channels: 1,
              avg_rating: 4.5,
              num_downloads: 210,
              previews: {
                'preview-hq-mp3': 'https://cdn.freesound.org/previews/0/102_hq.mp3',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const res = await searchSounds({
      query: 'whoosh transition',
      minDuration: 0.2,
      maxDuration: 2,
      license: 'CC0,CC-BY',
      limit: 5,
      env: { [FreesoundApiKeyEnv]: 'test-secret-token' },
      fetch: mockFetch,
    });

    expect(capturedAuth).toBe('Token test-secret-token');
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe('/apiv2/search/text/');
    expect(parsed.searchParams.get('query')).toBe('whoosh transition');
    expect(parsed.searchParams.get('page_size')).toBe('5');
    expect(parsed.searchParams.get('filter')).toBe(
      'duration:[0.2 TO 2] (license:"Creative Commons 0" OR license:"Attribution")',
    );
    expect(res.count).toBe(2);
    expect(res.results.map((r) => r.license_short)).toEqual(['CC0', 'CC-BY']);
  });
});

describe('freesound RMS gain analysis and true-peak clipping guard', () => {
  it('clamps impulsive SFX (suggested +8 dB, peak -2.7 dBFS) to safe_gain_db <= +1.7 dB with warning', () => {
    const analysis = computeSafeGain({
      rms_db: -24.0,
      sample_peak_db: -2.7,
      true_peak_dbtp: -2.7,
    });

    expect(analysis.suggested_gain_db).toBe(8);
    expect(analysis.clamped).toBe(true);
    expect(analysis.safe_gain_db).toBeLessThanOrEqual(1.7);
    expect(analysis.sample_peak_db + analysis.safe_gain_db).toBeLessThanOrEqual(-1.0);
    expect(analysis.true_peak_dbtp + analysis.safe_gain_db).toBeLessThanOrEqual(-1.0);
    expect(analysis.clipping_warning).toBeTruthy();
    expect(analysis.clipping_warning).toContain('削波');
  });

  it('does not clamp moderate-crest audio when peak remains safely below -1.0 dBFS', () => {
    const steady = synthesizeSteadyToneWav();
    const analysis = analyzeWavBuffer(steady);
    expect(analysis.clamped).toBe(false);
    expect(analysis.clipping_warning).toBeUndefined();
    expect(analysis.safe_gain_db).toBe(analysis.suggested_gain_db);
    expect(analysis.sample_peak_db + analysis.safe_gain_db).toBeLessThanOrEqual(-1.0);
  });

  it('downloads impulsive SFX offline, deduplicates by SHA-256, records attribution, and clamps safe_gain_db', async () => {
    const project = makeTempProject();
    const impulsiveWav = synthesizeImpulsiveWav();
    let downloadCalls = 0;

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/sounds/4242/')) {
        return new Response(
          JSON.stringify({
            id: 4242,
            name: 'Sharp Pop Hit',
            duration: 1.0,
            username: 'soundmaker',
            license: 'https://creativecommons.org/licenses/by/4.0/',
            url: 'https://freesound.org/people/soundmaker/sounds/4242/',
            tags: ['pop', 'hit'],
            description: 'Short high-crest transient pop',
            type: 'wav',
            filesize: impulsiveWav.length,
            samplerate: 48000,
            channels: 1,
            avg_rating: 4.9,
            num_downloads: 99,
            previews: {
              'preview-hq-mp3': 'https://cdn.freesound.org/previews/4/4242_hq.wav',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('4242_hq.wav')) {
        downloadCalls++;
        return new Response(new Uint8Array(impulsiveWav), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const first = await downloadSound(4242, project, {
      env: { [FreesoundApiKeyEnv]: 'mock-key' },
      fetch: mockFetch,
    });

    expect(first.deduplicated).toBe(false);
    expect(fs.existsSync(first.file_path)).toBe(true);
    expect(fs.existsSync(audioManifestPath(project))).toBe(true);
    expect(first.entry.author).toBe('soundmaker');
    expect(first.entry.license_short).toBe('CC-BY');
    expect(first.entry.source_url).toBe('https://freesound.org/people/soundmaker/sounds/4242/');
    expect(first.entry.attribution).toContain('soundmaker');
    expect(first.entry.attribution).toContain('CC-BY');

    // 短促高脉冲音效（原建议增益 > +8 dB、样本峰值约 -2.7 dBFS）被自动夹取到 safe_gain_db ≤ +1.7 dB
    const g = first.entry.gain;
    expect(g.measured).toBe(true);
    expect(g.method).toBe('wav-pcm');
    expect(g.suggested_gain_db).toBeGreaterThan(7.5);
    expect(g.sample_peak_db).toBeCloseTo(-2.7, 0);
    expect(g.clamped).toBe(true);
    expect(g.safe_gain_db).toBeLessThanOrEqual(1.7);
    expect(g.sample_peak_db + g.safe_gain_db).toBeLessThanOrEqual(-1.0);
    expect(g.true_peak_dbtp + g.safe_gain_db).toBeLessThanOrEqual(-1.0);
    expect(g.clipping_warning).toBeTruthy();

    // 二次下载相同字节内容命中 SHA-256 去重，不重复落盘
    const second = await downloadSound(4242, project, {
      env: { [FreesoundApiKeyEnv]: 'mock-key' },
      fetch: mockFetch,
    });
    expect(downloadCalls).toBe(2);
    expect(second.deduplicated).toBe(true);
    expect(second.file_path).toBe(first.file_path);

    // 清单中仅登记一条去重后的记录
    const manifest = readAudioManifest(project);
    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].sha256).toBe(first.entry.sha256);
    expect(manifest.entries[0].gain.clamped).toBe(true);

    // 磁盘文件完好但调整 ceilingDb=-6 时，命中去重并按新上限重算增益
    const recomputed = await downloadSound(4242, project, {
      env: { [FreesoundApiKeyEnv]: 'mock-key' },
      fetch: mockFetch,
      ceilingDb: -6,
    });
    expect(recomputed.deduplicated).toBe(true);
    expect(recomputed.entry.gain.ceiling_db).toBe(-6);
    expect(recomputed.entry.gain.sample_peak_db + recomputed.entry.gain.safe_gain_db).toBeLessThanOrEqual(-6);
    expect(readAudioManifest(project).entries[0].gain.ceiling_db).toBe(-6);

    // 磁盘文件被篡改后再次下载应恢复磁盘字节并标记 deduplicated=false
    fs.writeFileSync(first.file_path, Buffer.from('corrupted'));
    const restored = await downloadSound(4242, project, {
      env: { [FreesoundApiKeyEnv]: 'mock-key' },
      fetch: mockFetch,
      ceilingDb: -6,
    });
    expect(restored.deduplicated).toBe(false);
    expect(fs.readFileSync(first.file_path).equals(impulsiveWav)).toBe(true);
  });

  it('rejects oversized streaming downloads, symlink sfx dir, intermediate symlink traversal, and marks unmeasured true peak honestly', async () => {
    const unmeasured = computeSafeGain({
      rms_db: -22,
      sample_peak_db: -4,
      true_peak_dbtp: -4,
      true_peak_measured: false,
    });
    expect(unmeasured.measured).toBe(false);
    expect(unmeasured.true_peak_measured).toBe(false);
    expect(unmeasured.note).toContain('真峰值未能经 EBU R128 实测');

    // 省略 true_peak_dbtp 与 true_peak_measured 时亦不得宣称真峰已测量
    const omittedTp = computeSafeGain({ rms_db: -24, sample_peak_db: -2.7 });
    expect(omittedTp.measured).toBe(false);
    expect(omittedTp.true_peak_measured).toBe(false);
    expect(omittedTp.note).toContain('真峰值未能经 EBU R128 实测');

    const project = makeTempProject();
    let chunksPulled = 0;
    const streamingFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/sounds/9999/')) {
        return new Response(
          JSON.stringify({
            id: 9999,
            name: 'Huge Stream',
            duration: 10,
            username: 'u',
            license: 'https://creativecommons.org/publicdomain/zero/1.0/',
            url: 'https://freesound.org/people/u/sounds/9999/',
            tags: [],
            description: '',
            type: 'wav',
            filesize: 100,
            samplerate: 48000,
            channels: 1,
            avg_rating: 0,
            num_downloads: 0,
            previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/9/9999_hq.wav' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksPulled++;
          controller.enqueue(new Uint8Array(64));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'audio/wav' } });
    };

    await expect(
      downloadSound(9999, project, {
        env: { [FreesoundApiKeyEnv]: 'mock-key' },
        fetch: streamingFetch,
        maxBytes: 128,
      }),
    ).rejects.toThrow(/超过上限/);
    expect(chunksPulled).toBeLessThanOrEqual(4);

    // 符号链接 assets/sfx 目录被拒绝（Windows 使用 junction 无需管理员权限）
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const symProject = makeTempProject();
    const outsideDir = makeTempProject();
    fs.mkdirSync(path.join(symProject, 'assets'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(symProject, 'assets', 'sfx'), linkType);
    const steadyWav = synthesizeSteadyToneWav();
    const steadyFetch: FetchLike = async (input) => {
      if (String(input).includes('/sounds/1234/')) {
        return new Response(
          JSON.stringify({
            id: 1234,
            name: 'Tone',
            duration: 0.5,
            username: 'u',
            license: 'https://creativecommons.org/publicdomain/zero/1.0/',
            url: 'https://freesound.org/people/u/sounds/1234/',
            tags: [],
            description: '',
            type: 'wav',
            filesize: steadyWav.length,
            samplerate: 48000,
            channels: 1,
            avg_rating: 0,
            num_downloads: 0,
            previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/1/1234_hq.wav' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(new Uint8Array(steadyWav), { status: 200, headers: { 'content-type': 'audio/wav' } });
    };
    await expect(
      downloadSound(1234, symProject, {
        env: { [FreesoundApiKeyEnv]: 'mock-key' },
        fetch: steadyFetch,
      }),
    ).rejects.toThrow(/符号链接/);

    // 中间目录符号链接（assets/sfx/link -> outsideDir）不得被去重恢复逻辑覆写项目外文件
    const nestedProject = makeTempProject();
    const victimDir = makeTempProject();
    const victimFile = path.join(victimDir, 'victim.wav');
    fs.writeFileSync(victimFile, 'DO-NOT-OVERWRITE');
    const firstOk = await downloadSound(1234, nestedProject, {
      env: { [FreesoundApiKeyEnv]: 'mock-key' },
      fetch: steadyFetch,
    });
    fs.symlinkSync(victimDir, path.join(nestedProject, 'assets', 'sfx', 'link'), linkType);
    const tampered = readAudioManifest(nestedProject);
    tampered.entries[0].file = 'assets/sfx/link/victim.wav';
    fs.writeFileSync(audioManifestPath(nestedProject), JSON.stringify(tampered, null, 2));
    const reDownloaded = await downloadSound(1234, nestedProject, {
      env: { [FreesoundApiKeyEnv]: 'mock-key' },
      fetch: steadyFetch,
    });
    expect(reDownloaded.deduplicated).toBe(false);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('DO-NOT-OVERWRITE');
    expect(reDownloaded.file_path).toBe(firstOk.file_path);
  });
});
