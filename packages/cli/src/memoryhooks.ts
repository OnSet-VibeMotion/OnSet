/**
 * 渲染记忆在命令里的挂钩点（移植自 internal/cli/memory.go 里被其他命令调用的那几个函数）。
 *
 * memory 包还在移植中，这一轮先写成占位：签名照 Go 里调用 memory 的形状，函数什么也不做或返回空。
 * 每处都标了 TODO(memory)，下一轮接上真实的 `@am/engine/memory`。
 */
import type { Config } from '@am/engine/config';
import type { Scene } from '@am/engine/scene';
import type { Out } from './cobra';

/** memory.Finding：事后检查查出的一条问题，check 是校验器 ID。 */
export interface Finding {
  check: string;
  problem: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * newRunID 是一次 am scene run / run-all 调用的批次编号，同一批次的镜头共用，
 * am memory report 按它对比「第一次」与「第二次」。
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

/**
 * attachMemory 在渲染前为镜头召回记忆，并挂上把这次尝试写成经历的回调。
 * 记忆关闭时原样返回，不建记忆库目录。
 */
export function attachMemory(s: Scene, cfg: Config, warn: Out, run: string): Scene {
  // TODO(memory): memory.open(cfg.memory.dir) → store.recallScene(s, {snapshot, budget, renderer, model, explore, exploreSeed: run})
  // → result.attach(s)；探索时向 warn 打印「[id] 记忆探索：…」；挂 afterAttempt 回调调 store.recordAttempt。
  void cfg;
  void warn;
  void run;
  return s;
}

/** am run 开工前先建好记忆库：codex 沙箱只能把已存在的目录加进可写范围。失败时抛错，由调用方只警告。 */
export function openMemoryStore(dir: string): void {
  // TODO(memory): memory.open(dir)
  void dir;
}

/**
 * preferenceBrief 返回追加给编排工具的用户偏好段；记忆关闭时为空。
 * 读不到记忆库只警告：偏好是锦上添花，不能因此挡住整片制作。
 */
export function preferenceBrief(cfg: Config, root: string, warn: Out): string {
  // TODO(memory): memory.openReadOnly(cfg.memory.dir).preferenceBrief(memory.projectName(root), cfg.memory.snapshot)；
  // 出错时向 warn 打印「警告：读取用户偏好失败，本次不带偏好：…」并返回空。
  void cfg;
  void root;
  void warn;
  return '';
}

/**
 * recordCheckFindings 把事后检查（阅读时间、交接、空白帧）查出的问题按镜头写成经历。
 * 记忆关闭、读不到配置或写失败时只警告，不改变检查命令本身的结果。
 */
export function recordCheckFindings(warn: Out, root: string, scenes: readonly Scene[], byScene: ReadonlyMap<string, Finding[]>): void {
  // TODO(memory): byScene 为空直接返回；config.load(root)，记忆关闭时返回；memory.open 失败打印
  // 「警告：检查结果没能写进记忆库：…」；逐镜头 store.recordCheck(s, findings)，失败打印
  // 「警告：镜头 <id> 的检查结果没能写进记忆库：…」。
  void warn;
  void root;
  void scenes;
  void byScene;
}
