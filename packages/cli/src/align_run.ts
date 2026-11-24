import fs from 'node:fs';
import path from 'node:path';
import * as align from '@onset/engine/align';
import { FunASRTimestampModel, load as loadConfig, QwenForcedAligner } from '@onset/engine/config';
import { envMap } from '@onset/engine/envutil';
import * as mediaprobe from '@onset/engine/mediaprobe';
import { newScene, sceneCanvas } from '@onset/engine/scene';
import { readCues } from '@onset/engine/srt';
import * as voicecheck from '@onset/engine/voicecheck';
import {
  type AutoChunk,
  AutoChunkMaxSeconds,
  AutoChunkThresholdSeconds,
  alignmentRunner,
  buildAlignmentFingerprint,
  inputPath,
  localAlignmentModel,
  normalizeWindowsAlignmentText,
  planTTSAutoChunks,
  pythonSource,
  sha,
  writeJsonFile,
} from './align_run_chunks';
import {
  acquireRunLock,
  loadVerifiedCandidate,
  publishAlignedCandidate,
  runChunkedAlignment,
  runSingleAlignment,
  sealVerifiedCandidate,
} from './align_run_exec';
import { bool, num, projectRoot, str } from './ops/common';
import type { Op } from './ops/op';
import {
  loadWindowsAlignmentSegments,
  verifyWindowsAlignmentSegments,
  windowsSegmentPython,
} from './windows_alignment_segments';

export {
  type AutoChunk,
  AutoChunkMaxSeconds,
  AutoChunkThresholdSeconds,
  localAlignmentModel,
  normalizeWindowsAlignmentText,
  planTTSAutoChunks,
};

