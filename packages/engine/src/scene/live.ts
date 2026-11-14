/**
 * 渲染进行中的标记：scene.run 启动渲染器前写 render-<id>.live.json，结束（成败、取消）时删掉。
 *
 * 客户端要知道「这个镜头此刻在渲染」。只看流日志最近有没有写不够：渲染器跑
 * `hyperframes render` 的几分钟里流日志一个字都不写，按静默时长判断会在最该显示进度的时候
 * 把镜头判成「没在渲染」。标记里记的是跑 scene.run 的进程，进程还在就是还在渲染；
 * 进程被强杀来不及删标记时，pid 已经不在，照样判得出来。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LiveRender {
  /** 跑 scene.run 的进程（客户端里是 onset 的执行进程）。 */
  pid: number;
  renderer: string;
  started_at: string;
}

export function liveFile(dir: string, id: string): string {
  return path.join(dir, 'render-' + id + '.live.json');
}

export function writeLive(dir: string, id: string, live: LiveRender): void {
  fs.writeFileSync(liveFile(dir, id), JSON.stringify(live) + '\n');
}

export function removeLive(dir: string, id: string): void {
  try {
    fs.rmSync(liveFile(dir, id), { force: true });
  } catch {
    // 删不掉也不影响渲染结果：读的一方会发现 pid 已经不在。
  }
}

/** 读标记；没有、读不了或内容不对时返回 null。 */
export function readLive(dir: string, id: string): LiveRender | null {
  let body: string;
  try {
    body = fs.readFileSync(liveFile(dir, id), 'utf8');
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(body) as Partial<LiveRender>;
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    return { pid: raw.pid, renderer: typeof raw.renderer === 'string' ? raw.renderer : '', started_at: typeof raw.started_at === 'string' ? raw.started_at : '' };
  } catch {
    return null;
  }
}

/** 进程还在不在。EPERM 说明进程在、只是不归我们管。 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
