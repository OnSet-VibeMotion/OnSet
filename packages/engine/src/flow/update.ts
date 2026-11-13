/**
 * 升级项目里的一个第三方站：按锁文件里记的来源重新取（git 来源的 ref 是分支时会拿到新 commit），
 * 比出版本、commit、新申请的权限与新用到的实验性字段，写回锁文件。link: 来源本来就是本机目录，不用更新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchStation, parseSource, sourceDir } from './fetch';
import { addToProject, readLock, type LockEntry } from './lock';
import { experimentalFields, ManifestFile, type Manifest, type ManifestPermissions } from './manifest';
import { parseManifest } from './parse';

export interface StationUpdate {
  id: string;
  /** link: 来源：不用更新，什么都没改。 */
  linked: boolean;
  /** 锁文件里原来的一项与更新后的一项（linked 时两者相同）。 */
  before: LockEntry;
  after: LockEntry;
  /** 原来那一版的清单版本号；本机已经没有原来那一版（或读不出来）时为空。 */
  old_version: string;
  new_version: string;
  /** 新申请的权限，每项一句（例如「连网：https://api.example.com」）。原来那一版读不出来时列出全部权限。 */
  new_permissions: string[];
  /** 新用到的实验性字段。 */
  new_experimental: string[];
  /** 新一版用到的全部实验性字段。 */
  experimental: string[];
  /** 版本、commit 或内容有没有变。 */
  changed: boolean;
}

/** 权限写成给人看的一句一项。 */
export function permissionLines(p: ManifestPermissions): string[] {
  const out: string[] = [];
  if (p.project) out.push('读项目摘要（镜头、制作路线、发布信息）');
  for (const origin of p.network) out.push(`连网：${origin}`);
  for (const op of p.uses) out.push(`请你确认后调用 am 操作：${op}`);
  return out;
}

function oldManifest(entry: LockEntry, env: Record<string, string | undefined>): Manifest | null {
  try {
    const dir = sourceDir(entry, env);
    // 只用来比差异：原来那一版被改过也照读，读不出来就当没有。
    return parseManifest(fs.readFileSync(path.join(dir, ManifestFile), 'utf8'), { amVersion: 'dev' });
  } catch {
    return null;
  }
}

/** 按锁文件里记的来源重新取这个站并写回锁文件。只改锁文件，不删用户级目录里存的旧版本。 */
export function updateStation(root: string, id: string, env: Record<string, string | undefined> = process.env, log: (line: string) => void = () => {}): StationUpdate {
  const before = readLock(root).stations.find((e) => e.id === id);
  if (!before) throw new Error(`这个项目没有加第三方站 ${id}`);
  if (parseSource(before.source).kind === 'link') {
    return { id, linked: true, before, after: before, old_version: before.version, new_version: before.version, new_permissions: [], new_experimental: [], experimental: [], changed: false };
  }
  const old = oldManifest(before, env);
  const got = fetchStation(before.source, env, log);
  if (got.manifest.id !== id) throw new Error(`来源 ${before.source} 现在的清单 id 是 ${got.manifest.id}，与这个站（${id}）不符；要换站请先去掉再添加`);
  addToProject(root, got.entry);
  const oldPerms = new Set(old ? permissionLines(old.permissions) : []);
  const oldExp = new Set(old ? experimentalFields(old) : []);
  const experimental = experimentalFields(got.manifest);
  return {
    id,
    linked: false,
    before,
    after: got.entry,
    old_version: old?.version ?? '',
    new_version: got.manifest.version,
    new_permissions: permissionLines(got.manifest.permissions).filter((l) => !oldPerms.has(l)),
    new_experimental: experimental.filter((f) => !oldExp.has(f)),
    experimental,
    changed: before.commit !== got.entry.commit || before.digest !== got.entry.digest || before.version !== got.entry.version,
  };
}
