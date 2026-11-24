/**
 * 参考视频拆解与复刻对比操作（recreate_analyze / recreate_compare）。
 */
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as recreate from '@onset/engine/recreate';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { num, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['recreate'],
  summary: '参考视频确定性拆解与同步对比',
  description:
    '确定性探测参考视频切点与镜头时长并写出结构化拆解契约（production/motion-spec.md），同时支持参考与复刻成片的同步画面量化对比。',
});

defineOp({
  name: 'recreate_analyze',
  cli: ['recreate', 'analyze'],
  summary: '确定性拆解参考视频切点、镜头时长与亮度统计，并生成 motion-spec.md',
  description: `使用 mediaprobe 计算连续帧 MAD 突变自动探测硬切点、各镜时长与中点画面统计。
传入 project_root 时自动把结构化拆解契约写出到 production/motion-spec.md（包含保持项、可替换项与镜头时间表）。`,
  examples: ['recreate_analyze({"video": "reference.mp4", "project_root": "."})'],
  params: {
    video: { type: 'string', description: '参考视频路径', required: true, positional: 0 },
    project_root: { type: 'string', description: '可选：项目根目录（传入时写出 production/motion-spec.md）' },
    title: { type: 'string', description: '可选：拆解规范标题' },
    step: { type: 'number', description: '切点探测采样步长（秒），默认 0.5' },
    cut_threshold: { type: 'number', description: '硬切 MAD 判定阈值（0–255），默认 36' },
  },
  run: async (p, { out }) => {
    const tc = mediaprobe.newToolchain(currentEnvironment());
    const analysis = recreate.analyzeReferenceVideo(tc, str(p.video), {
      stepSeconds: num(p.step) > 0 ? num(p.step) : undefined,
      cutThreshold: num(p.cut_threshold) > 0 ? num(p.cut_threshold) : undefined,
    });
    const root = str(p.project_root);
    let specPath: string | undefined;
    if (root) {
      specPath = recreate.writeMotionSpec(root, analysis, str(p.title) || undefined);
      out.write(`已写出参考拆解契约：${specPath}\n`);
    }
    out.write(
      `共识别 ${analysis.shots.length} 个镜头（${analysis.cuts_seconds.length} 处切点），时长 ${analysis.media.duration_seconds.toFixed(2)} 秒。\n`,
    );
    return { data: { analysis, spec_path: specPath } };
  },
});

defineOp({
  name: 'recreate_compare',
  cli: ['recreate', 'compare'],
  summary: '同步量化对比参考视频与复刻成片（MAD、亮度偏移与最差 4 帧）',
  description: '在共同时间轴同步采样比对参考视频与复刻成片的画面差异与时长差，并可选输出最差帧联系表。',
  examples: [
    'recreate_compare({"reference": "reference.mp4", "candidate": "final.mp4", "sheet_out": "production/recreate-diff.png"})',
  ],
  params: {
    reference: { type: 'string', description: '参考视频路径', required: true, positional: 0 },
    candidate: { type: 'string', description: '复刻成片路径', required: true, positional: 1 },
    sheet_out: { type: 'string', description: '可选：最差帧联系表输出 PNG 路径' },
    mad_threshold: { type: 'number', description: '平均 MAD 通过阈值，默认 42' },
  },
  run: async (p, { out }) => {
    const tc = mediaprobe.newToolchain(currentEnvironment());
    const cmp = recreate.compareReferenceAndCandidate(tc, str(p.reference), str(p.candidate), {
      madPassThreshold: num(p.mad_threshold) > 0 ? num(p.mad_threshold) : undefined,
      sheetOut: str(p.sheet_out) || undefined,
    });
    out.write(
      `复刻对比：${cmp.pass ? '通过' : '存在明显差异'} · 平均 MAD=${cmp.mean_mad}、最大 MAD=${cmp.max_mad}、时长差=${cmp.duration_delta}s\n`,
    );
    if (cmp.sheet) out.write(`最差帧联系表：${cmp.sheet}\n`);
    return { data: cmp };
  },
});
