/**
 * 读出这台电脑上的插件（内置插件加上用户装的第三方插件）与路线用的站。插件装在用户级，对所有项目一样。
 */
import fs from 'node:fs';
import { builtinPlugins } from './builtinplugins';
import { treeDigest } from './digest';
import { checkFiles, readManifest, sourceDir, stationsDir } from './fetch';
import { readInstalled, type InstalledEntry, type LoadedStation } from './installed';
import { toExtra } from './pages';
import type { ExtraStation, FlowID } from './types';

/** 一个装了却读不出来的插件：本机没有、内容被改过、清单写坏了。 */
export interface StationProblem {
  id: string;
  /** 已装插件清单里的那一项；清单本身读不了时为 null。 */
  entry: InstalledEntry | null;
  /** 给人看的原因（已带上插件 id）。 */
  message: string;
}

export interface LoadedStations {
  stations: LoadedStation[];
  problems: StationProblem[];
}

/**
 * 读出全部插件：内置插件在前（按 id），其后是已装的第三方插件（按 id）。读不到、摘要对不上、清单坏了的插件
 * 不返回，原因放进 problems：制作路线、提示词照常工作，界面把问题告诉用户，参与制作的项目开工时报错
 * （brokenParticipants）。
 */
export function loadStations(env: Record<string, string | undefined> = process.env): LoadedStations {
  const out: LoadedStation[] = [];
  const problems: StationProblem[] = [];
  let entries: InstalledEntry[] = [];
  try {
    entries = readInstalled(stationsDir(env)).plugins;
  } catch (err) {
    problems.push({ id: '', entry: null, message: `读不了已装插件的清单：${(err as Error).message}` });
  }
  for (const entry of entries) {
    try {
      const dir = sourceDir(entry, env);
      if (!fs.existsSync(dir)) throw new Error(`本机没有这个插件了（${entry.source}），在设置的「我的插件」里更新或重新添加`);
      if (entry.digest !== '' && treeDigest(dir) !== entry.digest) throw new Error(`内容和添加时不一样了（${dir}），为安全起见不用它；在设置的「我的插件」里更新或重新添加`);
      const manifest = readManifest(dir);
      if (manifest.id !== entry.id) throw new Error(`清单里的 id 是 ${manifest.id}，与记录的 ${entry.id} 不符`);
      checkFiles(dir, manifest);
      out.push({ entry, dir, manifest });
    } catch (err) {
      problems.push({ id: entry.id, entry, message: `第三方插件 ${entry.id}：${(err as Error).message}` });
    }
  }
  return { stations: [...builtinPlugins(), ...out], problems };
}

/** 路线用的站：全部插件（内置与已装的第三方插件）。 */
export function stationExtras(env: Record<string, string | undefined> = process.env): ExtraStation[] {
  return loadStations(env).stations.map((s) => toExtra(s.manifest));
}

/**
 * 读不出来的插件里，哪些参与了这个流程的制作：流程就是它带来的、它顶替了流程里的站、它的站点接进了这条路线
 * （写了 after，或没带流程的插件——它们接在每条路线最后；带流程又没写 after / replaces 的只属于自己的流程，见 joinsFlow）。
 * 凭的是装上时记下的 InstalledRole，不读坏掉的插件目录。参与的要让开工报错；其余只是看得见的提示。
 */
export function brokenParticipants(id: FlowID, problems: readonly StationProblem[], flowStations: readonly string[]): StationProblem[] {
  return problems.filter((p) => {
    if (!p.entry) return false;
    if (id === `x:${p.id}`) return true;
    const r = p.entry.role;
    if (r.replaces !== '') return flowStations.includes(r.replaces);
    return r.nodes && (r.after !== '' || !r.flow);
  });
}
