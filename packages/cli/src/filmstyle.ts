/**
 * 整片风格（film_style_*）：从风格来源里挑画面风格装进项目。一个默认风格（不写 film_style 的镜头用它），
 * 外加个别镜头点名用的额外风格。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '@onset/engine/filmstyle';
import '@onset/engine/plugin';
import { goQuote } from '@onset/engine/gofmt';
import { encodeLine } from '@onset/engine/gojson';
import { currentEnvironment } from './cli';
import {
  collectSourceStatuses,
  manifestJSON,
  reportFilmStyle,
  shortCommit,
  sourceSummary,
  styleMatcher,
  writeCompactStyleList,
  writeFilmStyleShow,
  writeFullStyleList,
} from './filmstyle_format';
import { defineGroup } from './ops/cli';
import { bool, str } from './ops/common';
import { defineOp, type ParamSpec } from './ops/op';
// 已装的第三方插件带来的风格来源由 flow 加载时交给 filmstyle（flow/styles.ts）。
import '@onset/engine/flow';

export { reportFilmStyle, shortCommit, sourceSummary };

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
const styleParam = (description: string, required = true): ParamSpec => ({
  type: 'string',
  description,
  required,
  positional: 0,
});

function projectDir(value: unknown): string {
  const abs = path.resolve(str(value) || '.');
  if (!fs.existsSync(path.join(abs, 'onset.conf'))) {
    throw new Error(`${abs} 不是 onset 项目（缺少 onset.conf），用 project_root 参数指向项目根目录`);
  }
  return abs;
}

defineOp({
  name: 'film_style_list',
  cli: ['film-style', 'list'],
  summary: '列出各风格来源里的全部风格',
  description: `按来源、再按分类列出全部风格：标识（来源/目录名）、中文名、英文名、适用题材与说明。
不联网。source 只列一个来源；compact 为精简目录（每行一条，推荐编排选风格用）；category 或 query 可按分类/关键词筛选；"json": true 输出机器可读的列表。`,
  examples: [
    'film_style_list()',
    'film_style_list({"compact": true})',
    'film_style_list({"query": "水墨", "compact": true})',
    'film_style_list({"source": "lemo-opuscar"})',
    'film_style_list({"json": true})',
  ],
  params: {
    json: { type: 'boolean', description: '以 JSON 输出' },
    compact: { type: 'boolean', description: '精简目录（每行一种风格：标识、名称、适用题材与一句摘要）' },
    source: { type: 'string', description: '只列一个风格来源' },
    category: { type: 'string', description: '按分类名筛选（子串匹配）' },
    query: { type: 'string', description: '按关键词筛选（匹配标识、名称、标签、适用题材与说明）' },
    project_root: projectRootParam,
  },
  run: (p, { out }) => {
    let sources = filmstyle.sources();
    if (str(p.source) !== '') {
      const source = filmstyle.sourceByID(str(p.source));
      if (!source) throw new Error(`没有风格来源 ${goQuote(str(p.source))}。已登记：\n${sourceSummary()}`);
      sources = [source];
    }
    const matches = styleMatcher(str(p.category).trim().toLowerCase(), str(p.query).trim().toLowerCase());
    const styles = sources.flatMap((source) => source.catalog()).filter(matches);
    if (bool(p.compact)) {
      let current = '';
      try {
        const dir = projectDir(p.project_root);
        const { manifest, ok } = filmstyle.installed(dir);
        if (ok) current = filmstyle.manifestKey(manifest);
      } catch {
        /* 不在项目里时省略默认标记。 */
      }
      writeCompactStyleList(out, styles, current);
      return { data: { count: styles.length, default: current || undefined, compact: true } };
    }
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
    writeFullStyleList(out, sources, matches, current, extras);
    return { data: { styles, default: current, extras: [...extras] } };
  },
});

defineOp({
  name: 'film_style_use',
  cli: ['film-style', 'use'],
  summary: '把一种风格装成本项目的默认风格',
  description: `style 写成「来源/目录名」，或者在各来源里唯一的目录名、中文名、英文名。不联网：
来源数据是前置资源，先在客户端工具准备页的「以后可能用到」里准备好，这里只装进项目。

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
    const dir = projectDir(p.project_root);
    const style = filmstyle.lookup(str(p.style));
    const { manifest: current, ok } = filmstyle.installed(dir);
    const keepReplaced = ok && filmstyle.scenesNaming(dir, filmstyle.manifestKey(current)).length > 0;
    const result = filmstyle.install({
      projectDir: dir,
      style,
      env: currentEnvironment(),
      replace: bool(p.replace),
      keepReplaced,
    });
    reportFilmStyle(out, style, result);
    if (result.replaced && keepReplaced) out.write(`${result.replaced} 还有镜头点名在用，已留作额外风格\n`);
    return {
      data: {
        style: filmstyle.styleKey(style),
        unchanged: result.unchanged,
        replaced: result.replaced || undefined,
        version: result.manifest.version,
      },
    };
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
    const dir = projectDir(p.project_root);
    const { manifest, ok: isInstalled } = filmstyle.installed(dir);
    const skillDirPath = isInstalled ? filmstyle.installedDir(dir) : '';
    const sources = collectSourceStatuses(currentEnvironment());
    const extras = filmstyle.installedExtras(dir);
    const scenes = filmstyle.sceneStyles(dir);
    const defaultKey = isInstalled ? filmstyle.manifestKey(manifest) : '';
    const data = {
      installed: isInstalled,
      style: isInstalled ? manifestJSON(manifest) : undefined,
      skill_dir: skillDirPath || undefined,
      extras: extras.length
        ? extras.map((m) => ({ ...manifestJSON(m), dir: filmstyle.extraDir(dir, filmstyle.manifestKey(m)) }))
        : undefined,
      scenes: scenes.length
        ? scenes.map((s) => ({ id: s.id, dir: s.dir, film_style: s.film_style || undefined }))
        : undefined,
      sources: sources.length ? sources : null,
    };
    if (bool(p.json)) {
      out.write(encodeLine(data, { indent: '  ' }));
      return { data };
    }
    writeFilmStyleShow(out, { isInstalled, manifest, defaultKey, skillDirPath, extras, scenes, sources });
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
    `/），不写 film_style 的镜头回到「视觉自由度」，
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
    if (result.wasDefault) {
      out.write(`已去掉默认风格 ${label}；不写 film_style 的镜头回到自主定视觉，已渲染的会被判为 Stale\n`);
    } else {
      out.write(`已去掉 ${label}（${key}）\n`);
    }
    if (naming.length > 0) out.write(`注意：${naming.join('、')} 仍点名用它，渲染前要改掉它们的 film_style\n`);
    return { data: { removed: true, style: key, was_default: result.wasDefault, still_named_by: naming } };
  },
});
