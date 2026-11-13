import fs from 'node:fs';
import path from 'node:path';
import { goExt } from '../../gofmt';
import { missing } from '../../prereq';
import attributionTemplate from './attribution.md.tmpl';
import { RepoURL, entryLabel, type Entry } from './lemo';
import skillTemplate from './skill.md.tmpl';
import { demoUsesCoreAssets, exists, skipInDemo, sortedEntries, type Library } from './library';
import { referencedAssets, sourceTexts, threeClosure } from './select';
import { renderTemplate } from './template';

/**
 * 把 entry 这种风格写进 dir（空的临时目录）：STYLE.md、demo 源码、core/ 工具、
 * demo 实际用到的 three.js 模块与模型，以及生成的 SKILL.md 与 ATTRIBUTION.md。
 * 通用部分（来源记录、换位、新旧目录）由 filmstyle.install 负责。
 */
export function fill(dir: string, entry: Entry, lib: Library): void {
  const source = path.join(lib.dir, 'styles', entry.slug);
  // am 管理的风格库里的文件内容固定（钉在 commit 上），硬链接进项目即可，不占第二份
  // 磁盘；用户自己的检出照旧复制，不去改它文件的权限。
  const place = (from: string, to: string) => copyPath(from, to, lib.managed);
  const copies: { from: string; to: string }[] = [
    { from: path.join(source, 'STYLE.md'), to: 'STYLE.md' },
    { from: path.join(source, 'style.json'), to: 'style.json' },
    { from: path.join(source, 'DEMO.md'), to: 'DEMO.md' },
    { from: path.join(source, 'poster.jpg'), to: 'poster.jpg' },
    { from: path.join(lib.dir, 'LICENSE'), to: 'LICENSE' },
    { from: path.join(source, 'demo'), to: 'demo' },
    { from: path.join(lib.dir, 'core', 'lib.js'), to: 'core/lib.js' },
    { from: path.join(lib.dir, 'core', 'three'), to: 'core/three' },
    { from: path.join(lib.dir, 'core', 'post'), to: 'core/post' },
    { from: path.join(lib.dir, 'core', 'fonts'), to: 'core/fonts' },
  ];
  for (const item of copies) {
    if (!pathExists(item.from)) {
      if (item.to === 'STYLE.md' || item.to === 'core/lib.js') throw new Error(`风格库缺少 ${item.from}`);
      continue; // DEMO.md、海报、demo 等在个别风格上可能没有
    }
    place(item.from, path.join(dir, item.to));
  }
  // 下面两类按 demo 实际引用挑文件，不整棵带：three 的 examples/jsm 有 14 MB，
  // core/assets 有 12 MB 模型，一种风格只用其中几个文件。
  const sources = sourceTexts(dir);
  if (demoUsesCoreAssets(path.join(source, 'demo'))) {
    const assets = path.join(lib.dir, 'core', 'assets');
    if (!exists(assets)) throw missing('风格库的 core/assets', entryLabel(entry) + ' 的 demo 要用');
    for (const rel of referencedAssets(assets, sources)) {
      place(path.join(assets, rel), path.join(dir, 'core', 'assets', rel));
    }
  }
  if (entry.three_js) {
    const three = path.join(lib.dir, 'node_modules', 'three');
    if (!exists(path.join(three, 'build', 'three.module.js'))) throw missing('风格库的 three.js 依赖', entryLabel(entry) + ' 要用');
    const picked = threeClosure(three, sources);
    for (const rel of ['LICENSE', 'package.json', ...picked]) {
      const from = path.join(three, rel);
      if (!exists(from)) continue;
      place(from, path.join(dir, 'node_modules', 'three', rel));
    }
  }
  renderSkill(dir, entry, lib.commit || 'unknown');
}

/** os.Stat 是否成功以外的「不存在」：只有不存在才跳过，其他错误照样让复制去报。 */
function pathExists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

const skipExtensions = new Set(['.mp4', '.wav', '.mp3', '.npy', '.log']);

/**
 * 把文件或目录放进项目：link 为 true 时先试硬链接，跨磁盘等失败时退回复制。
 *
 * 不设只读。试过：渲染器用 cp 把引擎拷进镜头目录时副本继承了只读，它要改副本就得
 * chmod，而安全模式不放行 chmod（实测一次渲染在这上面绕了好几轮）。硬链接被就地
 * 改写的风险由 SKILL.md 的「不要改本目录的文件」与项目里只有 am 写这个目录来兜。
 *
 * 符号链接一律拒绝：指向风格库的链接搬进项目后，项目换一台机器就成了静默失效的空文件。
 * 硬链接没有这个问题——它就是文件本身，项目整体拷走时拷的是真实内容。
 */
export function copyPath(from: string, to: string, link: boolean): void {
  const visit = (file: string, target: string, name: string, stat: fs.Stats, isRoot: boolean) => {
    if (stat.isDirectory()) {
      if (!isRoot && (skipInDemo.has(name) || name.startsWith('out_') || name === '__pycache__')) return;
      fs.mkdirSync(target, { recursive: true });
      for (const entry of sortedEntries(file)) {
        const child = path.join(file, entry.name);
        visit(child, path.join(target, entry.name), entry.name, fs.lstatSync(child), false);
      }
      return;
    }
    if (stat.isSymbolicLink()) throw new Error(`风格库里有符号链接，无法安全搬进项目：${file}`);
    if (!stat.isFile() || name === '.DS_Store' || skipExtensions.has(goExt(name).toLowerCase())) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (link) {
      let linked = false;
      try {
        fs.linkSync(file, target);
        linked = true;
      } catch {
        // 跨磁盘等，退回复制。
      }
      if (linked) {
        // 0644 而不是保留原权限：早先的版本把这些文件设过只读，硬链接共用
        // 同一个 inode，这里顺手改回来。
        fs.chmodSync(target, 0o644);
        return;
      }
    }
    fs.writeFileSync(target, fs.readFileSync(file), { mode: 0o644 });
  };
  visit(from, to, path.basename(from), fs.lstatSync(from), true);
}

interface SkillData {
  Style: Record<string, unknown>;
  Commit: string;
  Short: string;
  Repo: string;
}

// 两份模板随程序下发，静态导入内联进代码（.tmpl 由 vitest 插件与 esbuild 的 text loader 当文本加载）。
function loadTemplates(): { skill: string; attribution: string } {
  return { skill: skillTemplate, attribution: attributionTemplate };
}

/** 生成 SKILL.md 与 ATTRIBUTION.md。模板里的字段名是 Go 的导出名，这里按它们组装数据。 */
export function renderSkill(dir: string, style: Entry, commit: string): void {
  const short = commit.length > 12 ? commit.slice(0, 12) : commit;
  const data: SkillData = {
    Style: {
      Slug: style.slug,
      Num: style.num,
      EN: style.en,
      CN: style.cn,
      CategoryEN: style.category_en,
      CategoryCN: style.category_cn,
      Film: style.film,
      Line: style.line,
      LineCN: style.line_cn,
      Uses: style.uses,
      DemoSeconds: style.demo_seconds,
      ThreeJS: style.three_js,
    },
    Commit: commit,
    Short: short,
    Repo: RepoURL.replace(/\.git$/, ''),
  };
  const { skill, attribution } = loadTemplates();
  for (const [name, text] of [
    ['SKILL.md', skill],
    ['ATTRIBUTION.md', attribution],
  ] as const) {
    let out: string;
    try {
      out = renderTemplate(name, text, data);
    } catch (err) {
      throw new Error(`生成 ${name}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    fs.writeFileSync(path.join(dir, name), out, { mode: 0o644 });
  }
}
