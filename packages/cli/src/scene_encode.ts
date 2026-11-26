/**
 * 镜头直出操作：scene_encode（直接编码镜头现有 HTML 合成，不调用 AI 模型）。
 */
import os from 'node:os';
import * as config from '@onset/engine/config';
import * as envutil from '@onset/engine/envutil';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { currentEnvironment, validateTolerance } from './cli';
import { num, str } from './ops/common';
import { defineOp } from './ops/op';

defineOp({
  name: 'scene_encode',
  cli: ['scene', 'encode'],
  summary: '直接从镜头现有的 HTML 合成重新出片（不调用模型）',
  description: `用固定版本的 HyperFrames CLI 把镜头目录里已有的 index.html 直接编码成 MP4，不启动 AI 渲染器、不消耗模型 token。

完成后按镜头契约校验画幅、帧率、帧数、无音轨与确定性，并刷新 .onset-render.json 里的产物摘要。`,
  examples: ['scene_encode({"scene": "scenes/scene-001"})'],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    duration_tolerance: {
      type: 'number',
      description: '产物时长与 duration_seconds 的允许偏差（秒），有限非负数',
      default: 0.15,
    },
  },
  run: async (p, { out, signal, unsafe }) => {
    const tolerance = num(p.duration_tolerance);
    validateTolerance(tolerance);
    const cfg = config.load('.', null);
    let s = scene.load(str(p.scene));
    const budget = schedule.renderBudget(os.availableParallelism(), schedule.systemMemory(), os.freemem(), 1, 1);
    s = scene.withRenderWorkers(s, budget.workers);
    await scene.encodeScene(s, cfg, envutil.isUnsafe(unsafe), currentEnvironment(), out, tolerance, signal);
    return { data: { scene: s.id, output: scene.outputPath(s) } };
  },
});
