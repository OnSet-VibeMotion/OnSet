/**
 * am film-style：从风格来源里挑画面风格装进项目。一个默认风格（不写 film_style 的镜头用它），
 * 外加个别镜头点名用的额外风格。移植自 internal/cli/filmstyle.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '@am/engine/filmstyle';
import '@am/engine/filmstyle/sources';
import { goQuote } from '@am/engine/gofmt';
import { encodeLine } from '@am/engine/gojson';
import { currentEnvironment, exactArgs, maxArgs, noArgs } from './cli';
import { Command, type Out, ref } from './cobra';
import { padRight } from './canvas';

/** am film-style 帮助里列出的已登记来源。 */
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

/** 管理整片风格：从某个风格来源挑一种，装进项目。 */
export function newFilmStyleCommand(stdout: Out, _stderr?: Out): Command {
  const projectRoot = ref('');
  const filmCmd = new Command({
    use: 'film-style',
    short: '整片风格：从风格来源里挑画面风格，全片默认一种，个别镜头可以换',
    long:
      `整片风格是可选的。项目没有整片风格时，每个镜头自主决定视觉；装了默认风格（use）后，
不写 film_style 的镜头都画成这种风格：镜头提示词把「视觉自由度」换成「整片风格」，渲染器必须
遵守该风格 STYLE.md 的不变量，故事与内容仍来自每个镜头自己的文案。

个别镜头要换一种风格时，先用 add 把那种风格装进项目，再在镜头 scene.json 写
"film_style": "来源/目录名"（口播项目写在分镜计划里，由 am scene cues 抄过去）；
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
各来源的数据是前置资源，在客户端工具准备页下载；本组命令都不联网。`,
  });
  filmCmd.persistentFlags().stringVar(projectRoot, 'project-root', '', '项目根目录，缺省为当前目录');
  const root = (): string => {
    const abs = path.resolve(projectRoot.value || '.');
    if (!fs.existsSync(path.join(abs, 'article-to-motion.conf'))) {
      throw new Error(`${abs} 不是 am 项目（缺少 article-to-motion.conf），用 --project-root 指向项目根目录`);
    }
    return abs;
  };

  const listJSON = ref(false);
  const listSource = ref('');
  const listCmd = new Command({
    use: 'list',
    args: noArgs,
    short: '列出各风格来源里的全部风格',
    long: `按来源、再按分类列出全部风格：标识（来源/目录名）、中文名、英文名、适用题材与说明。
不联网。--source 只列一个来源；--json 输出机器可读的列表。`,
    example: `  am film-style list
  am film-style list --source lemo-opuscar
  am film-style list --json`,
    runE: () => {
      let sources = filmstyle.sources();
      if (listSource.value !== '') {
        const source = filmstyle.sourceByID(listSource.value);
        if (!source) throw new Error(`没有风格来源 ${goQuote(listSource.value)}。已登记：\n${sourceSummary()}`);
        sources = [source];
      }
      if (listJSON.value) {
        const styles = sources.flatMap((source) => source.catalog());
        stdout.write(encodeLine(styles.length ? styles : null, { indent: '  ' }));
        return;
      }
      let current = '';
      let extras = new Set<string>();
      try {
        const dir = root();
        const { manifest, ok } = filmstyle.installed(dir);
        if (ok) current = filmstyle.manifestKey(manifest);
        extras = new Set(filmstyle.installedExtras(dir).map(filmstyle.manifestKey));
      } catch {
        // 不在项目里时照样列出，只是不标当前风格。
      }
      for (const source of sources) {
        stdout.write(`== ${source.id()}  ${source.name()}\n`);
        if (source.gallery() !== '') stdout.write(`   图鉴：${source.gallery()}\n`);
        const catalog = source.catalog();
        for (const category of filmstyle.categories(source.id())) {
          stdout.write(`${category}\n`);
          for (const style of catalog) {
            if (style.category_cn !== category) continue;
            const key = filmstyle.styleKey(style);
            const mark = key === current ? '*' : extras.has(key) ? '+' : ' ';
            const extra = style.tags && style.tags.length > 0 ? '  [' + style.tags.join(', ') + ']' : '';
            stdout.write(` ${mark} ${padRight(filmstyle.styleKey(style), 34)} ${style.cn} ${style.en}${extra}\n`);
            stdout.write(`      适合：${(style.uses ?? []).join(', ')}；${style.summary}\n`);
          }
        }
        stdout.write('\n');
      }
      if (current !== '') stdout.write('* 为本项目的默认风格\n');
      if (extras.size > 0) stdout.write('+ 为本项目装的额外风格（镜头点名用）\n');
    },
  });
  listCmd.flags().boolVar(listJSON, 'json', false, '以 JSON 输出');
  listCmd.flags().stringVar(listSource, 'source', '', '只列一个风格来源');
  filmCmd.addCommand(listCmd);

  const replace = ref(false);
  const useCmd = new Command({
    use: 'use STYLE',
    args: exactArgs(1, 'STYLE'),
    short: '把一种风格装成本项目的默认风格',
    long: `STYLE 写成「来源/目录名」，或者在各来源里唯一的目录名、中文名、英文名。不联网：
来源数据是前置资源，先在客户端工具准备页（「整片风格库」）准备好，这里只装进项目。

项目已有另一种默认风格时默认拒绝：换默认风格会让不写 film_style 的镜头输入指纹变化，
已渲染的都要重渲染。确认要换就加 --replace；还有镜头点名用旧的默认风格时，旧的会留作
额外风格，那些镜头不受影响。同一种风格重复执行是幂等的。`,
    example: `  am film-style use lemo-opuscar/impasto
  am film-style use 油画厚涂
  am film-style use "Swiss Motion Graphics" --replace`,
    runE: (_cmd, args) => {
      const dir = root();
      const style = filmstyle.lookup(args[0]);
      const { manifest: current, ok } = filmstyle.installed(dir);
      const keepReplaced = ok && filmstyle.scenesNaming(dir, filmstyle.manifestKey(current)).length > 0;
      const result = filmstyle.install({ projectDir: dir, style, env: currentEnvironment(), replace: replace.value, keepReplaced });
      reportFilmStyle(stdout, style, result);
      if (result.replaced && keepReplaced) stdout.write(`${result.replaced} 还有镜头点名在用，已留作额外风格\n`);
    },
  });
  useCmd.flags().boolVar(replace, 'replace', false, '允许换掉项目已有的另一种默认风格');
  filmCmd.addCommand(useCmd);

  filmCmd.addCommand(
    new Command({
      use: 'add STYLE',
      args: exactArgs(1, 'STYLE'),
      short: '再装一种风格，给个别镜头点名用',
      long:
        `把一种风格装成额外风格（` +
        filmstyle.ExtraSubdir +
        `/<来源>/<目录名>/），不动默认风格。装好后在镜头 scene.json
写 "film_style": "来源/目录名"（口播项目写在分镜计划里）的镜头才会用它；没点名它的镜头
输入指纹不变。STYLE 的写法与 use 相同。不联网。`,
      example: `  am film-style add lemo-opuscar/chinese-ink
  am film-style add 中国水墨`,
      runE: (_cmd, args) => {
        const dir = root();
        const style = filmstyle.lookup(args[0]);
        const result = filmstyle.install({ projectDir: dir, style, env: currentEnvironment(), as: 'extra' });
        const key = filmstyle.styleKey(style);
        if (result.unchanged) stdout.write(`${filmstyle.styleLabel(style)} 已装在项目里，未改动\n`);
        else stdout.write(`已装上 ${filmstyle.styleLabel(style)}（版本 ${shortCommit(result.manifest.version)}）\n`);
        stdout.write(`要用它的镜头在 scene.json 写 "film_style": "${key}"（口播项目写在分镜计划里，再运行 scene_cues()）\n`);
      },
    }),
  );

  const showJSON = ref(false);
  const showCmd = new Command({
    use: 'show',
    args: noArgs,
    short: '显示本项目的整片风格、哪些镜头在用，以及各风格来源的状态',
    long: `显示本项目装的默认风格与额外风格（来源、名字、版本、目录）、每种风格有哪些镜头在用，
以及各风格来源的数据是否已在客户端工具准备页准备好。不联网、不改任何文件。--json 输出机器可读的同一份信息。`,
    example: `  am film-style show
  am film-style show --json`,
    runE: () => {
      const dir = root();
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
      if (showJSON.value) {
        stdout.write(
          encodeLine(
            {
              installed: isInstalled,
              style: isInstalled ? manifestJSON(manifest) : undefined,
              skill_dir: skillDirPath || undefined,
              extras: extras.length ? extras.map((m) => ({ ...manifestJSON(m), dir: filmstyle.extraDir(dir, filmstyle.manifestKey(m)) })) : undefined,
              scenes: scenes.length ? scenes.map((s) => ({ id: s.id, dir: s.dir, film_style: s.film_style || undefined })) : undefined,
              sources: sources.length ? sources : null,
            },
            { indent: '  ' },
          ),
        );
        return;
      }
      const users = (ids: string[]) => (ids.length === 0 ? '没有镜头' : ids.join('、'));
      if (isInstalled) {
        stdout.write(`默认风格：${manifest.cn} ${manifest.en}（${defaultKey}），版本 ${shortCommit(manifest.version)}\n技能目录：${skillDirPath}\n`);
        if (manifest.legacy) stdout.write('（旧版目录；再运行一次 film_style_use() 会换成新目录）\n');
        if (scenes.length > 0) stdout.write(`  使用：${users([...usedBy(''), ...usedBy(defaultKey)])}\n`);
      } else {
        stdout.write('默认风格：无（不写 film_style 的镜头自主定视觉）。用 film_style_list() 查看可选风格\n');
      }
      for (const m of extras) {
        const key = filmstyle.manifestKey(m);
        stdout.write(`额外风格：${m.cn} ${m.en}（${key}），版本 ${shortCommit(m.version)}\n  使用：${users(usedBy(key))}\n`);
      }
      const none = usedBy(filmstyle.NoFilmStyle);
      if (none.length > 0) stdout.write(`不用整片风格的镜头：${none.join('、')}\n`);
      const installedKeys = new Set([defaultKey, ...extras.map(filmstyle.manifestKey)]);
      for (const s of scenes) {
        if (s.film_style !== '' && s.film_style !== filmstyle.NoFilmStyle && !installedKeys.has(s.film_style)) {
          stdout.write(`注意：镜头 ${s.id} 点名的 ${s.film_style} 没装进项目，渲染会失败；运行 film_style_add({"args": ["${s.film_style}"]})\n`);
        }
      }
      for (const item of sources) {
        const state = item.ready ? '已就绪' : '未准备（在客户端的工具准备页安装）';
        stdout.write(`风格来源 ${item.id}：${state}，${item.location}\n`);
      }
    },
  });
  showCmd.flags().boolVar(showJSON, 'json', false, '以 JSON 输出');
  filmCmd.addCommand(showCmd);

  const force = ref(false);
  const removeCmd = new Command({
    use: 'remove [STYLE]',
    args: maxArgs(1, 'STYLE'),
    short: '去掉一种风格：不写 STYLE 时去掉默认风格',
    long:
      `不写 STYLE 时删除默认风格（.agents/skills/` +
      filmstyle.SkillName +
      `/ 以及旧版目录），不写 film_style 的镜头回到「视觉自由度」，
已渲染的会被判为 Stale；写了 STYLE 时删除那一种（默认或额外风格都行）。

还有镜头在 scene.json 点名用这种风格时默认拒绝并列出它们——删了这些镜头渲染时会找不到风格。
先改掉它们的 film_style（口播项目改分镜计划再运行 am scene cues），或者加 --force。
风格来源的数据不动。`,
    example: `  am film-style remove
  am film-style remove lemo-opuscar/chinese-ink`,
    runE: (_cmd, args) => {
      const dir = root();
      let key = '';
      if (args.length === 1) {
        key = args[0].includes('/') ? args[0] : filmstyle.styleKey(filmstyle.lookup(args[0]));
      } else {
        const { manifest, ok } = filmstyle.installed(dir);
        if (!ok) {
          stdout.write('本项目没有默认风格\n');
          return;
        }
        key = filmstyle.manifestKey(manifest);
      }
      const naming = filmstyle.scenesNaming(dir, key);
      if (naming.length > 0 && !force.value) {
        throw new Error(`还有镜头点名用 ${key}：${naming.join('、')}。先改掉它们的 film_style，或者加 --force`);
      }
      const result = filmstyle.removeStyle(dir, key);
      if (!result.had || !result.manifest) {
        stdout.write(`本项目没有装 ${key}\n`);
        return;
      }
      const label = `${result.manifest.cn} ${result.manifest.en}`;
      if (result.wasDefault) stdout.write(`已去掉默认风格 ${label}；不写 film_style 的镜头回到自主定视觉，已渲染的会被判为 Stale\n`);
      else stdout.write(`已去掉 ${label}（${key}）\n`);
      if (naming.length > 0) stdout.write(`注意：${naming.join('、')} 仍点名用它，渲染前要改掉它们的 film_style\n`);
    },
  });
  removeCmd.flags().boolVar(force, 'force', false, '还有镜头点名用这种风格时也删');
  filmCmd.addCommand(removeCmd);
  return filmCmd;
}

export function reportFilmStyle(stdout: Out, style: filmstyle.Style, result: filmstyle.InstallResult): void {
  if (result.unchanged) stdout.write(`整片风格已是 ${filmstyle.styleLabel(style)}，未改动\n`);
  else if (result.replaced) stdout.write(`整片风格已从 ${result.replaced} 换成 ${filmstyle.styleLabel(style)}；已渲染的镜头会被判为 Stale\n`);
  else stdout.write(`整片风格已设为 ${filmstyle.styleLabel(style)}（版本 ${shortCommit(result.manifest.version)}）\n`);
}
