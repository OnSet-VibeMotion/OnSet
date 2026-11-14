import { clip, KindBackgroundTasks, type BackgroundTask, type Event } from './parse';

/** 双向协议里独立运行的子任务。结束后保留编号，迟到的内容不能让它重新变成进行中。 */
export class ActiveTasks {
  private readonly tasks = new Map<string, BackgroundTask & { running: boolean }>();

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  start(id: string, description: string): void {
    if (!id) return;
    const old = this.tasks.get(id);
    this.tasks.set(id, { ...(old?.running ? old : {}), id, description: clip(description) || old?.description || '子任务', running: true });
  }

  finish(id: string): void {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, { ...task, running: false });
  }

  progress(id: string, activity: string): boolean {
    const task = this.tasks.get(id);
    const text = clip(activity);
    if (!task?.running || !text || task.activity === text) return false;
    this.tasks.set(id, { ...task, activity: text });
    return true;
  }

  event(): Event {
    return {
      kind: KindBackgroundTasks,
      background_tasks: [...this.tasks.values()].filter((task) => task.running).map(({ running: _, ...task }) => task),
    };
  }
}
