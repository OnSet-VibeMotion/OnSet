/**
 * am film-style：从风格来源里挑一种画面风格用于全片。移植自 internal/cli/filmstyle.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '@am/engine/filmstyle';
import '@am/engine/filmstyle/sources';
import { goQuote } from '@am/engine/gofmt';
import { encodeLine } from '@am/engine/gojson';
import { currentEnvironment, exactArgs, noArgs } from './cli';
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
    short: '整片风格：从风格来源里挑一种画面风格用于全片',
    long:
      `整片风格是可选的。项目没有整片风格时，每个镜头自主决定视觉；装了整片风格后，
所有镜头画成同一种风格：镜头提示词把「视觉自由度」换成「整片风格」，渲染器必须
遵守该风格 STYLE.md 的不变量，故事与内容仍来自每个镜头自己的文案。

风格来自风格来源，每种风格的标识是「来源/目录名」；名字在各来源里唯一时也可以只写
目录名、中文名或英文名。已登记的来源：
` +
      sourceSummary() +
      `

装进项目的落在 .agents/skills/` +
      filmstyle.SkillName +
      `/：STYLE.md（不变量）、SKILL.md（怎么用、
技法参考在哪）与 ` +
      filmstyle.ManifestFile +
      `（来源与版本），项目整体拷走也能渲染。
各来源的数据是前置资源，由 am setup 下载；本组命令都不联网。`,
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
      try {
        const { manifest, ok } = filmstyle.installed(root());
        if (ok) current = filmstyle.manifestKey(manifest);
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
            const mark = filmstyle.styleKey(style) === current ? '*' : ' ';
            const extra = style.tags && style.tags.length > 0 ? '  [' + style.tags.join(', ') + ']' : '';
            stdout.write(` ${mark} ${padRight(filmstyle.styleKey(style), 34)} ${style.cn} ${style.en}${extra}\n`);
            stdout.write(`      适合：${(style.uses ?? []).join(', ')}；${style.summary}\n`);
          }
        }
        stdout.write('\n');
      }
      if (current !== '') stdout.write('* 为本项目当前的整片风格\n');
    },
  });
  listCmd.flags().boolVar(listJSON, 'json', false, '以 JSON 输出');
  listCmd.flags().stringVar(listSource, 'source', '', '只列一个风格来源');
  filmCmd.addCommand(listCmd);

  const replace = ref(false);
  const useCmd = new Command({
    use: 'use STYLE',
    args: exactArgs(1, 'STYLE'),
    short: '把一种风格装成本项目的整片风格',
    long: `STYLE 写成「来源/目录名」，或者在各来源里唯一的目录名、中文名、英文名。不联网：
来源数据是前置资源，先运行 am setup 准备好，这里只装进项目。

项目已有另一种整片风格时默认拒绝：换风格会让全部镜头的输入指纹变化，
已渲染的镜头都要重渲染。确认要换就加 --replace。同一种风格重复执行是幂等的。`,
    example: `  am film-style use lemo-opuscar/impasto
  am film-style use 油画厚涂
  am film-style use "Swiss Motion Graphics" --replace`,
    runE: (_cmd, args) => {
      const dir = root();
      const style = filmstyle.lookup(args[0]);
      const result = filmstyle.install({ projectDir: dir, style, env: currentEnvironment(), replace: replace.value });
      reportFilmStyle(stdout, style, result);
    },
  });
  useCmd.flags().boolVar(replace, 'replace', false, '允许换掉项目已有的另一种整片风格');
  filmCmd.addCommand(useCmd);

  const showJSON = ref(false);
  const showCmd = new Command({
    use: 'show',
    args: noArgs,
    short: '显示本项目的整片风格与各风格来源的状态',
    long: `显示本项目装的整片风格（来源、名字、版本、技能目录），以及各风格来源的数据是否已由
am setup 准备好。不联网、不改任何文件。--json 输出机器可读的同一份信息。`,
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
      if (showJSON.value) {
        stdout.write(
          encodeLine(
            {
              installed: isInstalled,
              style: isInstalled ? manifestJSON(manifest) : undefined,
              skill_dir: skillDirPath || undefined,
              sources: sources.length ? sources : null,
            },
            { indent: '  ' },
          ),
        );
        return;
      }
      if (isInstalled) {
        stdout.write(`整片风格：${manifest.cn} ${manifest.en}（${filmstyle.manifestKey(manifest)}），版本 ${shortCommit(manifest.version)}\n技能目录：${skillDirPath}\n`);
        if (manifest.legacy) stdout.write('（旧版目录；再运行一次 am film-style use 会换成新目录）\n');
      } else {
        stdout.write('整片风格：无（各镜头自主定视觉）。用 am film-style list 查看可选风格\n');
      }
      for (const item of sources) {
        const state = item.ready ? '已就绪' : '未准备（运行 am setup）';
        stdout.write(`风格来源 ${item.id}：${state}，${item.location}\n`);
      }
    },
  });
  showCmd.flags().boolVar(showJSON, 'json', false, '以 JSON 输出');
  filmCmd.addCommand(showCmd);

  filmCmd.addCommand(
    new Command({
      use: 'remove',
      args: noArgs,
      short: '去掉本项目的整片风格，回到各镜头自主定视觉',
      long:
        `删除 .agents/skills/` +
        filmstyle.SkillName +
        `/（以及旧版目录）。镜头提示词随之回到「视觉自由度」，
已渲染的镜头输入指纹变化、会被判为 Stale，要重渲染。风格来源的数据不动。`,
      example: '  am film-style remove',
      runE: () => {
        const { manifest, had } = filmstyle.remove(root());
        if (!had) {
          stdout.write('本项目没有整片风格\n');
          return;
        }
        stdout.write(`已去掉整片风格 ${manifest.cn} ${manifest.en}；已渲染的镜头会被判为 Stale\n`);
      },
    }),
  );
  return filmCmd;
}

export function reportFilmStyle(stdout: Out, style: filmstyle.Style, result: filmstyle.InstallResult): void {
  if (result.unchanged) stdout.write(`整片风格已是 ${filmstyle.styleLabel(style)}，未改动\n`);
  else if (result.replaced) stdout.write(`整片风格已从 ${result.replaced} 换成 ${filmstyle.styleLabel(style)}；已渲染的镜头会被判为 Stale\n`);
  else stdout.write(`整片风格已设为 ${filmstyle.styleLabel(style)}（版本 ${shortCommit(result.manifest.version)}）\n`);
}
