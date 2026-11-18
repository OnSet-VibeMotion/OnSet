/**
 * run-all 复用已有产物的判定。
 */
import type { Config } from '@onset/engine/config';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';

/**
 * reuseDecision 判定一个已有合格产物的镜头是跳过还是标 Stale。
 *
 * 有渲染记录时按输入指纹判定：修改时间会被 touch、git checkout、复制目录
 * 随手改掉，也看不见 frame.md、字幕、技能版本这些不在镜头两份文件里的输入。
 * 记录缺失或指纹算不出来时标 Stale：说不清这份产物出自哪些输入，不能替它作保。
 */
export function reuseDecision(item: scene.Scene, cfg: Config, env: Record<string, string>): [schedule.Status, string] {
  const record = scene.loadRecord(item);
  if (record !== null) {
    const renderer = item.renderer !== '' ? item.renderer : cfg.renderer;
    let current: scene.Inputs | null = null;
    let resolved: Record<string, string>;
    try {
      resolved = scene.resolveAllSkills(renderer, item.directory, scene.skillsEnvironment(env, cfg.overlay), item);
      // 按记录自己的版本算：旧记录（输入文件按字节记）照旧按字节比。
      current = scene.fingerprint(item, renderer, resolved, record.schema);
    } catch {
      return [schedule.Stale, '没有可用的渲染记录，说不清产物出自哪些输入，需要显式 --force 重渲染'];
    }
    if (current !== null) {
      if (scene.inputsMatchRecord(item, current, record)) {
        if (record.schema < scene.RenderRecordSchema) upgrade(item, renderer, resolved, record);
        const reason = current.fingerprint === record.fingerprint ? '输入指纹一致' : '影响镜头画面的输入未变';
        return [schedule.Skipped, `已有合格产物（${reason}）`];
      }
      const changed = scene.renderInputChanges(current, record).map((name) => (name === 'memory' ? '召回的记忆变了' : name));
      return [schedule.Stale, `输入已变化（${changed.join('、')}），需要显式 --force 重渲染`];
    }
  }
  return [schedule.Stale, '没有可用的渲染记录，说不清产物出自哪些输入，需要显式 --force 重渲染'];
}

/** 旧记录核对成功才升级，并在同一镜头的写租约内确认产物仍是刚验证的那份。 */
function upgrade(item: scene.Scene, renderer: string, resolved: Record<string, string>, old: scene.RenderRecord): void {
  try {
    const release = scene.acquireSceneLease(item.directory, item.id);
    try {
      const current = scene.loadRecord(item);
      if (current?.schema !== old.schema || current.fingerprint !== old.fingerprint || current.output_sha256 !== old.output_sha256) return;
      scene.upgradeRenderRecord(item, current, scene.fingerprint(item, renderer, resolved));
    } finally {
      release();
    }
  } catch {
    // 记录暂不可写时仍可沿用已经核对过的产物。
  }
}
