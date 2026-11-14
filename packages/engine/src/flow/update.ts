/**
 * 装、去掉、升级第三方插件（用户级，对所有项目生效）的底层：已装插件清单的读写与升级前后的差异。
 * 用户装与升级都先取到暂存处、看过再换上（staging.ts）；installStation 不经确认，只给测试与引擎内部用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchStation, sourceDir, stationsDir } from './fetch';
import { forgetInstalled, readInstalled, recordInstalled, type InstalledEntry } from './installed';
import { experimentalFields, ManifestFile, type Manifest, type ManifestPermissions } from './manifest';
import { parseManifest } from './parse';

export interface StationUpdate {
  id: string;
  /** link: 来源：不用更新，什么都没改。 */
  linked: boolean;
  /** 已装插件清单里原来的一项与更新后的一项（linked 时两者相同）。 */
  before: InstalledEntry;
  after: InstalledEntry;
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

function oldManifest(entry: InstalledEntry, env: Env): Manifest | null {
  try {
    const dir = sourceDir(entry, env);
    // 只用来比差异：原来那一版被改过也照读，读不出来就当没有。
    return parseManifest(fs.readFileSync(path.join(dir, ManifestFile), 'utf8'), { amVersion: 'dev' });
  } catch {
    return null;
  }
}

type Env = Record<string, string | undefined>;

/** 不经确认直接装上一个插件（测试与引擎内部用；用户的添加走 staging.ts）：取来、校验，记进已装插件清单。 */
export function installStation(spec: string, env: Env = process.env, log: (line: string) => void = () => {}): ReturnType<typeof fetchStation> {
  const got = fetchStation(spec, env, log);
  recordInstalled(stationsDir(env), got.entry);
  return got;
}

/** 去掉一个插件：只改已装插件清单，不删存着的插件目录，也不删它在各项目里写过的文件。 */
export function removeStation(id: string, env: Env = process.env): void {
  forgetInstalled(stationsDir(env), id);
}

/** 已装插件清单里的一项；没装为 undefined。清单读不了时抛错。 */
export function installedEntry(id: string, env: Env = process.env): InstalledEntry | undefined {
  return readInstalled(stationsDir(env)).plugins.find((e) => e.id === id);
}

/** 升级前后的差异：before 是已装的那一项，after 与 manifest 是取回的新一版。 */
export function updateDiff(before: InstalledEntry, after: InstalledEntry, manifest: Manifest, env: Env = process.env): StationUpdate {
  const old = oldManifest(before, env);
  const oldPerms = new Set(old ? permissionLines(old.permissions) : []);
  const oldExp = new Set(old ? experimentalFields(old) : []);
  const experimental = experimentalFields(manifest);
  return {
    id: before.id,
    linked: false,
    before,
    after,
    old_version: old?.version ?? '',
    new_version: manifest.version,
    new_permissions: permissionLines(manifest.permissions).filter((l) => !oldPerms.has(l)),
    new_experimental: experimental.filter((f) => !oldExp.has(f)),
    experimental,
    changed: before.commit !== after.commit || before.digest !== after.digest || before.version !== after.version,
  };
}
