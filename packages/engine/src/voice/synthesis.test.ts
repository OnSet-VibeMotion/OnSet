import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesize } from './synthesis';
import { runVoice } from './runner';
import { modelReady } from '../toolinstall';

vi.mock('./runner', () => ({ runVoice: vi.fn() }));
vi.mock('./design', () => ({ designStatus: () => ({ ready: true }) }));
vi.mock('../toolinstall', () => ({ modelReady: vi.fn(() => true), modelDir: () => '/prepared/model' }));
vi.mock('../mediaprobe', () => ({ newToolchain: () => ({
  transcode: async (file: string) => fs.writeFileSync(file, 'converted audio'),
  probe: () => ({ duration_seconds: 1, audio: { sample_rate: 48000, channels: 2 } }),
}) }));
let root: string;
const calls = vi.mocked(runVoice);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-synthesis-'));
  calls.mockReset();
  vi.mocked(modelReady).mockReturnValue(true);
  calls.mockImplementation(async (_command, args) => {
    const flag = (key: string) => args[args.indexOf(key) + 1];
    if (args.includes('--output_path')) fs.writeFileSync(path.join(flag('--output_path'), 'take.wav'), 'raw');
    if (args.includes('--out')) fs.writeFileSync(flag('--out'), 'raw');
    if (args.includes('--write-media')) fs.writeFileSync(flag('--write-media'), 'raw');
    if (args.includes('TextToVoice')) return JSON.stringify({ Audio: Buffer.from('raw').toString('base64'), Subtitles: [] });
    if (args.includes('convert_with_timestamps')) return JSON.stringify({ audio_base64: Buffer.from('raw').toString('base64'), alignment: { characters: ['你'], character_start_times_seconds: [0], character_end_times_seconds: [1] } });
    return '{}';
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const options = (provider: string) => ({ provider, text: '你好。', voice: provider === 'tencent' ? '101001' : 'speaker', output: path.join(root, 'voice.wav'), env: {} });

describe('managed speech synthesis', () => {
  it.each(['minimax', 'bailian', 'edge', 'elevenlabs', 'tencent', 'mlx'])('runs %s through the managed runner and publishes WAV with source evidence', async (provider) => {
    const result = await synthesize(options(provider));
    expect(fs.readFileSync(result.audio, 'utf8')).toBe('converted audio');
    expect(fs.existsSync(result.report)).toBe(true);
    expect(result.duration_seconds).toBe(1);
    expect(calls).toHaveBeenCalled();
  });

  it('loads the default Breeze reference itself and keeps the transcript byte for byte', async () => {
    const library = path.join(root, 'voices');
    fs.mkdirSync(path.join(library, '老周'), { recursive: true });
    fs.writeFileSync(path.join(library, 'library.json'), '{"default":"老周"}');
    fs.writeFileSync(path.join(library, '老周', 'voice.json'), JSON.stringify({ name: '老周', text: '原样的参考稿。', source: 'recorded' }));
    fs.writeFileSync(path.join(library, '老周', 'reference.wav'), 'reference');
    await synthesize({ ...options('breeze'), voice: '', instruction: '平静、真诚', env: { ONSET_VOICES_DIR: library } });
    const args = calls.mock.calls[0][1];
    expect(args).toContain('原样的参考稿。');
    expect(args).toContain(path.join(library, '老周', 'reference.wav'));
    expect(args).toContain('平静、真诚');
    expect(args).not.toContain('mlx-community/Breeze-TTS-2-mlx-8bit');
  });

  it('splits Tencent at its request limit without losing any text', async () => {
    const text = '这是长文。'.repeat(80);
    await synthesize({ ...options('tencent'), voice: '101001', text });
    const parts = calls.mock.calls.map(([, args]) => args[args.indexOf('--Text') + 1]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    expect(parts.every((part) => [...part].length <= 150)).toBe(true);
  });

  it('keeps shell metacharacters as literal text and translates Edge rate', async () => {
    const text = '原样 $(touch nope) `command` "quoted"\n下一行';
    await synthesize({ ...options('edge'), text, speed: 0.98 });
    const args = calls.mock.calls[0][1];
    expect(args).toContain('--rate=-2%');
    expect(fs.readFileSync(path.join(root, 'voice.tts', 'text.txt'), 'utf8')).toBe(text);
  });

  it('rejects unsupported options and empty text before starting a provider', async () => {
    await expect(synthesize({ ...options('edge'), instruction: '平静' })).rejects.toThrow('instruction');
    await expect(synthesize({ ...options('minimax'), text: '  ' })).rejects.toThrow('文稿');
    await expect(synthesize({ ...options('mlx'), speed: NaN })).rejects.toThrow('speed');
    expect(calls).not.toHaveBeenCalled();
  });

  it('requires the prepared local MLX model without starting a download', async () => {
    vi.mocked(modelReady).mockReturnValue(false);
    await expect(synthesize(options('mlx'))).rejects.toThrow('工具准备页');
    expect(calls).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('normalizes real character timestamps and rejects malformed provider responses', async () => {
    const result = await synthesize(options('elevenlabs'));
    expect(JSON.parse(fs.readFileSync(result.alignment!, 'utf8'))).toEqual([{ text: '你', start: 0, end: 1 }]);
    calls.mockResolvedValueOnce('{"audio_base64":"cmF3","alignment":{"characters":["你"]}}');
    const output = path.join(root, 'bad.wav');
    await expect(synthesize({ ...options('elevenlabs'), output })).rejects.toThrow('字级时间戳');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('allows only one synthesis per output, including during conversion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const normal = calls.getMockImplementation()!;
    calls.mockImplementation(async (...args) => { await gate; return normal(...args); });
    const first = synthesize(options('edge'));
    await expect(synthesize(options('edge'))).rejects.toThrow('正在生成');
    release();
    await first;
    expect(fs.existsSync(path.join(root, 'voice.tts.lock'))).toBe(false);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('splits multi-paragraph and chapter text with default 650ms / 1300ms pauses and offsets character timestamps', async () => {
    const result = await synthesize({ ...options('elevenlabs'), text: '第一段。\n第二段。\n\n第三段。' });
    expect(calls).toHaveBeenCalledTimes(3);
    const report = JSON.parse(fs.readFileSync(result.report, 'utf8'));
    expect(report.paragraph_pause_ms).toBe(650);
    expect(report.chapter_pause_ms).toBe(1300);
    expect(report.segments.map((s: { start_seconds: number; pause_after_ms?: number }) => [s.start_seconds, s.pause_after_ms ?? 0])).toEqual([
      [0, 650],
      [1.65, 1300],
      [3.95, 0],
    ]);
    const concat = fs.readFileSync(path.join(result.sources, 'concat.txt'), 'utf8');
    expect(concat).toBe("file '001/audio.wav'\nfile 'pause-650ms.wav'\nfile '002/audio.wav'\nfile 'pause-1300ms.wav'\nfile '003/audio.wav'\n");
    const alignment = JSON.parse(fs.readFileSync(result.alignment!, 'utf8')) as { text: string; start: number; end: number }[];
    expect(alignment.map((item) => [item.start, item.end])).toEqual([
      [0, 1],
      [1.65, 2.65],
      [3.95, 4.95],
    ]);
  });

  it('skips paragraph splitting when paragraphPauseMs is 0 or ssml is enabled, and rejects invalid pause values', async () => {
    await synthesize({ ...options('edge'), text: '第一段。\n第二段。\n\n第三段。', paragraphPauseMs: 0 });
    expect(calls).toHaveBeenCalledTimes(1);
    calls.mockClear();
    await synthesize({ ...options('bailian'), output: path.join(root, 'ssml.wav'), text: '<speak>\n第一段。\n第二段。\n</speak>', ssml: true });
    expect(calls).toHaveBeenCalledTimes(1);
    await expect(synthesize({ ...options('edge'), output: path.join(root, 'bad-pause.wav'), paragraphPauseMs: -10 })).rejects.toThrow('paragraph_pause_ms');
    await expect(synthesize({ ...options('edge'), output: path.join(root, 'bad-pause2.wav'), paragraphPauseMs: 5000 })).rejects.toThrow('paragraph_pause_ms');
    await expect(synthesize({ ...options('edge'), output: path.join(root, 'bad-chapter.wav'), chapterPauseMs: 6000 })).rejects.toThrow('chapter_pause_ms');
  });

  it('preserves existing takes and leaves no final output on failure or cancellation', async () => {
    fs.writeFileSync(options('edge').output, 'approved');
    await expect(synthesize(options('edge'))).rejects.toThrow('已存在');
    expect(fs.readFileSync(options('edge').output, 'utf8')).toBe('approved');
    fs.unlinkSync(options('edge').output);
    calls.mockRejectedValueOnce(new Error('provider failed'));
    await expect(synthesize(options('edge'))).rejects.toThrow('provider failed');
    expect(fs.existsSync(options('edge').output)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(synthesize({ ...options('edge'), signal: controller.signal })).rejects.toThrow();
    expect(fs.existsSync(options('edge').output)).toBe(false);
  });
});
