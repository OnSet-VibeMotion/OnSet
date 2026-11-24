import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatFixed, goPathError } from '../gofmt';
import { compareBytes } from '../gojson';
import type { Scene } from '../scene';
import * as scene from '../scene';

/**
 * 列出 root 下所有含 scene.json 的子目录，按目录名升序返回——
 * 这个顺序就是镜头在时间轴上的先后顺序。
 *
 * 单抽出来的理由与 startOffsets 相同：onset dialogue beats 不能走 plan
 * （plan 里的 scene.load 会因为过期的 cast.beats 越界而拒绝加载，而那正是
 * 该命令要修的东西），但它必须与 plan 用同一套顺序，否则镜头起点的累加
 * 就有了第二条路径。顺序规则放这里，两边共用；各自要读什么字段各自决定。
 */
export function sceneDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取镜头目录：${goPathError('open', root, err)}`, { cause: err });
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      fs.statSync(path.join(dir, 'scene.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
    }
    dirs.push(dir);
  }
  return dirs.sort((a, b) => compareBytes(path.basename(a), path.basename(b)));
}

export function plan(root: string, containmentRoot?: string): Scene[] {
  return sceneDirs(root).map((dir) => {
    if (containmentRoot !== undefined) {
      scene.contained(containmentRoot, path.relative(containmentRoot, path.join(dir, 'scene.json')), 'scene.json');
    }
    return scene.load(dir);
  });
}

/**
 * 给出每个镜头在项目全局时间轴上的起点：镜头首尾相接，
 * 第 i 个镜头的起点是它前面所有镜头 duration_seconds 之和。返回的数组与
 * 传入的 scenes 一一对应，顺序即 plan 给出的顺序。
 *
 * 单抽成一个函数是因为这条累加规则有两个方向的使用者：onset dialogue beats
 * 用它把 dialogue.json 的全局台词切成镜头本地节拍，onset validate cast 用它把
 * 镜头本地节拍换算回全局时间做覆盖比对。两处各写一遍 cursor += duration
 * 就是两个基准，正反向一旦漂开，校验通过与否取决于哪一边算错，而不取决
 * 于产物对不对。
 */
export function startOffsets(scenes: readonly Pick<Scene, 'duration_seconds'>[] | null): number[] {
  const list = scenes ?? [];
  const offsets: number[] = new Array(list.length);
  let cursor = 0;
  list.forEach((s, i) => {
    offsets[i] = cursor;
    cursor += s.duration_seconds;
  });
  return offsets;
}

/**
 * 检查一组镜头是否构成一条完整、不重不漏的时间轴。
 *
 * 这条规则本来只写在 PROMPT 里，靠编排 agent 自己复核：
 * 「所有镜头 scene.json 中 duration_seconds 之和应等于最后一条字幕结束时间
 * 减第一条字幕开始时间，误差不超过 0.1 秒」。规则是纯可判定的，却没有任何
 * 机器检查——漏掉一镜或某镜时长写错，要等全部渲染完拼接时才发现，
 * 而那时每一镜都已经烧掉一次完整的 AI CLI 调用。
 *
 * srtSpan 传 0 表示不比对字幕跨度，只检查镜头集合自身（编号唯一、时长有效）。
 */
export function coverageProblems(
  scenes: readonly Pick<Scene, 'id' | 'directory' | 'duration_seconds'>[] | null,
  srtSpan: number,
  tolerance: number,
): string[] {
  const problems: string[] = [];
  if (!scenes || scenes.length === 0) {
    problems.push('没有找到任何镜头');
    return problems;
  }
  const seen = new Map<string, string>();
  let total = 0;
  for (const s of scenes) {
    const previous = seen.get(s.id);
    if (previous !== undefined) {
      problems.push(`镜头编号重复：${s.id} 同时出现在 ${goBase(previous)} 和 ${goBase(s.directory)}`);
      continue;
    }
    seen.set(s.id, s.directory);
    total += s.duration_seconds;
  }
  if (srtSpan > 0 && Math.abs(total - srtSpan) > tolerance) {
    problems.push(
      `镜头总时长与字幕跨度不符：镜头合计 ${formatFixed(total, 3)} 秒，字幕跨度 ${formatFixed(srtSpan, 3)} 秒，相差 ${formatFixed(Math.abs(total - srtSpan), 3)} 秒（容差 ${formatFixed(tolerance, 3)}）`,
    );
  }
  return problems;
}

/** filepath.Base：空串得 "."，去掉末尾的分隔符。 */
function goBase(p: string): string {
  if (p === '') return '.';
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return path.basename(trimmed);
}

/**
 * 返回派发顺序：时长长的镜头先派发，时长相同时保持时间轴顺序。
 *
 * 镜头之间没有依赖，总耗时由最后完成的那个 worker 决定。按时间轴顺序派发时，
 * 排在末尾的长镜头会在其他 worker 都空闲后才开始，独自拖长整批耗时；先派发
 * 长镜头（LPT）让短镜头去填后面的空隙。渲染耗时与帧数大致成正比，时长是
 * 手头最好的估计。报告仍按时间轴顺序输出，与派发顺序无关。
 */
export function dispatchOrder<T extends Pick<Scene, 'duration_seconds'>>(scenes: readonly T[]): T[] {
  // Array.prototype.sort 是稳定排序，对应 sort.SliceStable。
  return [...scenes].sort((a, b) =>
    a.duration_seconds > b.duration_seconds ? -1 : a.duration_seconds < b.duration_seconds ? 1 : 0,
  );
}

/** 单个帧捕获 Chrome 的内存估算，取 HyperFrames auto 的同一口径。 */
export const chromeMemoryBytes = 1536 * 2 ** 20;

/**
 * 给出每个镜头渲染可用的帧捕获 worker 数。
 *
 * HyperFrames 的 --workers auto 为单次渲染独占整机设计（0.8.14 源码）：worker
 * 数取「核数 - 2」「一半系统内存 / 1.5GB」「帧数 / 30」与上限
 * max(6, min(16, 核数/8)) 中的最小值。0.8.225 核对过这几项没变，只多了一道
 * 按 V8 堆大小的上限，只会让 auto 更少，不影响这里的均分。jobs 个镜头同时渲染时这些估算互不知情，
 * 每个都按独占 CPU 和一半内存算，合起来会超订。按 (核数 - 2) / jobs 均分，留两个核
 * 给编码与系统；内存同样按上游的口径（一半内存、每个 Chrome 1.5GB）均分——只分 CPU
 * 的话，16GB 的机器上三个镜头各开 4 个 Chrome 就开始换页，整批一起变慢。
 * memoryBytes 为 0 表示读不到内存大小，只按 CPU 分。jobs 为 1 时返回 0，表示沿用上游的 auto。
 */
export function renderWorkers(cpus: number, memoryBytes: number, jobs: number): number {
  if (jobs <= 1) return 0;
  let workers = Math.trunc((cpus - 2) / jobs);
  if (memoryBytes > 0) {
    workers = Math.min(workers, Math.trunc(Math.floor(memoryBytes / 2 / chromeMemoryBytes) / jobs));
  }
  return Math.max(1, workers);
}

/**
 * 返回物理内存字节数，读不到时返回 0。
 * Go 版在 darwin 读 sysctl hw.memsize、在 linux 读 /proc/meminfo 的 MemTotal，其余平台返回 0；
 * Node 的 os.totalmem() 在这两个平台上取的是同一个值，Windows 也用它，不能把已知内存容量当作未知。
 */
export function systemMemory(): number {
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') return 0;
  try {
    return os.totalmem();
  } catch {
    return 0;
  }
}
