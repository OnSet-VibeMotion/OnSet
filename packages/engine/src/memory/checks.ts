import { loadRecord, OutcomeVerificationFailed, type Scene } from '../scene';
import { newEpisode, saveEpisode, SourceCheck, SourceRender, type Episode } from './episode';
import { features } from './features';
import type { Store } from './store';
import { equalStrings, uniqueSorted } from './util';

/** 一条检查发现：校验器 ID 加给人看的说明。 */
export interface Finding {
  check: string;
  problem: string;
  /** 申报或合同不完整，不能把它计为已观察到的视频质量差异。 */
  incomplete?: boolean;
}

/**
 * 把一个镜头的事后检查问题写成经历。
 *
 * 渲染工具、模型、召回的记忆取自这个镜头最近一次正式渲染的经历——问题出在
 * 那次渲染的产物上。同一份产物（输入指纹相同）重复检查出同一组问题时不再重复
 * 记录，否则多跑几遍检查命令就把一类失败的次数刷高了。没有可记的发现时 recorded 为 false
 * （此时 episode 是零值或已有的那段经历）。
 */
export function recordCheck(s: Store, sc: Scene, findings: Finding[]): { episode: Episode; recorded: boolean } {
  if (findings.length === 0) return { episode: newEpisode(), recorded: false };
  const all = s.episodes();
  const episode = newEpisode({ source: SourceCheck, scene_id: sc.id, text: sc.text, outcome: OutcomeVerificationFailed });
  const checks: string[] = [];
  const problems: string[] = [];
  for (const f of findings) {
    checks.push(f.check);
    problems.push(f.problem);
  }
  episode.checks = checks;
  episode.problems = problems;
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.source === SourceRender && e.scene_dir === sc.directory) {
      episode.renderer = e.renderer;
      episode.model = e.model;
      episode.fingerprint = e.fingerprint;
      episode.recalled = e.recalled;
      episode.snapshot = e.snapshot;
      episode.run = e.run;
      break;
    }
  }
  const record = loadRecord(sc);
  if (record !== null) episode.fingerprint = record.fingerprint;
  if (episode.renderer === '') episode.renderer = sc.renderer;
  const unique = uniqueSorted(episode.checks);
  for (const e of all) {
    if (e.source === SourceCheck && e.scene_dir === sc.directory && e.fingerprint === episode.fingerprint && equalStrings(uniqueSorted(e.checks), unique)) {
      return { episode: e, recorded: false };
    }
  }
  try {
    episode.features = features(sc);
  } catch {
    episode.features = null;
  }
  return { episode: saveEpisode(s, sc, episode), recorded: true };
}
