//
// 把一种 anidoodle 风格写进项目（filmstyle.install 给的空临时目录）：
//
//   STYLE.md        中文说明 + 上游风格说明原文
//   SKILL.md        这套风格在 HyperFrames 镜头里怎么用（skill.md.tmpl）
//   anidoodle/      转好的浏览器模块（构建目录里的）与接头 am-anidoodle.js
//   source/         同一批模块的 TypeScript 原文
//   references/     上游的通用说明
//   poster.jpg、LICENSE、NOTICE、ATTRIBUTION.md
//
// am 自己克隆的检出与构建目录内容固定在 commit 上，文件硬链接进项目；用户自己的检出照旧复制。
import fs from 'node:fs';
import path from 'node:path';
import { renderTemplate } from '../../filmstyle/template';
import { exists } from '../../filmstyle/gitlib';
import { missing } from '../../prereq';
import attributionTemplate from './attribution.md.tmpl';
import { EngineSrc, RepoURL, SkillRoot, catalogFile, entryLabel, type Catalog, type Entry } from './anidoodle';
import { ModulesDir, compiledName, posterFile } from './build';
import runtimeScript from './runtime.js.tmpl';
import skillTemplate from './skill.md.tmpl';
import styleTemplate from './style.md.tmpl';

/** 接头在技能目录与镜头目录里的文件名（在 anidoodle/ 下）。 */
export const RuntimeFile = 'am-anidoodle.js';

/** 一份可用的检出与它的构建目录。 */
export interface FillSource {
  dir: string;
  commit: string;
  managed: boolean;
  build: string;
}

/** 放一个文件：link 时先试硬链接，跨磁盘等失败时退回复制。不设只读（理由见 lemo 的 copyPath）。 */
function place(from: string, to: string, link: boolean): void {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`anidoodle 里有符号链接，无法安全搬进项目：${from}`);
  if (!stat.isFile()) throw new Error(`${from} 不是文件`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (link) {
    try {
      fs.linkSync(from, to);
      fs.chmodSync(to, 0o644);
      return;
    } catch {
      // 退回复制。
    }
  }
  fs.writeFileSync(to, fs.readFileSync(from), { mode: 0o644 });
}

function need(file: string, what: string): string {
  if (!exists(file)) throw missing('anidoodle 风格库', `${what}（${file}）不在，重新准备一次风格库`);
  return file;
}

/** 本风格模块的说明行：除帧契约以外的每个模块，标出示范画与笔触工具。 */
function moduleList(entry: Entry): string {
  return entry.modules
    .filter((rel) => rel !== 'canvas-core/core.ts' && rel !== 'canvas-core/film.ts')
    .map((rel) => {
      const role = rel === entry.module ? '示范画' : rel === entry.draw_film ? '示范画「画出来」的影片版' : /Kit\.ts$/.test(rel) ? '笔触工具' : '示范画用到的模块';
      return `- \`anidoodle/${compiledName(rel)}\`（原文 \`source/${rel}\`）：${role}`;
    })
    .join('\n');
}

function templateData(entry: Entry, commit: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Style: {
      Slug: entry.slug,
      ID: entry.id,
      EN: entry.en,
      CN: entry.cn,
      Medium: entry.medium,
      Hero: entry.hero,
      HeroCN: entry.hero_cn,
      Module: 'source/' + entry.module,
      DrawFilm: 'source/' + entry.draw_film,
    },
    Commit: commit,
    Short: commit.slice(0, 12),
    Repo: RepoURL.replace(/\.git$/, ''),
    Modules: moduleList(entry),
    Uses: entry.uses.join('、'),
    ...extra,
  };
}

function write(dir: string, name: string, template: string, data: unknown): void {
  let text: string;
  try {
    text = renderTemplate(name, template, data);
  } catch (err) {
    throw new Error(`生成 ${name}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  fs.writeFileSync(path.join(dir, name), text, { mode: 0o644 });
}

/** 把 entry 写进 dir。 */
export function fill(dir: string, entry: Entry, src: FillSource, catalog: Catalog = catalogFile()): void {
  const link = src.managed;
  const engine = path.join(src.dir, EngineSrc);
  for (const rel of entry.modules) {
    place(need(path.join(src.build, ModulesDir, compiledName(rel)), `${entryLabel(entry)} 转好的 ${rel}`), path.join(dir, ModulesDir, compiledName(rel)), link);
    place(need(path.join(engine, rel), `${entryLabel(entry)} 的 ${rel}`), path.join(dir, 'source', rel), link);
  }
  fs.writeFileSync(path.join(dir, ModulesDir, RuntimeFile), runtimeScript, { mode: 0o644 });
  for (const ref of catalog.references) {
    place(need(path.join(src.dir, ref), ref), path.join(dir, 'references', path.posix.relative(`${SkillRoot}/references`, ref)), link);
  }
  for (const name of ['LICENSE', 'NOTICE']) place(need(path.join(src.dir, name), name), path.join(dir, name), link);
  place(need(posterFile(src.build, entry), `${entryLabel(entry)} 的海报`), path.join(dir, 'poster.jpg'), link);

  let body: string;
  if (entry.doc !== '') {
    body = fs.readFileSync(need(path.join(src.dir, entry.doc), entry.doc), 'utf8').trim();
  } else {
    body = `上游没有为这种风格单独写说明。它的做法写在 \`source/${entry.module}\` 与 \`source/${entry.draw_film}\` 的文件头注释里，先读那两处；介质的一句话描述见上面。`;
  }
  write(dir, 'STYLE.md', styleTemplate, templateData(entry, src.commit, { Body: body }));
  write(dir, 'SKILL.md', skillTemplate, templateData(entry, src.commit));
  write(dir, 'ATTRIBUTION.md', attributionTemplate, templateData(entry, src.commit));
}
