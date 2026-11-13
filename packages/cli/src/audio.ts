/**
 * 配音相关的操作。
 */
import { formatFixed, formatG } from '@am/engine/gofmt';
import * as mediaprobe from '@am/engine/mediaprobe';
import * as srt from '@am/engine/srt';
import * as voicecheck from '@am/engine/voicecheck';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { num, str } from './ops/common';
import { defineOp } from './ops/op';

/** Go 的 %+.Nf：非负数也带 +（-0 写成 -0.000）。 */
function signedFixed(value: number, digits: number): string {
  const text = formatFixed(value, digits);
  return text.startsWith('-') ? text : '+' + text;
}

defineGroup({
  path: ['audio'],
  summary: '配音相关检查',
  description: `配音相关的机器检查。

  audio_check   把字幕时间轴与配音里实际发声的区间逐条比对，拦下整体偏移、
                落在静音里的字幕与没有字幕覆盖的发声

配音本身由编排工具按 TTS_PROVIDER 生成，强制对齐按 ALIGN_PROVIDER 执行；
这里只做与工具无关、结果确定的校验。`,
});

defineOp({
  name: 'audio_check',
  cli: ['audio', 'check'],
  summary: '把字幕时间轴与配音里实际发声的区间逐条比对',
  description: `用配音的能量包络独立校验字幕时间轴。

字幕时间来自 TTS 自带的时间戳、ASR 识别或强制对齐，三者都可能整体偏移或局部
错位——实测 TTS 自带的 SRT 会比实际发声早约 0.4 秒。字幕、镜头切点和画面节拍
全挂在这条时间轴上，它错了，下游没有任何环节会报错。

这个检查不识别文字，只判定「这一刻有没有声音」：电平低于全片最响处
below_peak_db 分贝即视为静音，短于 min_gap 的静音并入发声。它与字幕来源
完全无关，所以能交叉校验任何一种来源。

判为问题（检查失败）：
  - 字幕开始早于其中首个发声超过 tolerance 秒
  - 字幕开始晚于发声超过 tolerance 秒，且那段发声不在前一条字幕里
  - 字幕整段落在静音里
  - 有声区间持续 min_uncovered 秒以上没有任何字幕覆盖

只进 hints（不影响结论）：
  - 字幕在声音结束后继续停留超过 tolerance 秒。终稿字幕按可读语义单元延长
    停留是允许的；但对 TTS 或对齐直接产出的时间戳，这说明它偏晚
  - 全部字幕起点偏差的中位数超过容差的一半：多条同向偏移说明时间戳来源有系统
    误差，应整体校正而不是逐条修

逐条的发声区间与偏差写在 report_json 里，判断结果请读它。`,
  examples: [
    '# 校验 TTS 产出的句级时间戳',
    'audio_check({"audio": "production/audio/voice.wav", "srt": "production/audio/voice.srt"})',
    '# 校验终稿字幕并留存报告',
    'audio_check({"audio": "production/audio/voice.wav", "srt": "transcription-production.srt", "report_json": "production/audio/voice-check.json"})',
  ],
  params: {
    audio: { type: 'string', description: '配音文件，必填' },
    srt: { type: 'string', description: '待校验的字幕文件，必填' },
    report_json: { type: 'string', description: '把逐条比对结果写成 JSON 报告到该路径' },
    tolerance: { type: 'number', description: '字幕边界与发声边界允许的偏差（秒）', default: voicecheck.Defaults.tolerance },
    below_peak_db: { type: 'number', description: '低于全片最响处多少分贝视为静音', default: voicecheck.Defaults.belowPeakDB },
    min_gap: { type: 'number', description: '视为停顿的最短静音（秒），更短的并入发声', default: voicecheck.Defaults.minGap },
    min_uncovered: { type: 'number', description: '报告无字幕覆盖的最短发声（秒）', default: voicecheck.Defaults.minUncovered },
  },
  run: (p, { out }) => {
    const audioPath = str(p.audio);
    const srtPath = str(p.srt);
    if (audioPath === '' || srtPath === '') throw new Error('必须同时给出 audio 与 srt');
    const tolerance = num(p.tolerance);
    const belowPeakDB = num(p.below_peak_db);
    const minGap = num(p.min_gap);
    const minUncovered = num(p.min_uncovered);
    for (const [name, value] of [
      ['tolerance', tolerance],
      ['below_peak_db', belowPeakDB],
      ['min_gap', minGap],
      ['min_uncovered', minUncovered],
    ] as const) {
      if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} 必须是有限正数，收到 ${formatG(value)}`);
    }
    const opts: voicecheck.Options = { tolerance, belowPeakDB, minGap, minUncovered };
    const cues = srt.readCues(srtPath);
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    const levels = toolchain.loudness(audioPath, voicecheck.Defaults.window);
    const [speech, threshold] = voicecheck.speech(levels, opts);
    const report = voicecheck.check(cues, speech, threshold, opts);
    if (str(p.report_json) !== '') voicecheck.writeReportJSON(report, str(p.report_json));
    out.write(`字幕 ${cues.length} 条，检测到发声 ${speech.length} 段（静音阈值 ${formatFixed(report.threshold_db, 1)} dBFS）\n`);
    if (report.median_start_delta !== undefined) out.write(`字幕起点相对发声的中位偏差：${signedFixed(report.median_start_delta, 3)} 秒\n`);
    for (const hint of report.hints ?? []) out.write(`提示：${hint}\n`);
    if (!report.ok) throw new Error(`字幕时间轴与配音不符：${srtPath}\n  - ${(report.problems ?? []).join('\n  - ')}`);
    out.write('字幕时间轴与配音一致\n');
    return { data: report };
  },
});
