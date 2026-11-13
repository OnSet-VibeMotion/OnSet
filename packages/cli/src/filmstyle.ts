/**
 * 整片风格（film_style_*）：从风格来源里挑画面风格装进项目。一个默认风格（不写 film_style 的镜头用它），
 * 外加个别镜头点名用的额外风格。移植自 internal/cli/filmstyle.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '@am/engine/filmstyle';
import '@am/engine/filmstyle/sources';
import { goQuote } from '@am/engine/gofmt';
import { encodeLine } from '@am/engine/gojson';
import { currentEnvironment } from './cli';
import { type Out } from './cobra';
import { padRight } from './canvas';
import { defineGroup } from './ops/cli';
import { bool, str } from './ops/common';
import { defineOp, type ParamSpec } from './ops/op';
import * as flow from '@am/engine/flow';

/** 帮助里列出的已登记来源。 */
export function sourceSummary(): string {
  return filmstyle
    .sources()
    .map((source) => {
      let line = '  ' + source.id() + '  ' + source.name();
      if (source.gallery() !== '') line += '，图鉴 ' + source.gallery();
      return line;
    })
    .join('\n');
}

/** Manifest 写成 JSON 时去掉只在内存里的 legacy（Go 的 json:"-"）。 */
function manifestJSON(m: filmstyle.Manifest): Record<string, unknown> {
  return { source: m.source, slug: m.slug, cn: m.cn, en: m.en, version: m.version, digest: m.digest, installed_at: m.installed_at };
}

export function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}

defineGroup({
  path: ['film-style'],
  summary: '整片风格：从风格来源里挑画面风格，全片默认一种，个别镜头可以换',
  description:
    `整片风格是可选的。项目没有整片风格时，每个镜头自主决定视觉；装了默认风格（film_style_use）后，
不写 film_style 的镜头都画成这种风格：镜头提示词把「视觉自由度」换成「整片风格」，渲染器必须
遵守该风格 STYLE.md 的不变量，故事与内容仍来自每个镜头自己的文案。

个别镜头要换一种风格时，先用 film_style_add 把那种风格装进项目，再在镜头 scene.json 写
"film_style": "来源/目录名"（口播项目写在分镜计划里，由 scene_cues() 抄过去）；
写 "none" 表示这个镜头不用整片风格。相邻镜头风格不同时，分镜计划的 handoff 要写
style_shift，说明画法怎么在画面里换过去。

风格来自风格来源，每种风格的标识是「来源/目录名」；名字在各来源里唯一时也可以只写
目录名、中文名或英文名。已登记的来源：
` +
    sourceSummary() +
    `

默认风格装在 .agents/skills/` +
    filmstyle.SkillName +
    `/，额外风格装在 ` +
    filmstyle.ExtraSubdir +
    `/<来源>/<目录名>/，内容都是 STYLE.md（不变量）、SKILL.md（怎么用、
技法参考在哪）与 ` +
    filmstyle.ManifestFile +
    `（来源与版本），项目整体拷走也能渲染。
各来源的数据是前置资源，在客户端工具准备页下载；这一组工具都不联网。`,
});

const projectRootParam: ParamSpec = { type: 'string', description: '项目根目录，缺省为当前目录' };
const styleParam = (description: string, required = true): ParamSpec => ({ type: 'string', description, required, positional: 0 });

/** 这个项目加的第三方插件带来的风格库也列进来（不是项目时只有内置来源）。 */
function syncPluginStyles(value: unknown): void {
  try {
    flow.syncStyleSources(path.resolve(str(value) || '.'));
  } catch {
    flow.syncStyleSources('');
  }
}

function projectDir(value: unknown): string {
  const abs = path.resolve(str(value) || '.');
  if (!fs.existsSync(path.join(abs, 'article-to-motion.conf'))) {
    throw new Error(`${abs} 不是 am 项目（缺少 article-to-motion.conf），用 project_root 参数指向项目根目录`);
  }
  return abs;
}

