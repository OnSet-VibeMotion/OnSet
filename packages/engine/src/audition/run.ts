/** 一场试镜共用一份结果文件，重试也必须等整场任务释放写权。 */
import fs from 'node:fs';
import path from 'node:path';
import { acquireSceneLease, processAlive, readLive, removeLive, writeLive } from '../scene';
import { Dir, type Audition, type Contestant } from './audition';

function runDir(root: string, a: Audition): string {
  if (!/^audition-[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(a.id)) throw new Error('试镜编号不对');
  const dir = fs.realpathSync(path.join(root, Dir, a.id));
  if (!dir.startsWith(fs.realpathSync(root) + path.sep)) throw new Error('试镜目录不在项目内');
  return dir;
}

/** 重试只允许使用这一场冻结的输入，不能指向其他镜头或项目外的目录。 */
export function contestantDirectory(root: string, a: Audition, c: Contestant): string {
  if (!/^[A-FR]$/.test(c.slot)) throw new Error('选手标号不对');
  const dir = runDir(root, a);
  const expected = path.join(dir, c.slot);
  if (fs.realpathSync(path.join(root, c.workdir)) !== expected || fs.realpathSync(expected) !== expected) throw new Error('选手目录与试镜不符');
  return expected;
}

/** 兼容旧版本：旧试镜没有整场标记，但每位正在渲染的选手仍有 live 文件。 */
export function isRunning(root: string, a: Audition): boolean {
  if (hasRunOwner(root, a)) return true;
  return a.contestants.some(c => {
    const own = readLive(contestantDirectory(root, a, c), a.scene_id);
    return !!own && processAlive(own.pid);
  });
}

export function hasRunOwner(root: string, a: Audition): boolean {
  const live = readLive(runDir(root, a), a.id);
  return !!live && processAlive(live.pid);
}

export function acquireRun(root: string, a: Audition): () => void {
  if (isRunning(root, a)) throw new Error('本场试镜仍在运行，请等任务结束后重试');
  const dir = runDir(root, a);
  const release = acquireSceneLease(dir, a.id);
  try {
    writeLive(dir, a.id, { pid: process.pid, renderer: '', started_at: new Date().toISOString() });
  } catch (error) { release(); throw error; }
  return () => { removeLive(dir, a.id); release(); };
}

export function retryContestant(root: string, a: Audition, slot: string): Contestant {
  if (a.verdict || a.adopted || a.exam?.applied) throw new Error('本场试镜已经评判，请新开一场试镜');
  const c = a.contestants.find(c => c.slot === slot);
  if (!c) throw new Error('选手不存在');
  if (c.outcome === 'succeeded') throw new Error('这位选手已有合格产物，无需重试');
  contestantDirectory(root, a, c);
  return c;
}
