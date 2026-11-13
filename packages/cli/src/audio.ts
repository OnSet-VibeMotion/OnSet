/**
 * 配音相关的命令。移植自 internal/cli/audio.go。
 */
import { formatFixed, formatG } from '@am/engine/gofmt';
import * as mediaprobe from '@am/engine/mediaprobe';
import * as srt from '@am/engine/srt';
import * as voicecheck from '@am/engine/voicecheck';
import { currentEnvironment, noArgs } from './cli';
import { Command, type Out, ref } from './cobra';

/** Go 的 %+.Nf：非负数也带 +（-0 写成 -0.000）。 */
function signedFixed(value: number, digits: number): string {
  const text = formatFixed(value, digits);
  return text.startsWith('-') ? text : '+' + text;
}

export function newAudioCommand(stdout: Out): Command {
  const cmd = new Command({
    use: 'audio',
    short: '配音相关检查',
    long: `配音相关的机器检查。

  check   把字幕时间轴与配音里实际发声的区间逐条比对，拦下整体偏移、
          落在静音里的字幕与没有字幕覆盖的发声

配音本身由编排工具按 TTS_PROVIDER 生成，强制对齐按 ALIGN_PROVIDER 执行；
这里只做与工具无关、结果确定的校验。`,
  });
  cmd.addCommand(newAudioCheckCommand(stdout));
  return cmd;
}

function newAudioCheckCommand(stdout: Out): Command {
  const audioPath = ref('');
  const srtPath = ref('');
  const reportPath = ref('');
  const tolerance = ref(voicecheck.Defaults.tolerance);
  const belowPeakDB = ref(voicecheck.Defaults.belowPeakDB);
  const minGap = ref(voicecheck.Defaults.minGap);
  const minUncovered = ref(voicecheck.Defaults.minUncovered);
  const cmd = new Command({
    use: 'check',
    args: noArgs,
    short: '把字幕时间轴与配音里实际发声的区间逐条比对',
    long: `用配音的能量包络独立校验字幕时间轴。

字幕时间来自 TTS 自带的时间戳、ASR 识别或强制对齐，三者都可能整体偏移或局部
错位——实测 TTS 自带的 SRT 会比实际发声早约 0.4 秒。字幕、镜头切点和画面节拍
全挂在这条时间轴上，它错了，下游没有任何环节会报错。

这条命令不识别文字，只判定「这一刻有没有声音」：电平低于全片最响处
--below-peak-db 分贝即视为静音，短于 --min-gap 的静音并入发声。它与字幕来源
完全无关，所以能交叉校验任何一种来源。

判为问题（退出码 1）：
  - 字幕开始早于其中首个发声超过 --tolerance 秒
  - 字幕开始晚于发声超过 --tolerance 秒，且那段发声不在前一条字幕里
  - 字幕整段落在静音里
  - 有声区间持续 --min-uncovered 秒以上没有任何字幕覆盖

只进 hints（不影响退出码）：
  - 字幕在声音结束后继续停留超过 --tolerance 秒。终稿字幕按可读语义单元延长
    停留是允许的；但对 TTS 或对齐直接产出的时间戳，这说明它偏晚
  - 全部字幕起点偏差的中位数超过容差的一半：多条同向偏移说明时间戳来源有系统
    误差，应整体校正而不是逐条修

逐条的发声区间与偏差写在 --report-json 里，判断结果请读它。`,
    example: `  # 校验 TTS 产出的句级时间戳
  am audio check --audio production/audio/voice.wav --srt production/audio/voice.srt

  # 校验终稿字幕并留存报告
  am audio check --audio production/audio/voice.wav --srt transcription-production.srt \\
    --report-json production/audio/voice-check.json`,
    runE: () => {
      if (audioPath.value === '' || srtPath.value === '') throw new Error('必须同时给出 --audio 与 --srt');
      for (const [name, value] of [
        ['--tolerance', tolerance.value],
        ['--below-peak-db', belowPeakDB.value],
        ['--min-gap', minGap.value],
        ['--min-uncovered', minUncovered.value],
      ] as const) {
        if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} 必须是有限正数，收到 ${formatG(value)}`);
      }
      const opts: voicecheck.Options = { tolerance: tolerance.value, belowPeakDB: belowPeakDB.value, minGap: minGap.value, minUncovered: minUncovered.value };
      const cues = srt.readCues(srtPath.value);
      const toolchain = mediaprobe.newToolchain(currentEnvironment());
      const levels = toolchain.loudness(audioPath.value, voicecheck.Defaults.window);
      const [speech, threshold] = voicecheck.speech(levels, opts);
      const report = voicecheck.check(cues, speech, threshold, opts);
      if (reportPath.value !== '') voicecheck.writeReportJSON(report, reportPath.value);
      stdout.write(`字幕 ${cues.length} 条，检测到发声 ${speech.length} 段（静音阈值 ${formatFixed(report.threshold_db, 1)} dBFS）\n`);
      if (report.median_start_delta !== undefined) stdout.write(`字幕起点相对发声的中位偏差：${signedFixed(report.median_start_delta, 3)} 秒\n`);
      for (const hint of report.hints ?? []) stdout.write(`提示：${hint}\n`);
      if (!report.ok) throw new Error(`字幕时间轴与配音不符：${srtPath.value}\n  - ${(report.problems ?? []).join('\n  - ')}`);
      stdout.write('字幕时间轴与配音一致\n');
    },
  });
  const flags = cmd.flags();
  flags.stringVar(audioPath, 'audio', '', '配音文件，必填');
  flags.stringVar(srtPath, 'srt', '', '待校验的字幕文件，必填');
  flags.stringVar(reportPath, 'report-json', '', '把逐条比对结果写成 JSON 报告到该路径');
  flags.float64Var(tolerance, 'tolerance', voicecheck.Defaults.tolerance, '字幕边界与发声边界允许的偏差（秒）');
  flags.float64Var(belowPeakDB, 'below-peak-db', voicecheck.Defaults.belowPeakDB, '低于全片最响处多少分贝视为静音');
  flags.float64Var(minGap, 'min-gap', voicecheck.Defaults.minGap, '视为停顿的最短静音（秒），更短的并入发声');
  flags.float64Var(minUncovered, 'min-uncovered', voicecheck.Defaults.minUncovered, '报告无字幕覆盖的最短发声（秒）');
  return cmd;
}
