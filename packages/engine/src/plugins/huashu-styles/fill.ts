//
// 把一种 huashu 风格写进项目（filmstyle.install 给的空临时目录）：
//
//   STYLE.md        定位、每个镜头都要守的规则 + 上游配方卡原文 + 源码导览（style.md.tmpl）
//   SKILL.md        这套风格在 HyperFrames 镜头里怎么用（skill.md.tmpl）
//   huashu/         引擎（去掉预览播放器）、绘画库、这种风格的字体与 fonts.js、接头与合成模板，镜头里整个拷进去
//   source/<id>.js  上游这种风格的场景原文（只读来学技法）
//   references/     上游的三份通用说明
//   poster.jpg、LICENSE、ATTRIBUTION.md
//
// onset 自己克隆的检出与构建目录内容固定在 commit 上，文件硬链接进项目；用户自己的检出照旧复制。
import fs from 'node:fs';
import path from 'node:path';
import { renderTemplate } from '../../filmstyle/template';
import { exists } from '../../filmstyle/gitlib';
import { missing } from '../../prereq';
import attributionTemplate from './attribution.md.tmpl';
import { EngineDir, FontLicenses, FontsDir, RepoURL, catalogFile, entryLabel, type Catalog, type Entry } from './huashu';
import { EngineOut, RuntimeDir, fontsFile, posterFile } from './build';
import preScript from './pre.js.tmpl';
import runtimeScript from './runtime.js.tmpl';
import skillTemplate from './skill.md.tmpl';
import styleTemplate from './style.md.tmpl';

/** 接头与模板在 huashu/ 下的文件名。 */
export const PreFile = 'onset-huashu-pre.js';
export const RuntimeFile = 'onset-huashu.js';
export const TemplateFile = 'template.html';

/** 镜头自己的场景文件与它注册的名字（模板里写死）。 */
export const SceneFile = 'scene.js';
export const SceneName = 'scene';

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
  if (stat.isSymbolicLink()) throw new Error(`huashu 里有符号链接，无法安全搬进项目：${from}`);
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
  if (!exists(file)) throw missing('花叔艺术动画风格库', `${what}（${file}）不在，重新准备一次风格库`);
  return file;
}

/**
 * 镜头合成的模板：__W__、__H__、__DUR__ 由渲染器换掉，场景写在镜头目录的 scene.js。
 * 加载顺序：软件光栅与场景登记 → 字体表 → 库 → 设好画幅（场景模块初始化时读 STAGE）→ 场景 → 排成一段 → 引擎 → 接 hf-seek。
 */
export function templateHTML(catalog: Pick<Catalog, 'libs'>): string {
  const script = (src: string) => `<script src="${src}"></script>`;
  return [
    '<!doctype html>',
    // 注释里不写占位符本身：渲染器按说明整份替换时会把注释也改掉（盲测反馈）。
    '<!-- 镜头合成模板（片场生成）：拷成镜头目录的 index.html，按风格目录 SKILL.md 换掉画幅与时长的占位符；',
    `     场景写在镜头目录的 ${SceneFile}，注册 SCENES['${SceneName}']。canvas 的 id 必须是 c（引擎按它找画布）。 -->`,
    '<html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;background:#000;overflow:hidden}#main{position:absolute;inset:0}#c{position:absolute;left:0;top:0;width:100%;height:100%}</style>',
    '</head><body>',
    '<div id="main" data-composition-id="main" data-start="0" data-duration="__DUR__" data-width="__W__" data-height="__H__" data-no-timeline>',
    '<canvas id="c" width="__W__" height="__H__"></canvas>',
    '</div>',
    script(`${RuntimeDir}/${PreFile}`),
    '<script>window.FILM_SIZE = [__W__, __H__];</script>',
    script(`${RuntimeDir}/lib/fonts.js`),
    ...catalog.libs.map((rel) => script(`${RuntimeDir}/${rel}`)),
    '<script>U.setStage(__W__, __H__);</script>',
    script(SceneFile),
    `<script>OnsetHuashu.use('${SceneName}', __DUR__);</script>`,
    script(`${RuntimeDir}/transitions.js`),
    script(`${RuntimeDir}/engine.js`),
    script(`${RuntimeDir}/${RuntimeFile}`),
    '</body></html>',
    '',
  ].join('\n');
}

