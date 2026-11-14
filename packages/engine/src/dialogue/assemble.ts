import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import { formatFixed, goPathError } from '../gofmt';
import { newToolchain } from '../mediaprobe';
import { newRunner } from './audio';
import { DialogueRelPath, SRTRelPath, VoiceRelPath } from './paths';
import { totalSeconds, type Plan, type Result } from './plan';
import { isFinite, rebuild, writeResultJSON, writeSRT } from './timeline';

/**
 * DriftToleranceSeconds 是实测总时长与推算总时长的最大容许差。
 *
 * 50ms 是一帧半（30fps）：再大就是肉眼可见的音画错位，再小则会被 ffmpeg
 * 各版本在容器时长写入上的正常抖动误伤。
 */
export const DriftToleranceSeconds = 0.05;

// perSegmentRelativeTolerance 与 perSegmentAbsoluteFloorSeconds 定义单段声明
// 时长（plan 里该段最后一行的 endSeconds）与实测时长（normalize 后探测出的
// 音频时长）之间的容差：max(绝对下限, 相对比例 * 声明时长)。
//
// 用相对比例是因为长段和短段的合理抖动不是一个量级；单用绝对值，长段会漏
// 判，短段又太敏感。10% 的选择依据是 rebuild 注释里说的「TTS 声明的段内
// 时间戳与实际音频长度常有几十毫秒出入」——对一段几秒钟的音频，几十毫秒
// 换算下来大约是百分之一到百分之几，10% 留出了数倍安全边际，不会把这类
// 正常抖动当成异常；但 10% 又远小于「文件拿错」「TTS 输出被截断或重复」
// 这类真实故障的量级（通常是数倍甚至整段丢失/重复），足够拦下来。
// 200ms 的绝对下限是防止极短分段（几百毫秒以内）被相对比例算出一个小于
// 正常抖动本身的容差，反而把合法输入误杀。
const perSegmentRelativeTolerance = 0.1;
const perSegmentAbsoluteFloorSeconds = 0.2;

/** segmentDriftTolerance 返回给定声明时长下，逐段声明 vs 实测校验的容差。 */
function segmentDriftTolerance(declaredSeconds: number): number {
  return Math.max(perSegmentAbsoluteFloorSeconds, declaredSeconds * perSegmentRelativeTolerance);
}

export interface Options {
  /** 项目根目录。 */
  root: string;
  /** plan.json 路径。 */
  planPath: string;
  /** 可选的外部期望总时长；为 0 时只做内部一致性断言。 */
  expectTotalSeconds?: number;
}

/** plan.json 的宽松解码（json.Unmarshal：未知字段忽略，缺失取零值）。 */
function parsePlan(body: string): Plan {
  const raw = JSON.parse(body) as unknown;
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, what: string): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new Error(`json: cannot unmarshal ${typeof v} into Go struct field ${what} of type string`);
    return v;
  };
  const num = (v: unknown, what: string, int: boolean): number => {
    if (v === undefined || v === null) return 0;
    if (typeof v !== 'number' || (int && !Number.isInteger(v))) {
      throw new Error(`json: cannot unmarshal ${typeof v} into Go struct field ${what} of type ${int ? 'int' : 'float64'}`);
    }
    return v;
  };
  const get = (o: Record<string, unknown>, key: string): unknown => {
    if (key in o) return o[key];
    const found = Object.keys(o).find((k) => k.toLowerCase() === key.toLowerCase());
    return found === undefined ? undefined : o[found];
  };
  const segmentsRaw = get(obj, 'segments');
  return {
    schema: str(get(obj, 'schema'), 'Plan.schema'),
    segments: Array.isArray(segmentsRaw)
      ? segmentsRaw.map((s) => {
          const seg = (s ?? {}) as Record<string, unknown>;
          const linesRaw = get(seg, 'lines');
          return {
            index: num(get(seg, 'index'), 'PlanSegment.index', true),
            speaker: str(get(seg, 'speaker'), 'PlanSegment.speaker'),
            voiceId: str(get(seg, 'voiceId'), 'PlanSegment.voiceId'),
            audio: str(get(seg, 'audio'), 'PlanSegment.audio'),
            gapAfterMs: num(get(seg, 'gapAfterMs'), 'PlanSegment.gapAfterMs', true),
            lines: Array.isArray(linesRaw)
              ? linesRaw.map((l) => {
                  const line = (l ?? {}) as Record<string, unknown>;
                  return {
                    text: str(get(line, 'text'), 'PlanLine.text'),
                    startSeconds: num(get(line, 'startSeconds'), 'PlanLine.startSeconds', false),
                    endSeconds: num(get(line, 'endSeconds'), 'PlanLine.endSeconds', false),
                  };
                })
              : null,
          };
        })
      : null,
  };
}

