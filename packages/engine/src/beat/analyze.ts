// 移植自 internal/beat/analyze.go。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { lookPath } from '../envutil';
import { goTrimSpace } from '../gofmt';
import { sliceOf, type StructType } from './jsondecode';
import { checkTrack, normalizeGrid, saveDraft, type Grid } from './grid';
import { envDir, requireEnv } from './env';
import { AnalysisFile, AnalyzerVersion, ClickFile, ConfigFile, Store, loadConfig, localPath, readJSON, wrapError, type Config } from './store';
import { loadTrack, trackAudioPath, type Track } from './track';

/** analysisSampleRate 是 beat-this 内部使用的采样率；按它解码可省掉一次重采样。 */
const analysisSampleRate = 22050;

/**
 * analyzeScript 读单声道 16 位 WAV，把普通拍与重拍写进 argv[3] 指向的 JSON。
 *
 * 结果写文件而不是打印到 stdout：首次运行会下载模型权重，下载进度与库的日志
 * 会混进标准输出，按 stdout 解析时结果就丢了。argv[2] 为 "--doctor" 时只加载
 * 模型，用来提前下载权重。
 */
export const analyzeScript = `import importlib.metadata as m, json, sys, wave
v = m.version('beat-this')
if v != '${AnalyzerVersion}':
    sys.exit('beat-this ' + v + ' != ${AnalyzerVersion}')
import numpy as np
from beat_this.inference import Audio2Beats
if sys.argv[1] == '--doctor':
    Audio2Beats(checkpoint_path=sys.argv[2], device='cpu', dbn=False)
    sys.exit(0)
with wave.open(sys.argv[1], 'rb') as w:
    if w.getnchannels() != 1 or w.getsampwidth() != 2:
        sys.exit('analysis wav must be mono 16-bit')
    sr = w.getframerate()
    signal = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float32) / 32768
beats, downbeats = Audio2Beats(checkpoint_path=sys.argv[2], device='cpu', dbn=False)(signal, sr)
with open(sys.argv[3], 'w') as f:
    json.dump({'beats': [float(b) for b in beats], 'downbeats': [float(d) for d in downbeats]}, f)
`;

/** Media 是分析与试听用到的媒体操作；mediaprobe.Toolchain 满足它。 */
export interface Media {
  decodeAnalysisWAV(source: string, dest: string, sampleRate: number, signal?: AbortSignal): Promise<void>;
  clickTrack(music: string, dest: string, beats: number[], downbeats: number[], signal?: AbortSignal): Promise<void>;
}

/** 接收进度文字的地方（对应 io.Writer）。process.stdout 可以直接传。 */
export interface Writer {
  write(chunk: string): unknown;
}

const rawType: StructType = {
  kind: 'struct',
  goName: 'struct { Beats []float64 "json:\\"beats\\""; Downbeats []float64 "json:\\"downbeats\\"" }',
  name: '',
  fields: [
    ['beats', sliceOf('float')],
    ['downbeats', sliceOf('float')],
  ],
};

/**
 * Analyze 分析已导入音乐的节拍，写出草稿网格与试听轨。
 *
 * 草稿永远不直接生效：模型会把重拍整体错位或判错拍号，只有人听过试听轨
 * 才知道，所以必须再经 am beat confirm。
 */
export async function analyze(root: string, env: Record<string, string>, media: Media, out: Writer, signal?: AbortSignal): Promise<Grid> {
  const config = loadConfig(root);
  let track: Track;
  try {
    track = loadTrack(root);
  } catch (err) {
    throw wrapError(`先用 beat_import() 导入音乐：${(err as Error).message}`, err);
  }
  const music = trackAudioPath(track, root);
  const wav = localPath(root, AnalysisFile);
  await media.decodeAnalysisWAV(music, wav, analysisSampleRate, signal);
  const result = localPath(root, Store + '/analysis.json');
  fs.rmSync(result, { force: true });
  out.write(`正在用 beat-this ${AnalyzerVersion}（${config.checkpoint}）分析节拍\n`);
  await runPython(config, env, [wav, config.checkpoint, result], signal);
  const raw = readJSON<{ beats: number[] | null; downbeats: number[] | null }>(result, rawType);
  const grid = normalizeGrid({
    schema: 1,
    audio_sha256: track.audio_sha256,
    duration_seconds: track.duration_seconds,
    source: `beat-this/${AnalyzerVersion} ${config.checkpoint}`,
    reviewed: false,
    beats: within(raw.beats ?? [], track.duration_seconds),
    downbeats: within(raw.downbeats ?? [], track.duration_seconds),
  });
  await writeDraftAndClick(root, grid, media, signal);
  return grid;
}