defineOp({
  name: 'film_style_list',
  cli: ['film-style', 'list'],
  summary: '列出各风格来源里的全部风格',
  description: `按来源、再按分类列出全部风格：标识（来源/目录名）、中文名、英文名、适用题材与说明。
不联网。source 只列一个来源；"json": true 输出机器可读的列表。`,
  examples: ['film_style_list()', 'film_style_list({"source": "lemo-opuscar"})', 'film_style_list({"json": true})'],
  params: {
    json: { type: 'boolean', description: '以 JSON 输出' },
    source: { type: 'string', description: '只列一个风格来源' },
    project_root: projectRootParam,
  },
  run: (p, { out }) => {
    syncPluginStyles(p.project_root);
    let sources = filmstyle.sources();
    if (str(p.source) !== '') {
      const source = filmstyle.sourceByID(str(p.source));
      if (!source) throw new Error(`没有风格来源 ${goQuote(str(p.source))}。已登记：\n${sourceSummary()}`);
      sources = [source];
    }
    const styles = sources.flatMap((source) => source.catalog());
    if (bool(p.json)) {
      out.write(encodeLine(styles.length ? styles : null, { indent: '  ' }));
      return { data: { styles } };
    }
    let current = '';
    let extras = new Set<string>();
    try {
      const dir = projectDir(p.project_root);
      const { manifest, ok } = filmstyle.installed(dir);
      if (ok) current = filmstyle.manifestKey(manifest);
      extras = new Set(filmstyle.installedExtras(dir).map(filmstyle.manifestKey));
    } catch {
      // 不在项目里时照样列出，只是不标当前风格。
    }
    for (const source of sources) {
      out.write(`== ${source.id()}  ${source.name()}\n`);
      if (source.gallery() !== '') out.write(`   图鉴：${source.gallery()}\n`);
      const catalog = source.catalog();
      for (const category of filmstyle.categories(source.id())) {
        out.write(`${category}\n`);
        for (const style of catalog) {
          if (style.category_cn !== category) continue;
          const key = filmstyle.styleKey(style);
          const mark = key === current ? '*' : extras.has(key) ? '+' : ' ';
          const extra = style.tags && style.tags.length > 0 ? '  [' + style.tags.join(', ') + ']' : '';
          out.write(` ${mark} ${padRight(filmstyle.styleKey(style), 34)} ${style.cn} ${style.en}${extra}\n`);
          out.write(`      适合：${(style.uses ?? []).join(', ')}；${style.summary}\n`);
        }
      }
      out.write('\n');
    }
    if (current !== '') out.write('* 为本项目的默认风格\n');
    if (extras.size > 0) out.write('+ 为本项目装的额外风格（镜头点名用）\n');
    return { data: { styles, default: current, extras: [...extras] } };
  },
});

defineOp({
  name: 'film_style_use',
  cli: ['film-style', 'use'],
  summary: '把一种风格装成本项目的默认风格',
  description: `style 写成「来源/目录名」，或者在各来源里唯一的目录名、中文名、英文名。不联网：
来源数据是前置资源，先在客户端工具准备页（「整片风格库」）准备好，这里只装进项目。

项目已有另一种默认风格时默认拒绝：换默认风格会让不写 film_style 的镜头输入指纹变化，
已渲染的都要重渲染。确认要换就加 "replace": true；还有镜头点名用旧的默认风格时，旧的会留作
额外风格，那些镜头不受影响。同一种风格重复执行是幂等的。`,
  examples: [
    'film_style_use({"style": "lemo-opuscar/impasto"})',
    'film_style_use({"style": "油画厚涂"})',
    'film_style_use({"style": "Swiss Motion Graphics", "replace": true})',
  ],
  params: {
    style: styleParam('风格：来源/目录名，或唯一的目录名、中文名、英文名'),
    replace: { type: 'boolean', description: '允许换掉项目已有的另一种默认风格' },
    project_root: projectRootParam,
  },
  run: (p, { out }) => {
    syncPluginStyles(p.project_root);
    const dir = projectDir(p.project_root);
    const style = filmstyle.lookup(str(p.style));
    const { manifest: current, ok } = filmstyle.installed(dir);
    const keepReplaced = ok && filmstyle.scenesNaming(dir, filmstyle.manifestKey(current)).length > 0;
    const result = filmstyle.install({ projectDir: dir, style, env: currentEnvironment(), replace: bool(p.replace), keepReplaced });
    reportFilmStyle(out, style, result);
    if (result.replaced && keepReplaced) out.write(`${result.replaced} 还有镜头点名在用，已留作额外风格\n`);
    return { data: { style: filmstyle.styleKey(style), unchanged: result.unchanged, replaced: result.replaced || undefined, version: result.manifest.version } };
  },
});

