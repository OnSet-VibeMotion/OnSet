/**
 * 本地对齐的输入校验、模型/执行器发现、文本归一化与长配音 TTS 自动分段规划。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as align from '@onset/engine/align';
import { FunASRTimestampModel } from '@onset/engine/config';
import { windowsPython } from '@onset/engine/envutil';
import { marshalIndent } from '@onset/engine/gojson';
import { type ModelSpec, modelDir } from '@onset/engine/toolinstall';
import { findOptional } from '@onset/engine/toolpath';
import * as voicecheck from '@onset/engine/voicecheck';

export const pythonSource = `import json,sys,time,pkgutil,os
from pathlib import Path
started=time.monotonic()
# FunASR 1.4.x 默认递归导入训练、服务器和所有模型。时间戳任务只注册本地模型所需组件。
# 限定这一次包初始化的目录枚举；标准 Python 导入、实际模型与校验均保留，退出即恢复枚举器。
modules=['funasr.frontends.wav_frontend','funasr.tokenizer.char_tokenizer','funasr.models.sanm.encoder','funasr.models.bicif_paraformer.cif_predictor','funasr.models.specaug.specaug','funasr.models.monotonic_aligner.model','funasr.auto.auto_model']
original=pkgutil.walk_packages
def timestamp_modules(path=None,prefix='',onerror=None):
 if prefix=='funasr.':
  for name in modules:yield pkgutil.ModuleInfo(None,name,False)
 else:yield from original(path,prefix,onerror)
os.environ['FUNASR_STRICT_IMPORT']='1'
pkgutil.walk_packages=timestamp_modules
try:from funasr import AutoModel
finally:pkgutil.walk_packages=original
print('onset_import_seconds='+str(time.monotonic()-started),flush=True)
model=AutoModel(model=sys.argv[1],disable_update=True,device='cpu')
result=model.generate(input=(sys.argv[2],Path(sys.argv[3]).read_text(encoding='utf-8')),data_type=('sound','text'))
with open(sys.argv[4],'x',encoding='utf-8') as output:
 json.dump(result,output,ensure_ascii=False)
print('onset_python_seconds='+str(time.monotonic()-started),flush=True)
`;

export const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const writeJsonFile = (file: string, value: unknown) => fs.writeFileSync(file, marshalIndent(value) + '\n');
export const roundMs = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** 自动分段阈值与单段上限（秒）：超过阈值且存在匹配 TTS 段落报告时自动切段对齐并合并时间轴，避免 MLX 长音频越限或编排手写切分脚本。 */
export const AutoChunkThresholdSeconds = 180;
export const AutoChunkMaxSeconds = 150;

export interface AutoChunk {
  index: number;
  start: number;
  end: number;
  text: string;
}

interface TTSSegmentRecord {
  text?: unknown;
  start_seconds?: unknown;
  duration_seconds?: unknown;
  pause_after_ms?: unknown;
}

interface TTSReportRecord {
  duration_seconds?: unknown;
  segments?: unknown;
}

const spokenSignature = (value: string) => value.replace(/[\p{P}\s]+/gu, '');

export function normalizeWindowsAlignmentText(text: string): string {
  const normalized = text.replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim();
  const spoken = (value: string) => value.replace(/[\p{P}\s]/gu, '');
  if (!normalized || spoken(normalized) !== spoken(text)) throw Error('对齐文本的朗读字符发生变化');
  return normalized;
}

/**
 * 查找与当前音频和终稿严格匹配的 TTS 段落报告（<stem>.tts/report.json，或同目录任意 *.tts/report.json 且其 audio.wav 的 SHA-256 与当前音频一致）。
 * 只有当总时长和朗读字符序列完全匹配时才启用自动切段，避免拿旧 take 的报告错切。
 */
