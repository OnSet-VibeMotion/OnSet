/**
 * run-all 复用已有产物的判定。
 */
import type { Config } from '@am/engine/config';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';

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
    try {
      const resolved = scene.resolveAllSkills(renderer, item.directory, scene.skillsEnvironment(env, cfg.overlay), item);
      // 按记录自己的版本算：旧记录（输入文件按字节记）照旧按字节比。
      current = scene.fingerprint(item, renderer, resolved, record.schema);
    } catch {
      current = null;
    }
    if (current !== null) {
      if (current.fingerprint === record.fingerprint) return [schedule.Skipped, '已有合格产物（输入指纹一致）'];
      // 变了的只有镜头的输入文件、内容其实没变（写法变了、改的是别的镜头的字幕）：照样复用。
      if (scene.inputsMatchRecord(item, current, record)) return [schedule.Skipped, '已有合格产物（输入内容未变，只是文件写法或别的镜头的字幕变了）'];
      const changed = scene.changedInputs(current, record).map((name) => (name === 'memory' ? '召回的记忆变了' : name));
      return [schedule.Stale, `输入已变化（${changed.join('、')}），需要显式 --force 重渲染`];
    }
  }
  return [schedule.Stale, '没有可用的渲染记录，说不清产物出自哪些输入，需要显式 --force 重渲染'];
}
