/**
 * FFmpeg 降采样全流自动帧检操作（media_frame_qc）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as review from '@onset/engine/review';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { currentEnvironment } from './cli';
import { inProject } from './deliverables';
import { defineGroup } from './ops/cli';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['media'],
  summary: '媒体流自动检测与分析',
  description: '针对视频与成片流执行 FFmpeg 降采样全流帧检等底层媒体质量分析操作。',
});

function parseScenesJSON(raw: string): mediaprobe.FrameQCScene[] {
  const text = raw.trim().startsWith('[') ? raw : fs.readFileSync(raw, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('scenes_json 必须是镜头对象数组');
  return parsed.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`scenes_json[${idx}] 必须是对象`);
    const obj = item as Record<string, unknown>;
    const id = obj.id;
    const startFrame = obj.startFrame ?? obj.start_frame;
    const endFrame = obj.endFrame ?? obj.end_frame;
    if (typeof id !== 'string' || !id) throw new Error(`scenes_json[${idx}] 缺少有效的 id`);
    if (typeof startFrame !== 'number' || !Number.isSafeInteger(startFrame) || startFrame < 0) {
      throw new Error(`scenes_json[${idx}] 的 startFrame 必须是非负整数`);
    }
    if (typeof endFrame !== 'number' || !Number.isSafeInteger(endFrame) || endFrame < startFrame) {
      throw new Error(`scenes_json[${idx}] 的 endFrame 必须是大于等于 startFrame 的整数`);
    }
    return { id, startFrame, endFrame };
  });
}

function scenesFromDir(sceneDir: string, rootDir: string, fps: number): mediaprobe.FrameQCScene[] {
  const planned = schedule.plan(sceneDir, inProject(rootDir) ? rootDir : undefined);
  const segments = review.reviewSegments(planned, fps);
  const out: mediaprobe.FrameQCScene[] = [];
  let cursor = 0;
  for (const seg of segments) {
    out.push({ id: seg.id, startFrame: cursor, endFrame: cursor + seg.frames });
    cursor += seg.frames;
  }
  return out;
}

defineOp({
  name: 'media_frame_qc',
  cli: ['media', 'frame-qc'],
  summary: '对视频执行 FFmpeg 降采样全流自动帧检',
  description: `以 FFmpeg 降采样（默认宽 480）单遍扫描视频全流，自动检测以下画面与音轨问题并落盘为 frame-qc.json：

  黑场       blackdetect 定位异常黑场区间
  闪烁与平场 signalstats 逐帧 YMIN/YAVG/YMAX 捕获单帧亮暗闪与空白/平场帧
  边缘贴边   四边窄带（顶/底/左/右）检测高活跃内容顶边贴边与裁切风险
  静止段     freezedetect 区分合理停留（info）与超阈值长静止（>=2x 记 warn，>=4x 记 fail）
  音轨检查   可选 ebur128 真峰值 > -0.1 dBFS 削波告警与 silencedetect 整段/长段静音检测

传入 scenes 目录或 scenes_json 镜头时间表后，每条告警会精确映射到帧号、秒数与镜头 ID。
返回结构化 JSON（含 verdict: pass|info|warn|fail 与 issues[]）。`,
  examples: [
    'media_frame_qc({"video": "production/audio/candidate.mp4", "scenes": "scenes/", "out": "production/review/frame-qc.json"})',
    'media_frame_qc({"video": "final.mp4", "freeze_seconds": 1.2, "check_audio": true})',
  ],
  params: {
    video: { type: 'string', description: '要检测的视频文件路径', required: true, positional: 0 },
    project_root: { type: 'string', description: '项目根目录，缺省为当前目录' },
    scenes: { type: 'string', description: '镜头目录（如 scenes/），自动构建镜头帧范围表以映射镜头 ID' },
    scenes_json: { type: 'string', description: '镜头时间表 JSON 字符串或文件路径（每项含 id/startFrame/endFrame）' },
    out: { type: 'string', description: 'frame-qc.json 输出路径或目录；缺省写到视频同目录的 frame-qc.json' },
    fps: { type: 'number', description: '帧率覆盖值；缺省自动探测或从 frame.md 读取' },
    width: { type: 'integer', description: '降采样扫描宽度（像素）', default: mediaprobe.DefaultFrameQCWidth },
    freeze_seconds: {
      type: 'number',
      description: '静止段基础阈值（秒），>=2x 记 warn',
      default: mediaprobe.DefaultFreezeSeconds,
    },
    check_audio: { type: 'boolean', description: '是否执行音轨 EBU R128 真峰值削波与静音检查', default: true },
    strict: { type: 'boolean', description: 'verdict 为 fail 时以非零状态失败', default: false },
  },
  run: async (p, { out, signal }) => {
    const video = str(p.video);
    const rootDir = str(p.project_root) || '.';
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    let fps = num(p.fps);
    if (!(fps > 0) && fs.existsSync(path.join(rootDir, 'frame.md'))) {
      try {
        fps = scene.canvasOf(rootDir, 'frame.md').fps;
      } catch {
        // 退回由视频流自身探测帧率
      }
    }
    const scenesJson = str(p.scenes_json);
    const sceneDir = str(p.scenes);
    let scenes: mediaprobe.FrameQCScene[] = [];
    if (scenesJson) {
      scenes = parseScenesJSON(scenesJson);
    } else if (sceneDir) {
      let resolvedFps = fps;
      if (!(resolvedFps > 0)) {
        const media = toolchain.probe(video);
        if (media.video) resolvedFps = mediaprobe.videoFPS(media.video);
      }
      if (!(resolvedFps > 0)) throw new Error('解析 scenes 目录需要有效帧率，请传 fps 或提供 frame.md');
      scenes = scenesFromDir(sceneDir, rootDir, resolvedFps);
    }

    const outArg = str(p.out);
    let outPath: string;
    if (!outArg) {
      outPath = path.join(path.dirname(path.resolve(video)), 'frame-qc.json');
    } else if (outArg.endsWith('.json')) {
      outPath = outArg;
    } else {
      outPath = path.join(outArg, 'frame-qc.json');
    }

    const report = await mediaprobe.runFrameQC(toolchain, {
      video,
      fps: fps > 0 ? fps : undefined,
      scenes,
      scanWidth: num(p.width) || mediaprobe.DefaultFrameQCWidth,
      freezeSeconds: num(p.freeze_seconds) || mediaprobe.DefaultFreezeSeconds,
      checkAudio: p.check_audio !== false,
      outPath,
      signal,
    });

    out.write(
      `全流帧检完成：verdict=${report.verdict}（fail ${report.summary.fail_count} / warn ${report.summary.warn_count} / info ${report.summary.info_count}），共扫描 ${report.total_frames} 帧\n`,
    );
    for (const issue of report.issues) {
      const sceneTag = issue.scene_id ? `[${issue.scene_id}] ` : '';
      out.write(`  - [${issue.severity}] ${sceneTag}${issue.message}\n`);
    }
    out.write(`报告：${outPath}\n`);
    if (bool(p.strict) && report.verdict === 'fail') {
      throw new Error(`全流帧检未通过（fail ${report.summary.fail_count} 项），详情见 ${outPath}`);
    }
    return { data: { ...report, report_path: outPath } };
  },
});