export function planTTSAutoChunks(
  audio: string,
  audioSHA: string,
  scriptAlignText: string,
  actualDuration: number,
  provider: 'funasr' | 'mlx',
  maxChunkSeconds: number,
  thresholdSeconds = AutoChunkThresholdSeconds,
): { reportFile: string; reportSHA: string; chunks: AutoChunk[] } | null {
  if (maxChunkSeconds <= 0 || actualDuration <= thresholdSeconds) return null;
  const dir = path.dirname(audio);
  const stem = audio.slice(0, audio.length - path.extname(audio).length);
  const candidates: string[] = [];
  const tryCandidate = (reportPath: string, wavPath: string) => {
    try {
      if (!fs.lstatSync(reportPath).isFile() || !fs.lstatSync(wavPath).isFile()) return;
      if (sha(wavPath) === audioSHA) candidates.push(reportPath);
    } catch {
      // 跳过不存在、符号链接或不可读的候选。
    }
  };
  const primaryDir = stem + '.tts';
  const primary = path.join(primaryDir, 'report.json');
  tryCandidate(primary, path.join(primaryDir, 'audio.wav'));
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.tts')) continue;
      const reportPath = path.join(dir, entry.name, 'report.json');
      if (reportPath === primary) continue;
      tryCandidate(reportPath, path.join(dir, entry.name, 'audio.wav'));
    }
  } catch {
    // 忽略目录枚举异常。
  }
  const wantSpoken = spokenSignature(scriptAlignText);
  if (!wantSpoken) return null;
  for (const reportFile of candidates) {
    let report: TTSReportRecord;
    try {
      if (fs.lstatSync(reportFile).isSymbolicLink()) continue;
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as TTSReportRecord;
    } catch {
      continue;
    }
    if (typeof report.duration_seconds !== 'number' || Math.abs(report.duration_seconds - actualDuration) > 0.25) {
      continue;
    }
    if (!Array.isArray(report.segments) || report.segments.length < 2) continue;
    const segs: Array<{ text: string; start: number; end: number; pauseSec: number }> = [];
    let valid = true;
    let prevEnd = 0;
    for (const raw of report.segments as TTSSegmentRecord[]) {
      if (
        typeof raw?.text !== 'string' ||
        typeof raw.start_seconds !== 'number' ||
        typeof raw.duration_seconds !== 'number'
      ) {
        valid = false;
        break;
      }
      if (
        !Number.isFinite(raw.start_seconds) ||
        !Number.isFinite(raw.duration_seconds) ||
        raw.start_seconds < prevEnd - 0.02 ||
        raw.duration_seconds <= 0
      ) {
        valid = false;
        break;
      }
      const end = raw.start_seconds + raw.duration_seconds;
      if (end > actualDuration + 0.25) {
        valid = false;
        break;
      }
      const pauseSec = typeof raw.pause_after_ms === 'number' && raw.pause_after_ms > 0 ? raw.pause_after_ms / 1000 : 0;
      const cleanText = align.stripVocalEvents(raw.text).trim();
      prevEnd = end;
      // 仅含声音事件（如单独一段 [笑]）不含朗读文字，跳过不单独成块，保留其余段的真实起止时间。
      if (!spokenSignature(cleanText)) continue;
      segs.push({ text: cleanText, start: raw.start_seconds, end: Math.min(end, actualDuration), pauseSec });
    }
    if (!valid || segs.length < 2) continue;
    if (spokenSignature(segs.map((s) => s.text).join('\n')) !== wantSpoken) continue;

    // 贪心合段：把相邻 TTS 段落拼成不超过 maxChunkSeconds 的切块，切点严格落在段落静音边界。
    const chunks: AutoChunk[] = [];
    let groupStart = segs[0]!.start;
    let groupEnd = segs[0]!.end;
    let groupTexts: string[] = [segs[0]!.text];
    let lastPause = segs[0]!.pauseSec;
    const flush = (nextStart: number | null) => {
      const paddedEnd = Math.min(
        actualDuration,
        nextStart !== null ? Math.min(groupEnd + lastPause / 2, nextStart) : actualDuration,
      );
      const joined = groupTexts.join('\n');
      const chunkText = provider === 'funasr' ? normalizeWindowsAlignmentText(joined) : joined;
      chunks.push({
        index: chunks.length,
        start: roundMs(groupStart),
        end: roundMs(Math.max(paddedEnd, groupEnd)),
        text: chunkText,
      });
    };
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i]!;
      if (seg.end - groupStart > maxChunkSeconds && groupTexts.length > 0) {
        flush(seg.start);
        groupStart = seg.start;
        groupEnd = seg.end;
        groupTexts = [seg.text];
        lastPause = seg.pauseSec;
      } else {
        groupEnd = seg.end;
        groupTexts.push(seg.text);
        lastPause = seg.pauseSec;
      }
    }
    flush(null);
    if (chunks.length >= 2) {
      return { reportFile, reportSHA: sha(reportFile), chunks };
    }
  }
  return null;
}

export function inputPath(root: string, relative: string): string {
  const file = path.resolve(root, relative);
  const real = fs.realpathSync(file);
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|[\\/])\.(?:env|git|codex)(?:[.\\/]|$)/i.test(rel)) {
    throw Error('对齐输入必须是项目内的非凭据文件');
  }
  if (!fs.statSync(real).isFile()) throw Error('对齐输入必须是普通文件');
  return real;
}

export function localAlignmentModel(env: Record<string, string>, spec: ModelSpec = FunASRTimestampModel): string {
  for (const model of [env.ALIGN_MODEL, modelDir(spec, env)]) {
    if (
      model &&
      path.isAbsolute(model) &&
      spec.files.every(({ path: name }) => {
        try {
          return fs.statSync(path.join(model, name)).isFile();
        } catch {
          return false;
        }
      })
    ) {
      return fs.realpathSync(model);
    }
  }
  throw Error('本地对齐模型不完整，请在工具准备页修复；本操作不会下载或访问个人缓存');
}