/**
 * assemble 读 plan.json，把分段音频装配成 voice.wav、SRT 和 dialogue.json。
 *
 * 装配过程有两道漂移防线，各自拦不同的错，互补而非替代：
 *
 *  1. 逐段声明 vs 实测校验（segmentDriftTolerance）：每段都拿 plan 里该段
 *     最后一行的 endSeconds（TTS 自己声明的段内时长）跟 normalize
 *     后实测的音频时长比对，差异超出容差就直接失败并点名具体段号和文件。
 *     这道防线拦的是「输入数据本身就是错的」——音频文件拿错、TTS 输出被
 *     截断或重复。rebuild 的等比拉伸会把声明和实测的差异悄悄摊平，如果
 *     不在这里拦，一段声明 1 秒、实际 3 秒的音频会被拉伸消化掉，产出画面
 *     正常、只是嘴和字对不上的成片，而不会报错。
 *
 *  2. 总时长漂移断言（DriftToleranceSeconds）：实测拼接产物 voice.wav 的
 *     总时长，跟 rebuild 算出的 totalSeconds 比对，再跟调用方给的
 *     expectTotalSeconds（如果非零）比对。这道防线拦的是拼接管道自身的
 *     逻辑 bug——比如某段间隔该不该计入 totalSeconds 算错了。它对「plan
 *     声明的时长本身不可信」这类问题是同义反复：expected 和 final 都源自
 *     同一批 measured[]，输入数据的错误会被两边一起继承而互相抵消，光靠
 *     它拦不住第 1 类问题，所以缺一不可。
 */
export async function assemble(opts: Options, signal?: AbortSignal): Promise<Result> {
  let body: string;
  try {
    body = fs.readFileSync(opts.planPath, 'utf8');
  } catch (err) {
    throw new Error(`读取 plan 失败：${goPathError('open', opts.planPath, err)}`, { cause: err });
  }
  let plan: Plan;
  try {
    plan = parsePlan(body);
  } catch (err) {
    throw new Error(`解析 plan 失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const env = envMap();
  const toolchain = newToolchain(env);
  const runner = newRunner(env, toolchain);

  const workDir = path.join(opts.root, 'production', 'audio', 'assembled');
  // 先清空再建：上一次运行留下的分段/间隔文件不会自然消失（-y 只保证不会
  // 读到旧内容，不会清理多余文件），换成更少段数的 plan 后会一直堆积。
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`清理装配临时目录失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  fs.mkdirSync(workDir, { recursive: true, mode: 0o755 });

  const segments = plan.segments ?? [];
  const measured: number[] = new Array<number>(segments.length).fill(0);
  const pieces: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const source = path.join(opts.root, segment.audio);
    const normalized = path.join(workDir, `seg-${String(i + 1).padStart(3, '0')}.wav`);
    await runner.normalize(source, normalized, signal);
    const media = toolchain.probe(normalized);
    measured[i] = media.duration_seconds;
    pieces.push(normalized);

    // 逐段声明 vs 实测校验：拦「输入数据本身就是错的」，rebuild 的等比
    // 拉伸不会替我们拦这个，见 assemble 顶部的文档注释。
    const lines = segment.lines ?? [];
    if (lines.length > 0) {
      const declared = lines[lines.length - 1].endSeconds;
      if (isFinite(declared) && declared > 0 && isFinite(measured[i])) {
        const tolerance = segmentDriftTolerance(declared);
        const diff = Math.abs(measured[i] - declared);
        if (diff > tolerance) {
          throw new Error(
            `第 ${i + 1} 段时间轴漂移：${segment.audio} 声明 ${formatFixed(declared, 3)} 秒，实测 ${formatFixed(measured[i], 3)} 秒，差 ${formatFixed(diff, 3)} 秒超出容差 ${formatFixed(tolerance, 3)} 秒` +
              '（可能是音频文件拿错，或 TTS 输出被截断/重复）',
          );
        }
      }
    }

    if (segment.gapAfterMs > 0 && i < segments.length - 1) {
      const gap = path.join(workDir, `gap-${String(i + 1).padStart(3, '0')}.wav`);
      await runner.silence(gap, segment.gapAfterMs, signal);
      pieces.push(gap);
    }
  }

  const result = rebuild(plan, measured);

  const voicePath = path.join(opts.root, VoiceRelPath);
  await runner.concat(pieces, voicePath, signal);
  const final = toolchain.probe(voicePath);

  // rebuild 的 cursor 对每段累加 duration + gap，totalSeconds 取的是末段的
  // endSeconds，因此它含全部段间间隔、不含尾部间隔——而拼接时也只在
  // i < len-1 时插入间隔，两边口径一致，直接比较即可。
  const expected = totalSeconds(result);
  let drift = Math.abs(final.duration_seconds - expected);
  if (drift > DriftToleranceSeconds) {
    throw new Error(
      `时间轴漂移 ${formatFixed(drift, 3)} 秒超出容差 ${formatFixed(DriftToleranceSeconds, 3)}：实测 voice.wav ${formatFixed(final.duration_seconds, 3)} 秒，按分段推算 ${formatFixed(expected, 3)} 秒`,
    );
  }
  const expect = opts.expectTotalSeconds ?? 0;
  if (expect > 0) {
    drift = Math.abs(final.duration_seconds - expect);
    if (drift > DriftToleranceSeconds) {
      throw new Error(
        `时间轴漂移 ${formatFixed(drift, 3)} 秒超出容差 ${formatFixed(DriftToleranceSeconds, 3)}：实测 ${formatFixed(final.duration_seconds, 3)} 秒，期望 ${formatFixed(expect, 3)} 秒`,
      );
    }
  }

  writeSRT(path.join(opts.root, SRTRelPath), result.lines);
  writeResultJSON(result, path.join(opts.root, DialogueRelPath));
  return result;
}
