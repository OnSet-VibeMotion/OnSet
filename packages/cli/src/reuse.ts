/**
 * run-all 复用已有产物的判定。移植自 internal/cli/reuse.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@am/engine/config';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';

function mtimeNs(file: string): bigint | null {
  try {
    return fs.statSync(file, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

/**
 * reuseDecision 判定一个已有合格产物的镜头是跳过还是标 Stale。
 *
 * 有渲染记录时按输入指纹判定：修改时间会被 touch、git checkout、复制目录
 * 随手改掉，也看不见 frame.md、字幕、技能版本这些不在镜头两份文件里的输入。
 * 记录缺失（老产物）或指纹算不出来时退回修改时间判定，行为与引入指纹前一致。
 */
export function reuseDecision(item: scene.Scene, cfg: Config, env: Record<string, string>): [schedule.Status, string] {
  const record = scene.loadRecord(item);
  if (record !== null) {
    const renderer = item.renderer !== '' ? item.renderer : cfg.renderer;
    let current: scene.Inputs | null = null;
    try {
      const resolved = scene.resolveAllSkills(renderer, item.directory, scene.skillsEnvironment(env, cfg.overlay), item);
      current = scene.fingerprint(item, renderer, resolved);
    } catch {
      current = null;
    }
    if (current !== null) {
      if (current.fingerprint === record.fingerprint) return [schedule.Skipped, '已有合格产物（输入指纹一致）'];
      const changed = scene.changedInputs(current, record).map((name) => (name === 'memory' ? '召回的记忆变了' : name));
      return [schedule.Stale, `输入已变化（${changed.join('、')}），需要显式 --force 重渲染`];
    }
  }
  const output = mtimeNs(scene.outputPath(item));
  if (output === null) return [schedule.Stale, '无法读取产物，需要显式 --force 重渲染'];
  for (const input of [path.join(item.directory, 'scene.json'), path.join(item.directory, 'prompt.md')]) {
    const modified = mtimeNs(input);
    if (modified !== null && modified > output) return [schedule.Stale, '输入比产物新，需要显式 --force 重渲染'];
  }
  return [schedule.Skipped, '已有合格产物'];
}
