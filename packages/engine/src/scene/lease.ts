import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { marshal } from '../gojson';
import { readLive } from './live';

export class SceneBusyError extends Error {}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** 单镜头租约。每次只删除自己的文件，死亡进程的记录不会阻止恢复。 */
export function acquireSceneLease(directory: string, id: string): () => void {
  const live = readLive(directory, id);
  if (live && alive(live.pid)) throw new SceneBusyError(`镜头 ${id} 已在渲染，请等待现有任务完成`);
  const leases = path.join(directory, '.onset-render-leases');
  fs.mkdirSync(leases, { recursive: true });
  const own = path.join(leases, crypto.randomUUID() + '.json');
  // 先独占创建（wx：撞名就失败，不碰别人的文件），再写内容。写到一半失败（例如磁盘满）时删掉这个刚建的文件：
  // 留下空的或截断的租约，以后每次取租约都会因为读不懂它而判「镜头忙」，磁盘恢复了也渲染不了。
  const fd = fs.openSync(own, 'wx');
  try {
    fs.writeFileSync(fd, marshal({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(own, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  const release = () => { fs.rmSync(own, { force: true }); };
  try {
    // 两个调用竞争时，后创建者必然看见先创建者；同时看见对方则都退出，避免重复写产物。
    for (const name of fs.readdirSync(leases)) {
      const file = path.join(leases, name);
      if (file === own || !name.endsWith('.json')) continue;
      let record: { pid?: number };
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new SceneBusyError(`镜头 ${id} 的渲染租约尚未就绪，请检查现有任务`); }
      if (!Number.isInteger(record.pid) || record.pid! <= 0 || alive(record.pid!)) {
        throw new SceneBusyError(`镜头 ${id} 已有渲染任务，本次不会重复启动`);
      }
    }
    return release;
  } catch (error) { release(); throw error; }
}