/**
 * within 丢掉落在音乐时长之外的拍点。模型按 20 ms 一帧输出，最后一拍可能
 * 正好落在结尾之后。
 */
function within(values: number[], duration: number): number[] {
  return values.filter((v) => v >= 0 && v < duration);
}

/** WriteDraftAndClick 写出草稿网格，并按它重新生成试听轨。 */
export async function writeDraftAndClick(root: string, g: Grid, media: Media, signal?: AbortSignal): Promise<void> {
  const track = loadTrack(root);
  checkTrack(g, track);
  saveDraft(root, g);
  await writeClick(root, g, media, signal);
}

/** WriteClick 按给定网格生成试听轨。 */
export async function writeClick(root: string, g: Grid, media: Media, signal?: AbortSignal): Promise<void> {
  const track = loadTrack(root);
  checkTrack(g, track);
  const music = trackAudioPath(track, root);
  const click = localPath(root, ClickFile);
  await media.clickTrack(music, click, g.beats ?? [], g.downbeats ?? [], signal);
}

/** Doctor 检查 Python 环境与固定版本，并预先下载模型权重。 */
export async function doctor(root: string, env: Record<string, string>, out: Writer, signal?: AbortSignal): Promise<void> {
  const config = loadConfig(root);
  out.write(`检查 ${pythonFor(config, env)} 中的 beat-this ${AnalyzerVersion}，首次运行会下载 ${config.checkpoint} 权重\n`);
  await runPython(config, env, ['--doctor', config.checkpoint], signal);
  out.write('节拍分析环境可用\n');
}

async function runPython(config: Config, env: Record<string, string>, args: string[], signal?: AbortSignal): Promise<void> {
  const binary = pythonFor(config, env);
  const { ok, stderr } = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, stderr: '' });
      return;
    }
    const child = spawn(binary, ['-c', analyzeScript, ...args], { env, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    let settled = false;
    const settle = (value: { ok: boolean; stderr: string }) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on('error', () => {
      if (child.pid === undefined) settle({ ok: false, stderr: Buffer.concat(chunks).toString('utf8') });
    });
    child.on('close', (status) => settle({ ok: status === 0, stderr: Buffer.concat(chunks).toString('utf8') }));
  });
  if (!ok) {
    const hint = config.python === '' ? `共享环境可能损坏，删掉 ${envDir(env)} 后在工具准备页重新安装「音乐卡点」` : `确认 ${config.python} 装有 beat-this==${AnalyzerVersion}`;
    throw new Error(`节拍分析失败：${lastLine(stderr)}；${hint}`);
  }
}

/**
 * pythonFor 返回跑分析用的 Python：beat.yaml 没写 python 时用 am setup 装好的共享环境
 * （没装好抛 prereq.MissingError），写了就用用户自己的。两种情况都不在这里建环境、装依赖。
 */
export function pythonFor(config: Config, env: Record<string, string>): string {
  if (config.python === '') return requireEnv(env);
  try {
    const binary = lookPath(config.python, env.PATH ?? '');
    fs.accessSync(binary, fs.constants.X_OK);
    return binary;
  } catch {
    throw new Error(`找不到 ${ConfigFile} 指定的 Python（${config.python}）：改成存在的路径，或删掉 python 这一行改用客户端装好的共享环境`);
  }
}

/**
 * lastLine 取 stderr 最后一行有内容的输出；Python 的异常摘要在那里。
 * 下载进度条用 \r 刷新同一行，也按行尾切开。
 */
export function lastLine(text: string): string {
  const lines = text.split(/[\n\r]/).filter((line) => line !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = goTrimSpace(lines[i]);
    if (line !== '') return line;
  }
  return '无错误输出';
}