export function alignmentRunner(provider: 'funasr' | 'mlx', env: Record<string, string>) {
  if (provider === 'mlx') {
    const command = findOptional('mlx_audio.stt.generate', env);
    if (!command) throw Error('缺少已准备的 MLX 对齐工具，请在工具准备页修复');
    return { command, fingerprint: sha(command) };
  }
  if (process.platform !== 'win32') {
    const command = findOptional('funasr-python', env);
    if (!command) throw Error('缺少已准备的 FunASR Python 环境，请在工具准备页修复');
    return { command, fingerprint: sha(command) };
  }
  const command = windowsPython(env);
  const init = path.resolve(path.dirname(command), '../Lib/site-packages/funasr/__init__.py');
  if (!command || !fs.existsSync(init)) throw Error('缺少已准备的 FunASR Python 环境，请在工具准备页修复');
  return { command, fingerprint: sha(init) };
}

export interface FingerprintOptions {
  root: string;
  provider: 'funasr' | 'mlx' | 'evidence';
  audioSHA: string;
  scriptFile: string;
  fps: number;
  model: string;
  modelSpec: ModelSpec;
  runner: { command: string; fingerprint: string } | null;
  hasDialogue: boolean;
  source: string;
  evidenceSHA: string | null;
  segments: unknown | null;
  segmentsManifestSHA: string | null;
  autoPlan: { reportSHA: string; chunks: AutoChunk[] } | null;
  maxChunkSeconds: number;
}

/** 构造候选目录输入摘要（inputs + digest + base），并确保候选目录不经过任何符号链接。 */
export function buildAlignmentFingerprint(opts: FingerprintOptions): {
  inputs: Record<string, unknown>;
  digest: string;
  base: string;
  existingTimeline: string;
  adjust: string;
} {
  // 保留 Windows FunASR 的缓存键，旧版已经校验过的候选可直接取用。
  const modelFiles =
    opts.provider === 'funasr'
      ? ['model.pt', 'config.yaml', 'tokens.json', 'am.mvn', 'seg_dict', 'configuration.json']
      : opts.modelSpec.files.map((file) => file.path);
  const inputs: Record<string, unknown> = {
    audio: opts.audioSHA,
    script: sha(opts.scriptFile),
    fps: opts.fps,
    model: opts.model,
    modelFiles: opts.runner
      ? modelFiles.map((name) => {
          const s = fs.statSync(path.join(opts.model, name));
          return [name, s.size, s.mtimeMs];
        })
      : [],
    python: opts.runner?.command,
    runner: opts.runner?.fingerprint,
    pipeline: 1,
  };
  if (opts.hasDialogue) Object.assign(inputs, { dialogue: true });
  const existingTimeline = path.join(opts.root, 'production/phrase-timeline.json');
  const adjust = path.join(opts.root, 'production/phrase-adjust.json');
  if (fs.existsSync(existingTimeline)) inputPath(opts.root, path.relative(opts.root, existingTimeline));
  if (fs.existsSync(adjust)) inputPath(opts.root, path.relative(opts.root, adjust));
  const review = (align.loadExistingTimeline(existingTimeline)?.phrases ?? [])
    .filter((phrase) => phrase.reviewed || (phrase.visible_event_ids ?? []).length)
    .map((phrase) => ({ id: phrase.phrase_id, reviewed: phrase.reviewed, events: phrase.visible_event_ids }));
  Object.assign(inputs, {
    existingReview: review,
    adjust: fs.existsSync(adjust) ? sha(adjust) : null,
    checks: voicecheck.Defaults,
  });
  const autoChunksMeta = opts.autoPlan
    ? {
        autoChunks: {
          reportSHA: opts.autoPlan.reportSHA,
          chunks: opts.autoPlan.chunks.length,
          maxChunkSeconds: opts.maxChunkSeconds,
        },
      }
    : {};
  if (opts.provider === 'evidence') Object.assign(inputs, { pipeline: 6, evidenceSHA: opts.evidenceSHA });
  else if (opts.provider === 'mlx') Object.assign(inputs, { pipeline: 5, provider: opts.provider, ...autoChunksMeta });
  else {
    Object.assign(inputs, {
      pipeline: opts.segments ? 4 : 3,
      pythonSource: crypto.createHash('sha256').update(opts.source).digest('hex'),
      ...(opts.segments ? { segmentsManifest: opts.segmentsManifestSHA, segments: opts.segments } : {}),
      ...autoChunksMeta,
    });
  }
  const digest = crypto.createHash('sha256').update(marshalIndent(inputs)).digest('hex');
  const base = path.join(opts.root, 'production/audio/alignment-runs', digest);
  // 不允许已有目录链接把输出引向项目外。
  for (let dir = path.dirname(base); dir !== opts.root; dir = path.dirname(dir)) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw Error('候选目录不能经过链接');
  }
  if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) throw Error('候选目录不能是链接');
  fs.mkdirSync(base, { recursive: true });
  return { inputs, digest, base, existingTimeline, adjust };
}