/** 一次模型调用、一次映射、一次独立能量校验；所有新产物留在带输入指纹的候选目录。 */
export function alignRunOperation(legacyWindows = false): Op {
  return {
    name: legacyWindows ? 'windows_align' : 'align_run',
    cli: legacyWindows ? ['windows', 'align'] : ['align', 'run'],
    summary: '用本地模型生成并校验字幕和短语时间轴',
    examples: legacyWindows
      ? ['windows_align()', 'windows_align({"publish":true})']
      : ['align_run()', 'align_run({"publish":true})'],
    description: `读取确认的配音与终稿，按项目配置使用已安装的 MLX 或 FunASR。已有可信字级结果时用 evidence，直接映射并独立校验。按输入摘要复用已验证候选。失败返回诊断，同一输入默认不重试。首次生成可用 publish=true 写入规范路径；已有规范输出或已确认分镜时生成候选。

长配音（>180 秒）且存在与音频、终稿一致的 voice_synthesize() 段落报告（*.tts/report.json）时，本操作会自动按段落静音边界切段（默认每段 ≤150 秒）逐段对齐、平移合并时间轴并做整片独立校验，无需手工编写 Python 切分或拼接脚本。非内置配音的超长录音若需手切，仍可用 align_build() 按偏移合并。`,
    params: {
      project_root: projectRoot,
      audio: { type: 'string', default: 'production/audio/voice.wav', description: '确认的配音，项目内相对路径' },
      script: { type: 'string', default: 'production/script-final.md', description: '确认的终稿' },
      ...(!legacyWindows
        ? {
            evidence: {
              type: 'string' as const,
              description: '现成的字级时间戳 JSON，例如 ElevenLabs 或第三方对齐器的产物',
            },
          }
        : {}),
      segments_manifest: {
        type: 'string',
        description:
          'FunASR 可用的原始 PCM16 TTS 分段清单。顶层包含 schema=1、audio_sha256、script_sha256、sample_rate、segments；每段给出 audio、sha256、text、start_sample、end_sample_exclusive。逐样本校验拼接后，按原采样边界合并结果。',
      },
      max_chunk_seconds: {
        type: 'number',
        default: AutoChunkMaxSeconds,
        description: `长配音自动切段的单段目标上限（秒，默认 ${AutoChunkMaxSeconds}；0 关闭自动切段）`,
      },
      retry: { type: 'boolean', description: '修复原因后显式重试失败输入' },
      publish: { type: 'boolean', description: '首次生成时写入规范路径，已有文件保持原样' },
      timeout_seconds: { type: 'number', default: 180, description: '单次模型调用超时（10–600 秒）' },
    },
    run: async (p, ctx) => {
      const operationStarted = performance.now();
      if (legacyWindows && process.platform !== 'win32') throw Error('此操作仅用于 Windows');
      const root = fs.realpathSync(str(p.project_root));
      const env = envMap();
      const audio = inputPath(root, str(p.audio) || 'production/audio/voice.wav');
      const scriptFile = inputPath(root, str(p.script) || 'production/script-final.md');
      const evidence = str(p.evidence) ? inputPath(root, str(p.evidence)) : null;
      const evidenceSHA = evidence ? sha(evidence) : null;
      const provider = evidence ? 'evidence' : legacyWindows ? 'funasr' : loadConfig(root, env).alignProvider;
      if (provider !== 'mlx' && provider !== 'funasr' && provider !== 'evidence') {
        throw Error('请调用项目配置的第三方对齐工具，再把字级结果传给 align_run() 的 evidence');
      }
      const modelSpec = provider === 'mlx' ? QwenForcedAligner : FunASRTimestampModel;
      const model = provider === 'evidence' ? '' : localAlignmentModel(env, modelSpec);
      const runner = provider === 'evidence' ? null : alignmentRunner(provider, env);
      const fps = sceneCanvas(newScene({ directory: root })).fps;
      const script = align.loadProjectScript(root, scriptFile);
      const text = provider === 'funasr' ? normalizeWindowsAlignmentText(script.alignText()) : script.alignText();
      if (!text.trim()) throw Error('终稿没有任何朗读内容');
      const segmentFile = str(p.segments_manifest) ? inputPath(root, str(p.segments_manifest)) : null;
      if (segmentFile && provider !== 'funasr') throw Error('原始 TTS 分段清单仅用于 FunASR 模型对齐');
      const segments = segmentFile
        ? loadWindowsAlignmentSegments(segmentFile, audio, scriptFile, text, (relative) => inputPath(root, relative))
        : null;
      const segmentsManifestSHA = segmentFile ? sha(segmentFile) : null;
      const source = segments
        ? pythonSource.slice(0, pythonSource.indexOf('result=model.generate(')) + windowsSegmentPython
        : pythonSource;
      const seconds = num(p.timeout_seconds) || 180;
      if (!Number.isFinite(seconds) || seconds < 10 || seconds > 600) {
        throw Error('timeout_seconds 必须在 10..600 秒之间');
      }
      const maxChunkRaw = p.max_chunk_seconds === undefined ? AutoChunkMaxSeconds : num(p.max_chunk_seconds);
      if (!Number.isFinite(maxChunkRaw) || (maxChunkRaw !== 0 && (maxChunkRaw < 1 || maxChunkRaw > 600))) {
        throw Error('max_chunk_seconds 必须是 0 或 1..600 秒之间');
      }
      const thresholdEnv = Number(env.ONSET_ALIGN_AUTO_CHUNK_THRESHOLD_SECONDS ?? '');
      const autoChunkThreshold =
        Number.isFinite(thresholdEnv) && thresholdEnv > 0 ? thresholdEnv : AutoChunkThresholdSeconds;
      const audioSHA = sha(audio);
      const chainProbe = runner && !segments && maxChunkRaw > 0 ? mediaprobe.newToolchain(env).probe(audio) : null;
      const autoPlan =
        runner && !segments && chainProbe && Number.isFinite(chainProbe.duration_seconds)
          ? planTTSAutoChunks(
              audio,
              audioSHA,
              script.alignText(),
              chainProbe.duration_seconds,
              provider as 'funasr' | 'mlx',
              maxChunkRaw,
              autoChunkThreshold,
            )
          : null;
      const { inputs, digest, base, existingTimeline, adjust } = buildAlignmentFingerprint({
        root,
        provider,
        audioSHA,
        scriptFile,
        fps,
        model,
        modelSpec,
        runner,
        hasDialogue: script.speakers.size > 0,
        source,
        evidenceSHA,
        segments,
        segmentsManifestSHA,
        autoPlan,
        maxChunkSeconds: maxChunkRaw,
      });
      const manifest = path.join(base, 'verified.json');
      const failure = path.join(base, 'failure.json');
      let cached = loadVerifiedCandidate(base, manifest, digest);
      const reused = cached !== null;
      if (!cached && fs.existsSync(failure) && !bool(p.retry)) {
        throw Error('同一输入此前失败，已停止重复试错。诊断：' + failure + '；修复原因后才用 retry=true');
      }
      if (!cached) {
        const { fd, lock } = acquireRunLock(base, bool(p.retry));
        let attempt = '';
        const started = performance.now();
        let phase = 'prepare';
        try {
          attempt = fs.mkdtempSync(path.join(base, 'attempt-'));
          ctx.out.write(
            evidence
              ? '对齐：使用已有字级时间戳并做独立校验\n'
              : segments
                ? '对齐：核对原始分段拼接后逐段对齐\n'
                : autoPlan
                  ? `对齐：长配音自动按 TTS 段落切为 ${autoPlan.chunks.length} 段执行 ${provider} 本地模型对齐，完成后合并并独立校验\n`
                  : `对齐：${provider} 本地模型，完成后独立校验\n`,
          );
          const wav = path.join(attempt, 'voice-16k.wav');
          const textFile = path.join(attempt, 'normalized.txt');
          const scriptPath = path.join(attempt, 'align.py');
          const raw = path.join(attempt, 'align.json');
          const chain = mediaprobe.newToolchain(env);
          const requests = path.join(attempt, 'segments.json');
          if (evidence) {
            fs.copyFileSync(evidence, raw, fs.constants.COPYFILE_EXCL);
            if (sha(raw) !== evidenceSHA) throw Error('字级证据在读取时发生变化');
          }
          if (runner) {
            await chain.decodeAnalysisWAV(audio, wav, 16000, ctx.signal);
            phase = 'model';
            if (autoPlan) {
              await runChunkedAlignment({
                root,
                attempt,
                wav,
                raw,
                scriptPath,
                source,
                provider: provider as 'funasr' | 'mlx',
                model,
                runnerCommand: runner.command,
                env,
                seconds,
                chain,
                chunks: autoPlan.chunks,
                signal: ctx.signal,
              });
            } else {
              await runSingleAlignment({
                root,
                attempt,
                audio,
                wav,
                raw,
                text,
                textFile,
                scriptPath,
                source,
                requests,
                segments,
                provider: provider as 'funasr' | 'mlx',
                model,
                runnerCommand: runner.command,
                env,
                seconds,
                signal: ctx.signal,
              });
            }
          }
          phase = 'build';
          const result = align.build(script, align.loadEvidence(raw), {
            fps,
            existing: align.loadExistingTimeline(existingTimeline),
            adjust: fs.existsSync(adjust) ? align.loadAdjust(adjust) : null,
          });
          const srt = path.join(attempt, 'voice.srt');
          const phrases = path.join(attempt, 'phrase-timeline.json');
          const report = path.join(attempt, 'align-report.json');
          const checkFile = path.join(attempt, 'audio-check.json');
          align.writeSRT(srt, result.cues);
          align.writeJSON(phrases, align.timelineToJSON(result.timeline));
          align.writeJSON(report, align.reportToJSON(result.report));
          if (!result.report.ok) throw Error('朗读单元映射失败：' + report);
          if (segments && (result.report.match_rate !== 1 || result.report.interpolated_tokens !== 0)) {
            throw Error('真实分段必须与终稿完整匹配且没有插值：' + report);
          }
          phase = 'audio_check';
          const options = voicecheck.Defaults;
          const levels = chain.loudness(audio, options.window);
          const [speech, threshold] = voicecheck.speech(levels, options);
          const check = voicecheck.check(readCues(srt), speech, threshold, options);
          voicecheck.writeReportJSON(check, checkFile);
          if (!check.ok) {
            throw Error('独立音频校验未通过：' + (check.problems ?? []).join('；') + '；诊断：' + checkFile);
          }
          if (
            sha(audio) !== inputs.audio ||
            sha(scriptFile) !== inputs.script ||
            (segmentFile && sha(segmentFile) !== segmentsManifestSHA) ||
            (evidence && sha(evidence) !== evidenceSHA)
          ) {
            throw Error('对齐过程中输入发生变化，候选不能发布');
          }
          if (segments) verifyWindowsAlignmentSegments(segments);
          cached = sealVerifiedCandidate({
            base,
            manifest,
            digest,
            inputs,
            attempt,
            seconds: (performance.now() - started) / 1000,
            summary: {
              tokens: result.report.tokens,
              cues: result.cues.length,
              total_frames: result.report.total_frames,
              match_rate: result.report.match_rate,
              ...(autoPlan ? { chunks: autoPlan.chunks.length } : {}),
            },
            paths: { align: raw, srt, phrases, report, audio_check: checkFile },
            extraHashFiles: segments
              ? [requests, ...segments.segments.map((_, index) => path.join(attempt, 'segment-' + index + '.json'))]
              : [],
          });
          ctx.out.write(`对齐及校验完成：${cached.seconds.toFixed(2)} 秒，候选位于 ${attempt}\n`);
        } catch (error) {
          writeJsonFile(failure, {
            phase,
            attempt,
            seconds: (performance.now() - started) / 1000,
            error: (error as Error).message,
          });
          throw Error(
            `对齐失败（${phase}），保留原配音和字幕，不自动重跑。诊断：${failure}；${(error as Error).message}`,
          );
        } finally {
          fs.closeSync(fd);
          fs.unlinkSync(lock);
        }
      } else {
        ctx.out.write('输入与候选摘要一致，复用已通过独立校验的结果，不再启动模型\n');
      }
      if (
        sha(audio) !== inputs.audio ||
        sha(scriptFile) !== inputs.script ||
        (evidence && sha(evidence) !== evidenceSHA)
      ) {
        throw Error('输入已变化，候选不能用于当前制作');
      }
      if (segments) {
        if (sha(segmentFile!) !== segmentsManifestSHA) throw Error('分段清单已变化，候选不能用于当前制作');
        verifyWindowsAlignmentSegments(segments);
      }
      ctx.signal.throwIfAborted();
      let published = false;
      if (bool(p.publish)) {
        publishAlignedCandidate(root, manifest, cached!.paths, legacyWindows);
        published = true;
      }
      return {
        data: {
          verified: true,
          ...cached!.summary,
          paths: cached!.paths,
          elapsed_seconds: (performance.now() - operationStarted) / 1000,
          generation_seconds: cached!.seconds,
          reused,
          published,
          manifest,
        },
      };
    },
  };
}

export function windowsAlignOperation(): Op {
  return alignRunOperation(true);
}
