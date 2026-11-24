/**
 * 渲染记忆操作的共用辅助函数与外部挂钩（attachMemory、preferenceBrief、recordCheckFindings 等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as audition from '@onset/engine/audition';
import * as config from '@onset/engine/config';
import * as fsutil from '@onset/engine/fsutil';
import { formatG, goTrimSpace } from '@onset/engine/gofmt';
import { marshalIndent } from '@onset/engine/gojson';
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as memory from '@onset/engine/memory';
import * as scene from '@onset/engine/scene';
import { currentEnvironment } from './cli';
import type { Out } from './cobra';
import type { ParamSpec } from './ops/op';

/** memory.Finding：事后检查查出的一条问题，check 是校验器 ID。 */
export type Finding = memory.Finding;

export const jsonParam: ParamSpec = { type: 'boolean', description: '输出 JSON' };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * newRunID 是一次 scene_run / scene_run_all 调用的批次编号，同一批次的镜头共用，
 * memory_report 按它对比「第一次」与「第二次」。
 */
export function newRunID(now = new Date()): string {
  return (
    'run-' +
    now.getUTCFullYear() +
    pad2(now.getUTCMonth() + 1) +
    pad2(now.getUTCDate()) +
    '-' +
    pad2(now.getUTCHours()) +
    pad2(now.getUTCMinutes()) +
    pad2(now.getUTCSeconds())
  );
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function writeReport(file: string, value: unknown): void {
  fsutil.atomicWrite(file, marshalIndent(value) + '\n', 0o644);
}

export function splitList(value: string): string[] {
  const out: string[] = [];
  for (let item of value.split(',')) {
    item = goTrimSpace(item);
    if (item !== '') out.push(item);
  }
  return out;
}

export function loadMemoryConfig(): { cfg: config.Config; store: memory.Store } {
  let cfg: config.Config;
  try {
    cfg = config.load('.', null);
  } catch (err) {
    // 不在项目里（没有 onset.conf）时也能看记忆库：
    // 按 ONSET_MEMORY_DIR 或默认位置打开。项目配置本身有错时照常报错。
    let missing = false;
    try {
      fs.statSync('onset.conf');
    } catch (statErr) {
      missing = (statErr as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!missing) throw err;
    const env = currentEnvironment();
    // 编排与渲染工具照项目配置的写法取环境变量，整理与考试在项目外也能跑。
    cfg = config.newConfig({
      orchestrator: env.ORCHESTRATOR ?? '',
      renderer: env.RENDERER ?? '',
      memory: { enabled: true, dir: env.ONSET_MEMORY_DIR ?? '', recallBudget: config.DefaultMemoryRecallBudget },
    });
    if (cfg.memory.dir === '') cfg.memory.dir = config.defaultMemoryDir(env);
  }
  return { cfg, store: memory.open(cfg.memory.dir) };
}

/**
 * attachMemory 在渲染前为镜头召回记忆，并挂上把这次尝试写成经历的回调。
 * 记忆关闭时原样返回，不建记忆库目录。
 */
export function attachMemory(s: scene.Scene, cfg: config.Config, warn: Out, run: string): scene.Scene {
  if (!cfg.memory.enabled) return s;
  const store = memory.open(cfg.memory.dir);
  const renderer = s.renderer !== '' ? s.renderer : cfg.renderer;
  // 探索是这一批渲染的决定：按批次编号加镜头抽签，同一批里的重试拿到同一份召回。
  let result: memory.RecallResult;
  try {
    result = store.recallScene(s, {
      snapshot: cfg.memory.snapshot,
      budget: cfg.memory.recallBudget,
      renderer,
      model: store.currentModel(renderer, currentEnvironment(), config.rendererModelFor(cfg, renderer)),
      explore: cfg.memory.explore,
      exploreSeed: run,
    });
  } catch (err) {
    throw new Error(`召回记忆：${errorText(err)}`, { cause: err });
  }
  // 参考范例跟着学习关系走：这位渲染工具 + 模型向谁学，就带上谁在同类镜头上被人选中的代码（audition.pickExemplars）。
  const exemplars = audition.pickExemplars(cfg.memory.dir, {
    renderer,
    model: store.currentModel(renderer, currentEnvironment(), config.rendererModelFor(cfg, renderer)),
    features: memory.features(s),
    project: memory.projectName(s.directory),
    sceneID: s.id,
  });
  const attached: scene.Scene = { ...memory.attachRecall(result, s), ...(exemplars ? { exemplars } : {}) };
  const x = result.explored;
  if (x)
    warn.write(
      `[${attached.id}] 记忆探索：这次用 ${x.added} 替换 ${x.dropped}（概率 ${formatG(x.propensity)}，镜头是否过期不受影响）\n`,
    );
  const recorded: scene.Scene = { ...attached, afterAttempt: null };
  return {
    ...attached,
    afterAttempt: (attempt) => {
      try {
        store.recordAttempt(recorded, attempt, { source: memory.SourceRender, run, explored: result.explored });
      } catch (err) {
        warn.write(`警告：镜头 ${attached.id} 的经历没能写进记忆库：${errorText(err)}\n`);
      }
    },
  };
}

/**
 * preferenceBrief 返回追加给编排工具的用户偏好段；记忆关闭时为空。
 * 读不到记忆库只警告：偏好是锦上添花，不能因此挡住整片制作。
 */
export function preferenceBrief(cfg: config.Config, root: string, warn: Out): string {
  if (!cfg.memory.enabled) return '';
  try {
    return memory.openReadOnly(cfg.memory.dir).preferenceBrief(memory.projectName(root), cfg.memory.snapshot).text;
  } catch (err) {
    warn.write(`警告：读取用户偏好失败，本次不带偏好：${errorText(err)}\n`);
    return '';
  }
}

/**
 * recordCheckFindings 把事后检查（阅读时间、交接、空白帧）查出的问题按镜头写成经历。
 * 记忆关闭、读不到配置或写失败时只警告，不改变检查命令本身的结果。
 */
export function recordCheckFindings(
  warn: Out,
  root: string,
  scenes: readonly scene.Scene[],
  byScene: ReadonlyMap<string, Finding[]>,
): void {
  if (byScene.size === 0) return;
  let cfg: config.Config;
  try {
    cfg = config.load(root, null);
  } catch {
    return;
  }
  if (!cfg.memory.enabled) return;
  let store: memory.Store;
  try {
    store = memory.open(cfg.memory.dir);
  } catch (err) {
    warn.write(`警告：检查结果没能写进记忆库：${errorText(err)}\n`);
    return;
  }
  for (const s of scenes) {
    const findings = byScene.get(s.id) ?? [];
    if (findings.length === 0) continue;
    try {
      store.recordCheck(s, findings);
    } catch (err) {
      warn.write(`警告：镜头 ${s.id} 的检查结果没能写进记忆库：${errorText(err)}\n`);
    }
  }
}

/**
 * blankPostCheck 是考试里空白帧的补查：只看第 0 帧。
 * 空白帧经验来自 scene_frames 的 at=0 加 check_blank（第 0 帧当封面），看末帧会把合法的淡出也算进去。
 */
export function blankPostCheck(s: scene.Scene, checks: string[]): Finding[] {
  if (!checks.includes(scene.CheckFramesBlank)) return [];
  let report: mediaprobe.FrameReport;
  try {
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    report = toolchain.extractFramesRegion(scene.outputPath(s), [0], null, path.join(s.directory, 'visual-qc'));
  } catch (err) {
    return [{ check: scene.CheckFramesBlank, problem: '无法补查空白帧：' + errorText(err) }];
  }
  return (report.problems ?? []).map((problem) => ({ check: scene.CheckFramesBlank, problem }));
}

/** 考试作答后的补查：空白帧看产物第 0 帧，阅读时间看作答者交的本镜头清单。 */
export function examPostCheck(s: scene.Scene, checks: string[]): Finding[] {
  return [...blankPostCheck(s, checks), ...memory.readsPostCheck(s, checks)];
}
