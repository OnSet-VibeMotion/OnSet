// scene_seams：镜头都渲染好以后修没接顺的交界，见 @onset/engine/scene 的 seam.ts。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as config from '@onset/engine/config';
import * as envutil from '@onset/engine/envutil';
import { formatFixed } from '@onset/engine/gofmt';
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as review from '@onset/engine/review';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { currentEnvironment, validateTolerance } from './cli';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';

/** 一道交界修完的结果。 */
interface SeamResult {
  from: string;
  to: string;
  /** fixed 修好了；failed 两次都没修成，已恢复原产物；joined 本来就接上了，没动。 */
  status: 'fixed' | 'failed' | 'joined';
  before: number;
  after?: number;
  problems?: string[];
}

defineOp({
  name: 'scene_seams',
  cli: ['scene', 'seams'],
  summary: '修没接顺的镜头交界：让后一个镜头按前一个镜头的真实末帧重做开头',
  description: `镜头都渲染好以后、拼接之前调用。约定了交接（后一镜 timing.enter 写了手法）的交界，
先量前一镜末帧与后一镜首帧的差异；没接顺的，把前一镜的末帧与最后几帧放进后一镜的 seam/ 目录，
让渲染器只改后一镜开头约半秒：第 0 帧就是前一镜的末帧，再顺着它的运动过渡到原来的画面，
之后的画面与末帧不动。

渲染后按帧核对：第 0 帧对得上前一镜末帧、后面的画面没变才算修好；不合格带着原因重试一次，
仍不合格就恢复原来的产物，这道交界留给 concat() 拼接时抹平。修好的镜头照常按原来的输入判断复用，
不会因此被标成要重渲染。

各道交界互不影响（只改开头、末帧不变），按 SCENE_JOBS 并发。all 为 true 时连已经接上的交界也重做开头。`,
  examples: ['scene_seams({"scenes": "scenes/"})', '# 只改开头 10 帧', 'scene_seams({"scenes": "scenes/", "frames": 10})'],
  params: {
    scenes: { type: 'string', description: '镜头根目录', required: true, positional: 0 },
    frames: { type: 'integer', description: '只改开头这么多帧；缺省约半秒', default: 0 },
    all: { type: 'boolean', description: '连已经接上的交界也重做开头' },
    jobs: { type: 'integer', description: '并发上限，取值 1..16；缺省读配置 SCENE_JOBS', default: 0, cliOnly: true },
    duration_tolerance: { type: 'number', description: '产物时长容差（秒）', default: 0.05 },
  },
  run: async (p, { out, signal, unsafe }) => {
    const tolerance = num(p.duration_tolerance);
    validateTolerance(tolerance);
    const cfg = config.load('.', null);
    let jobs = num(p.jobs);
    if (jobs === 0) jobs = cfg.sceneJobs;
    if (jobs < 1 || jobs > 16) throw new Error('jobs 必须为 1..16');
    const env = currentEnvironment();
    const toolchain = mediaprobe.newToolchain(env);
    const scenes = schedule.plan(str(p.scenes));
    const results: SeamResult[] = [];
    const todo: { previous: scene.Scene; next: scene.Scene; before: number }[] = [];
    for (let i = 1; i < scenes.length; i++) {
      const next = scenes[i];
      if ((next.timing?.enter?.device ?? '') === '') continue;
      const previous = scenes[i - 1];
      const prevOut = scene.outputPath(previous);
      const nextOut = scene.outputPath(next);
      if (!fs.existsSync(prevOut) || !fs.existsSync(nextOut)) throw new Error(`${previous.id} 或 ${next.id} 还没有产物：先渲染全部镜头，再修交界`);
      const fps = scene.sceneCanvas(next).fps;
      const before = toolchain.frameDifferenceBetween(prevOut, (toolchain.countFrames(prevOut) - 1) / fps, nextOut, 0);
      if (!bool(p.all) && before < review.HandoffLooseDifference) {
        results.push({ from: previous.id, to: next.id, status: 'joined', before });
        continue;
      }
      todo.push({ previous, next, before });
    }
    for (const r of results) out.write(`${r.from} → ${r.to}：已经接上（差异 ${formatFixed(r.before, 1)}），不动\n`);

    const budget = schedule.renderBudget(os.availableParallelism(), schedule.systemMemory(), os.freemem(), jobs, todo.length);
    jobs = budget.jobs;
    const workers = budget.workers;
    if (todo.length) out.write(`接缝渲染预算：最多 ${jobs} 个镜头，每镜头 ${workers} 个浏览器 worker\n`);

    const fix = async (job: (typeof todo)[number]): Promise<SeamResult> => {
      const { previous, next, before } = job;
      const fps = scene.sceneCanvas(next).fps;
      const total = toolchain.countFrames(scene.outputPath(next));
      const wanted = num(p.frames) > 0 ? num(p.frames) : Math.round(scene.SeamSeconds * fps);
      const frames = Math.max(1, Math.min(wanted, Math.floor(total / 3)));
      out.write(`${previous.id} → ${next.id}：差异 ${formatFixed(before, 1)}，重做 ${next.id} 开头 ${frames} 帧\n`);
      scene.prepareSeam(next, toolchain, scene.outputPath(previous), fps);
      // 两次都没修成时恢复：原产物在 seam/before.mp4，渲染记录另存一份（scene.run 会先删掉它）。
      const record = path.join(next.directory, scene.RecordFile);
      const recordBackup = path.join(next.directory, scene.SeamDir, 'record.json');
      if (fs.existsSync(record)) fs.copyFileSync(record, recordBackup);
      let problems: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        let s: scene.Scene = { ...next, seam: { previous: previous.id, frames } };
        if (workers > 0) s = scene.withRenderWorkers(s, workers);
        if (problems.length > 0) s = scene.withRetryNote(s, problems.join('\n'));
        try {
          await scene.run(s, cfg, envutil.isUnsafe(unsafe), env, out, tolerance, signal);
          const after = toolchain.frameDifferenceBetween(scene.outputPath(previous), (toolchain.countFrames(scene.outputPath(previous)) - 1) / fps, scene.outputPath(next), 0);
          return { from: previous.id, to: next.id, status: 'fixed', before, after };
        } catch (err) {
          if (signal?.aborted) {
            restore(next, record, recordBackup);
            throw err;
          }
          problems = err instanceof scene.VerificationError ? err.problems : [(err as Error).message];
        }
      }
      restore(next, record, recordBackup);
      return { from: previous.id, to: next.id, status: 'failed', before, problems };
    };

    const queue = [...todo];
    const fixed: SeamResult[] = [];
    await Promise.all(
      Array.from({ length: Math.min(jobs, queue.length) }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) fixed.push(await fix(job));
      }),
    );
    for (const r of fixed) {
      if (r.status === 'fixed') out.write(`${r.from} → ${r.to}：修好了（差异 ${formatFixed(r.before, 1)} → ${formatFixed(r.after ?? 0, 1)}）\n`);
      else out.write(`${r.from} → ${r.to}：没修成，已恢复原产物，拼接时会自动抹平\n  - ${(r.problems ?? []).join('\n  - ')}\n`);
    }
    const all = [...results, ...fixed];
    return { data: { seams: all.map((r) => ({ from: r.from, to: r.to, status: r.status, before: r.before, after: r.after, problems: r.problems })) } };
  },
});

/** 把镜头恢复成修之前：产物换回 seam/before.mp4，渲染记录换回另存的那份。 */
function restore(s: scene.Scene, record: string, recordBackup: string): void {
  const before = path.join(s.directory, scene.SeamDir, scene.SeamBefore);
  if (fs.existsSync(before)) fs.copyFileSync(before, scene.outputPath(s));
  if (fs.existsSync(recordBackup)) fs.copyFileSync(recordBackup, record);
}