defineOp({
  name: 'film_style_add',
  cli: ['film-style', 'add'],
  summary: '再装一种风格，给个别镜头点名用',
  description:
    `把一种风格装成额外风格（` +
    filmstyle.ExtraSubdir +
    `/<来源>/<目录名>/），不动默认风格。装好后在镜头 scene.json
写 "film_style": "来源/目录名"（口播项目写在分镜计划里）的镜头才会用它；没点名它的镜头
输入指纹不变。style 的写法与 film_style_use 相同。不联网。`,
  examples: ['film_style_add({"style": "lemo-opuscar/chinese-ink"})', 'film_style_add({"style": "中国水墨"})'],
  params: {
    style: styleParam('风格：来源/目录名，或唯一的目录名、中文名、英文名'),
    project_root: projectRootParam,
  },
  run: (p, { out }) => {
    syncPluginStyles(p.project_root);
    const dir = projectDir(p.project_root);
    const style = filmstyle.lookup(str(p.style));
    const result = filmstyle.install({ projectDir: dir, style, env: currentEnvironment(), as: 'extra' });
    const key = filmstyle.styleKey(style);
    if (result.unchanged) out.write(`${filmstyle.styleLabel(style)} 已装在项目里，未改动\n`);
    else out.write(`已装上 ${filmstyle.styleLabel(style)}（版本 ${shortCommit(result.manifest.version)}）\n`);
    out.write(`要用它的镜头在 scene.json 写 "film_style": "${key}"（口播项目写在分镜计划里，再运行 scene_cues()）\n`);
    return { data: { style: key, unchanged: result.unchanged, version: result.manifest.version } };
  },
});

defineOp({
  name: 'film_style_show',
  cli: ['film-style', 'show'],
  summary: '显示本项目的整片风格、哪些镜头在用，以及各风格来源的状态',
  description: `显示本项目装的默认风格与额外风格（来源、名字、版本、目录）、每种风格有哪些镜头在用，
以及各风格来源的数据是否已在客户端工具准备页准备好。不联网、不改任何文件。"json": true 输出机器可读的同一份信息。`,
  examples: ['film_style_show()', 'film_style_show({"json": true})'],
  params: {
    json: { type: 'boolean', description: '以 JSON 输出' },
    project_root: projectRootParam,
  },
  run: (p, { out }) => {
    syncPluginStyles(p.project_root);
    const dir = projectDir(p.project_root);
    const { manifest, ok: isInstalled } = filmstyle.installed(dir);
    const env = currentEnvironment();
    const skillDirPath = isInstalled ? filmstyle.installedDir(dir) : '';
    const sources = filmstyle.sources().map((source) => {
      let ready = true;
      let problem = '';
      try {
        source.check(env);
      } catch (err) {
        ready = false;
        problem = (err as Error).message;
      }
      return { id: source.id(), name: source.name(), location: source.location(env), ready, problem: problem || undefined };
    });
    const extras = filmstyle.installedExtras(dir);
    const scenes = filmstyle.sceneStyles(dir);
    const usedBy = (value: string) => scenes.filter((s) => s.film_style === value).map((s) => s.id);
    const defaultKey = isInstalled ? filmstyle.manifestKey(manifest) : '';
    const data = {
      installed: isInstalled,
      style: isInstalled ? manifestJSON(manifest) : undefined,
      skill_dir: skillDirPath || undefined,
      extras: extras.length ? extras.map((m) => ({ ...manifestJSON(m), dir: filmstyle.extraDir(dir, filmstyle.manifestKey(m)) })) : undefined,
      scenes: scenes.length ? scenes.map((s) => ({ id: s.id, dir: s.dir, film_style: s.film_style || undefined })) : undefined,
      sources: sources.length ? sources : null,
    };
    if (bool(p.json)) {
      out.write(encodeLine(data, { indent: '  ' }));
      return { data };
    }
    const users = (ids: string[]) => (ids.length === 0 ? '没有镜头' : ids.join('、'));
    if (isInstalled) {
      out.write(`默认风格：${manifest.cn} ${manifest.en}（${defaultKey}），版本 ${shortCommit(manifest.version)}\n技能目录：${skillDirPath}\n`);
      if (manifest.legacy) out.write('（旧版目录；再运行一次 film_style_use() 会换成新目录）\n');
      if (scenes.length > 0) out.write(`  使用：${users([...usedBy(''), ...usedBy(defaultKey)])}\n`);
    } else {
      out.write('默认风格：无（不写 film_style 的镜头自主定视觉）。用 film_style_list() 查看可选风格\n');
    }
    for (const m of extras) {
      const key = filmstyle.manifestKey(m);
      out.write(`额外风格：${m.cn} ${m.en}（${key}），版本 ${shortCommit(m.version)}\n  使用：${users(usedBy(key))}\n`);
    }
    const none = usedBy(filmstyle.NoFilmStyle);
    if (none.length > 0) out.write(`不用整片风格的镜头：${none.join('、')}\n`);
    const installedKeys = new Set([defaultKey, ...extras.map(filmstyle.manifestKey)]);
    for (const s of scenes) {
      if (s.film_style !== '' && s.film_style !== filmstyle.NoFilmStyle && !installedKeys.has(s.film_style)) {
        out.write(`注意：镜头 ${s.id} 点名的 ${s.film_style} 没装进项目，渲染会失败；运行 film_style_add({"style": "${s.film_style}"})\n`);
      }
    }
    for (const item of sources) {
      const state = item.ready ? '已就绪' : '未准备（在客户端的工具准备页安装）';
      out.write(`风格来源 ${item.id}：${state}，${item.location}\n`);
    }
    return { data };
  },
});

