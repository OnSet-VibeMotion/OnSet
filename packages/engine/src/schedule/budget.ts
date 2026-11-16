import { windowsRenderWorkers, windowsSceneJobs } from '../windowsruntime/performance';
import { chromeMemoryBytes, renderWorkers } from './schedule';

/** Windows 用可用内存预算；Mac 的空闲内存不等于可用内存，沿用物理内存的一半。 */
export function renderBudget(cpus: number, total: number, available: number, configured: number, pending: number, platform: NodeJS.Platform = process.platform): { jobs: number; workers: number } {
  if (platform === 'win32') {
    const jobs = Math.min(Math.max(1, pending), windowsSceneJobs(cpus, total, available, configured));
    return { jobs, workers: windowsRenderWorkers(cpus, total, available, jobs) };
  }
  const cpuLimit = Math.max(1, cpus - 2);
  const memoryLimit = total > 0 ? Math.max(1, Math.floor(total / 2 / chromeMemoryBytes)) : cpuLimit;
  // 至少一镜头一浏览器；仅均分 worker 无法防止过多镜头挤占内存。
  const jobs = Math.max(1, Math.min(configured, pending, cpuLimit, memoryLimit));
  const workers = jobs > 1 ? renderWorkers(cpus, total, jobs) : Math.min(cpuLimit, memoryLimit);
  return { jobs, workers };
}

/** 镜头之间已按 CPU 与内存均分预算；工具入口必须执行它，不能只靠提示词。 */
export function renderBudgetArgs(args: string[], env: Record<string, string | undefined>): string[] {
  const limit = Number(env.ONSET_RENDER_WORKERS ?? '0');
  if (args[0] !== 'render' || !Number.isInteger(limit) || limit < 1 || args.includes('--help') || args.includes('-h')) return args;
  const out: string[] = [];
  let workers = limit;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--workers' || arg.startsWith('--workers=')) {
      const value = arg === '--workers' ? args[++index] : arg.slice('--workers='.length);
      if (value !== 'auto' && (!value || !/^[1-9][0-9]*$/.test(value))) throw new Error('渲染的 --workers 必须是 auto 或正整数');
      if (value !== 'auto') workers = Math.min(workers, Number(value));
    } else out.push(arg);
  }
  return [...out, '--workers', String(workers)];
}