/** 场景源码里第一层定义的名字（两格缩进的 const / let / function）与行号，给 STYLE.md 的源码导览。 */
export function sceneOutline(source: string): string {
  const out: string[] = [];
  source.split('\n').forEach((line, i) => {
    const m = /^ {2}(?:const|let|function)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) out.push(`- \`${m[1]}\`（第 ${i + 1} 行）`);
    // 场景返回的 init / draw：每一帧按什么顺序画（底色、几遍笔触、小物件、描边、光效）全在 draw 里，渲染器最该先读它（盲测反馈）。
    const method = /^ {4}(init|draw)\s*\(/.exec(line);
    if (method) out.push(`- \`${method[1]}\`（第 ${i + 1} 行）${method[1] === 'draw' ? '：每一帧的画法顺序都在这里，先读它' : '：预热缓存'}`);
  });
  const text = out.length === 0 ? '这份场景没有可单独列出的部件，从头读。' : out.join('\n');
  const risky: string[] = [];
  source.split('\n').forEach((line, i) => {
    if (/performance\.now|Date\.now|new Date\(|Math\.random|requestAnimationFrame/.test(line)) risky.push(`第 ${i + 1} 行`);
  });
  if (risky.length === 0) return text;
  // 上游有几处读时钟只是在测耗时，不影响画面；照抄进镜头会被产物校验的确定性扫描拦下。
  return `${text}\n\n注意：${risky.join('、')}读了时钟或用了不带种子的随机数（上游用来测耗时等），抄进本镜头会被渲染后的确定性检查判成失败，不要照抄。`;
}

function templateData(entry: Entry, commit: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Style: {
      Slug: entry.slug,
      ID: entry.id,
      EN: entry.en,
      CN: entry.cn,
      Layer: entry.layer,
      Quality: entry.quality,
      Weakness: entry.weakness,
      Technique: entry.technique,
      Motifs: entry.motifs,
      Scene: entry.scene,
      Card: entry.card,
    },
    LayerNote:
      entry.layer === '时代标本'
        ? '上游样片把这个时代或艺术家的母题做得很突出，直接搬用适合讲历史、致敬、穿越；换到别的题材要从配方里提炼画法、色彩逻辑与动法，为题材重新构图，不要把样片的母题当成风格本身。'
        : '这是一种画法（笔法、材质、光与色的处理），可以盖在任何题材上：讲产品、讲数据、讲故事都行。',
    MakeNote:
      entry.layer === '时代标本'
        ? '这是一种「时代标本」：最适合讲这个时代或这位艺术家相关的题材，换到无关题材时要在 treatment 里写清楚借的是哪几样画法。'
        : '这是一种「画法」：可以盖在任何题材上，讲产品、讲数据、讲故事都行。',
    CJK: entry.cjk,
    Commit: commit,
    Short: commit.slice(0, 12),
    Repo: RepoURL.replace(/\.git$/, ''),
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
  const label = entryLabel(entry);
  const upstream = (rel: string) => need(path.join(src.dir, EngineDir, rel), `${EngineDir}/${rel}`);
  const runtime = path.join(dir, RuntimeDir);
  place(need(path.join(src.build, EngineOut), '改写过的 engine.js'), path.join(runtime, 'engine.js'), link);
  place(upstream('transitions.js'), path.join(runtime, 'transitions.js'), link);
  for (const rel of catalog.libs) place(upstream(rel), path.join(runtime, rel), link);
  place(need(fontsFile(src.build, entry), `${label} 的字体表`), path.join(runtime, 'lib', 'fonts.js'), link);
  for (const name of [...entry.fonts.map((f) => f.file), ...FontLicenses]) place(upstream(`${FontsDir}/${name}`), path.join(runtime, FontsDir, name), link);
  fs.writeFileSync(path.join(runtime, PreFile), preScript, { mode: 0o644 });
  fs.writeFileSync(path.join(runtime, RuntimeFile), runtimeScript, { mode: 0o644 });
  fs.writeFileSync(path.join(runtime, TemplateFile), templateHTML(catalog), { mode: 0o644 });

  const sceneFile = need(path.join(src.dir, entry.scene), `${label} 的场景`);
  place(sceneFile, path.join(dir, 'source', entry.id + '.js'), link);
  for (const ref of catalog.references) place(need(path.join(src.dir, ref), ref), path.join(dir, 'references', path.posix.basename(ref)), link);
  place(need(path.join(src.dir, 'LICENSE'), 'LICENSE'), path.join(dir, 'LICENSE'), link);
  place(need(posterFile(src.build, entry), `${label} 的海报`), path.join(dir, 'poster.jpg'), link);

  const body = fs.readFileSync(need(path.join(src.dir, entry.card), `${label} 的配方卡`), 'utf8').trim();
  const outline = sceneOutline(fs.readFileSync(sceneFile, 'utf8'));
  write(dir, 'STYLE.md', styleTemplate, templateData(entry, src.commit, { Body: body, Outline: outline }));
  write(dir, 'SKILL.md', skillTemplate, templateData(entry, src.commit));
  write(dir, 'ATTRIBUTION.md', attributionTemplate, templateData(entry, src.commit));
}