defineOp({
  name: 'film_style_remove',
  cli: ['film-style', 'remove'],
  summary: '去掉一种风格：不写 style 时去掉默认风格',
  description:
    `不写 style 时删除默认风格（.agents/skills/` +
    filmstyle.SkillName +
    `/ 以及旧版目录），不写 film_style 的镜头回到「视觉自由度」，
已渲染的会被判为 Stale；写了 style 时删除那一种（默认或额外风格都行）。

还有镜头在 scene.json 点名用这种风格时默认拒绝并列出它们——删了这些镜头渲染时会找不到风格。
先改掉它们的 film_style（口播项目改分镜计划再运行 scene_cues()），或者加 "force": true。
风格来源的数据不动。`,
  examples: ['film_style_remove()', 'film_style_remove({"style": "lemo-opuscar/chinese-ink"})'],
  params: {
    style: styleParam('要去掉的风格，缺省为默认风格', false),
    force: { type: 'boolean', description: '还有镜头点名用这种风格时也删' },
    project_root: projectRootParam,
  },
  run: (p, { out }) => {
    syncPluginStyles(p.project_root);
    const dir = projectDir(p.project_root);
    const arg = str(p.style);
    let key = '';
    if (arg !== '') {
      key = arg.includes('/') ? arg : filmstyle.styleKey(filmstyle.lookup(arg));
    } else {
      const { manifest, ok } = filmstyle.installed(dir);
      if (!ok) {
        out.write('本项目没有默认风格\n');
        return { data: { removed: false } };
      }
      key = filmstyle.manifestKey(manifest);
    }
    const naming = filmstyle.scenesNaming(dir, key);
    if (naming.length > 0 && !bool(p.force)) {
      throw new Error(`还有镜头点名用 ${key}：${naming.join('、')}。先改掉它们的 film_style，或者加 "force": true`);
    }
    const result = filmstyle.removeStyle(dir, key);
    if (!result.had || !result.manifest) {
      out.write(`本项目没有装 ${key}\n`);
      return { data: { removed: false, style: key } };
    }
    const label = `${result.manifest.cn} ${result.manifest.en}`;
    if (result.wasDefault) out.write(`已去掉默认风格 ${label}；不写 film_style 的镜头回到自主定视觉，已渲染的会被判为 Stale\n`);
    else out.write(`已去掉 ${label}（${key}）\n`);
    if (naming.length > 0) out.write(`注意：${naming.join('、')} 仍点名用它，渲染前要改掉它们的 film_style\n`);
    return { data: { removed: true, style: key, was_default: result.wasDefault, still_named_by: naming } };
  },
});

export function reportFilmStyle(stdout: Out, style: filmstyle.Style, result: filmstyle.InstallResult): void {
  if (result.unchanged) stdout.write(`整片风格已是 ${filmstyle.styleLabel(style)}，未改动\n`);
  else if (result.replaced) stdout.write(`整片风格已从 ${result.replaced} 换成 ${filmstyle.styleLabel(style)}；已渲染的镜头会被判为 Stale\n`);
  else stdout.write(`整片风格已设为 ${filmstyle.styleLabel(style)}（版本 ${shortCommit(result.manifest.version)}）\n`);
}
