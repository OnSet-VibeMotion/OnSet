/**
 * MG 动效风格库（MIT）的 filmstyle.Source 实现。
 *
 * 风格规格内置随包下发，check() 恒就绪、不联网；若用户配置了 ONSET_FILM_STYLE_REFS_DIR
 * 且对应 slug 下存在本地参考帧，poster() 自动复用首张参考帧作为预览图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { GuideFile, listStyleRefs, RefsDirEnv, type Source, type Style, StyleFile } from '../../filmstyle';
import { catalog, entryStyle, find, PinnedVersion, SourceID, SourceName } from './mg';
import { renderAttributionMD, renderSkillMD, renderStyleJSON, renderStyleMD } from './render';

export const mgSource: Source = {
  id: () => SourceID,
  name: () => SourceName,
  gallery: () => '',
  catalog: () => catalog().map(entryStyle),
  location: (env) => (env[RefsDirEnv] ? `内置（参考帧：${env[RefsDirEnv]}）` : '内置（MIT，随片场下发）'),
  check: () => {
    // 全部 15 套风格规格内置随包下发，无需联网下载。
  },
  prepare: async () => {
    // 无需下载前置资源。
  },
  poster(env, slug) {
    const refs = listStyleRefs(slug, { env, verify: false });
    if (refs.available && refs.frames.length > 0) return refs.frames[0].path;
    throw Object.assign(new Error(`风格 ${slug} 未配置本地参考帧海报`), { code: 'ENOENT' });
  },
  fill(dir: string, style: Style): string {
    const entry = find(style.slug);
    if (!entry) throw new Error(`MG 风格库里没有 ${style.slug}`);
    fs.writeFileSync(path.join(dir, StyleFile), renderStyleMD(entry), 'utf8');
    fs.writeFileSync(path.join(dir, GuideFile), renderSkillMD(entry), 'utf8');
    fs.writeFileSync(path.join(dir, 'style.json'), renderStyleJSON(entry), 'utf8');
    fs.writeFileSync(path.join(dir, 'ATTRIBUTION.md'), renderAttributionMD(entry), 'utf8');
    return PinnedVersion;
  },
};
