function memoryBudget(total: number, available: number): number {
  return Math.min(total / 2, Math.max(0, available - 2 * 1024 ** 3));
}

/** 设置是并发上限；至少给每个活动镜头留出一个 Chromium 的预算，避免降到一 worker 后仍超额开镜头。 */
export function windowsSceneJobs(cpus: number, total: number, available: number, configured: number): number {
  return Math.max(1, Math.min(configured, Math.max(1, cpus - 2), Math.trunc(memoryBudget(total, available) / (1.5 * 1024 ** 3))));
}

/** Windows 使用当时可用内存，预留 2 GiB 给系统；每个 Chromium 按调度器原有的 1.5 GiB 估算。 */
export function windowsRenderWorkers(cpus: number, total: number, available: number, jobs: number): number {
  const concurrent = Math.max(1, jobs);
  const budget = memoryBudget(total, available);
  return Math.max(1, Math.min(Math.trunc((cpus - 2) / concurrent), Math.trunc(budget / (1.5 * 1024 ** 3) / concurrent)));
}

/** HyperFrames 的画面硬件路径与编码耗时是两件事；原日志保留，只提取最后一次完成汇总。 */
export function windowsRenderMetrics(text: string): { browser_hardware: string; seconds: Record<string, number> } | undefined {
  const line = text.split(/\r?\n/).reverse().find(line => /hardware (?:gpu|cpu|software)/.test(line) && /\bcapture [0-9]/.test(line));
  if (!line) return;
  const hardware = /hardware (gpu|cpu|software)/.exec(line)![1];
  const seconds = Object.fromEntries([...line.matchAll(/\b(compile|extract|audio|probe|setup|capture|encode|assemble) (?:(\d+)h[ ]*)?(?:(\d+)m[ ]*)?([0-9]+(?:\.[0-9]+)?)s/g)].map(match => [match[1], Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4])]));
  return { browser_hardware: hardware, seconds };
}
