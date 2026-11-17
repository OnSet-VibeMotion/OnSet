/**
 * 共用组件：跨镜头保持同一个样子的物件（同一个角色、铭牌、图标、图表外壳），由一个渲染器做一次，其余镜头直接引用。
 *
 * 以前跨镜头一致只能靠在每个镜头的 prompt.md 里写同一套要求、由各渲染器各自实现。2026-11 Qwen4Max 一片里
 * 「同事立方体」的铭牌在 7 个镜头里写成了「新同事」「AI 同事」「同事」、空白，3 个镜头给它画了眼睛，返工了两三轮
 * （那部片子返工约占渲染额度的 30%）。各画各的，每个渲染器还要把同一件东西从头设计、自检一遍。
 *
 * 流程：代表镜头的任务书要求渲染器把物件做成独立模块，放在镜头目录的 export/<名字>/（入口文件加 README.md 写清
 * 怎么引用、能传什么参数）；验收后编排用 shared_component_promote 登记，onset 把它复制到项目的
 * production/shared/<名字>/；其余镜头在 scene.json 写 components，onset 渲染前经共享资源（renderassets）
 * 挂进镜头的 shared/<名字>/，内容按摘要进指纹。代码始终出自渲染器，编排只做登记。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goQuote } from '../gofmt';
import type * as renderassets from '../renderassets';

/** 项目里放登记过的共用组件的目录。 */
export const ComponentsDir = 'production/shared';

/** 组件挂进镜头的位置：shared/<名字>/。 */
export const ComponentMountDir = 'shared';

/** 渲染器在镜头里交出组件的位置：export/<名字>/。 */
export const ComponentExportDir = 'export';

/** 组件必须带的说明文件：怎么引用、能传什么参数、长什么样。 */
export const ComponentReadme = 'README.md';

/** 一个组件最多多大：组件是代码与小图，不是素材库。 */
export const MaxComponentBytes = 5 * 1024 * 1024;

const namePattern = /^[a-z][a-z0-9-]{0,39}$/;

/** scene.json 的 components：小写字母开头的短名字，不重复。 */
export function verifyComponentNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || !namePattern.test(name)) throw new Error(`components 的每一项是组件名（小写字母开头，只用小写字母、数字与 -）：${goQuote(String(name))}`);
    if (seen.has(name)) throw new Error(`components 里重复了 ${name}`);
    seen.add(name);
  }
}

/** 项目里组件 name 的目录。 */
export function componentDir(root: string, name: string): string {
  return path.join(root, ComponentsDir, name);
}

/** 镜头要挂的组件；有组件没登记时报错（渲染前、在启动渲染器之前）。 */
export function componentMounts(root: string, names: readonly string[]): renderassets.Mount[] {
  return names.map((name) => {
    const from = componentDir(root, name);
    if (!fs.existsSync(path.join(from, ComponentReadme))) {
      throw new Error(`共用组件 ${name} 还没有登记（${ComponentsDir}/${name}/ 不存在或缺 ${ComponentReadme}）：先让渲染器在代表镜头里做出来，再用 shared_component_promote() 登记`);
    }
    return { from, to: `${ComponentMountDir}/${name}` };
  });
}

/** 有组件的镜头，提示词里的一段；没有组件时为空，旧镜头提示词逐字不变。 */
export function componentSection(names: readonly string[]): string {
  if (names.length === 0) return '';
  return (
    '\n共用组件（强制）：\n' +
    names.map((name) => `- ${ComponentMountDir}/${name}/：先读 ${ComponentMountDir}/${name}/${ComponentReadme}。\n`).join('') +
    '- 这些组件在全片多个镜头里出现，必须是同一个样子：直接引用它们的入口文件、按说明传参，不要自己重画、照着另写一份，也不要改动或复制改写这些文件。\n' +
    '- 组件做不到这个镜头要的样子时，照常完成镜头里其余部分，在最后的交付说明里写清差在哪，交给制作端处理。\n'
  );
}

/** 登记一个组件：把镜头里渲染器交出的目录复制进项目的共用组件目录。 */
export interface PromoteResult {
  name: string;
  /** 登记到哪（项目里的相对路径）。 */
  dir: string;
  files: number;
  bytes: number;
  /** 原来就有、内容不同、被这次换掉了。 */
  replaced: boolean;
  /** 原来就有、内容相同，什么都没做。 */
  unchanged: boolean;
}

/**
 * 把 sceneDir/from（缺省 export/<名字>）复制成 root/production/shared/<名字>/。只收普通文件与目录，不收符号链接，
 * 必须有 README.md 与至少一个 .js / .mjs / .css 文件。已有同名组件且内容不同时要 replace：换掉它会让引用它的镜头
 * 输入变化（标成要重渲染）。先写到临时目录再换位，中途失败不留半个组件。
 */
export function promoteComponent(root: string, sceneDir: string, name: string, from: string, replace: boolean): PromoteResult {
  verifyComponentNames([name]);
  const source = path.resolve(sceneDir, from || path.join(ComponentExportDir, name));
  const scene = fs.realpathSync(sceneDir);
  const real = fs.existsSync(source) ? fs.realpathSync(source) : '';
  const rel = real ? path.relative(scene, real) : '';
  if (!real || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`组件目录要在镜头目录里：${source}`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`组件要是一个目录：${source}`);
  const files = listFiles(real);
  if (!files.includes(ComponentReadme)) throw new Error(`组件目录里要有 ${ComponentReadme}，写清怎么引用、能传什么参数：${source}`);
  if (!files.some((file) => /\.(m?js|css)$/.test(file))) throw new Error(`组件目录里没有 .js / .mjs / .css 文件：${source}`);
  let bytes = 0;
  for (const file of files) bytes += fs.statSync(path.join(real, file)).size;
  if (bytes > MaxComponentBytes) throw new Error(`组件太大（${bytes} 字节，上限 ${MaxComponentBytes}）：大素材放进项目的 assets/，组件里只放代码与小图`);

  const target = componentDir(root, name);
  const existed = fs.existsSync(target);
  if (existed && sameTree(real, files, target)) return { name, dir: path.join(ComponentsDir, name), files: files.length, bytes, replaced: false, unchanged: true };
  if (existed && !replace) throw new Error(`共用组件 ${name} 已经登记过、内容不同；换掉它会让引用它的镜头都要重渲染，确认要换时加 "replace": true`);
  const staging = `${target}.onset-tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
      fs.copyFileSync(path.join(real, file), path.join(staging, file));
    }
    const old = `${target}.onset-old-${process.pid}`;
    if (existed) fs.renameSync(target, old);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staging, target);
    } catch (err) {
      if (existed) fs.renameSync(old, target);
      throw err;
    }
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { name, dir: path.join(ComponentsDir, name), files: files.length, bytes, replaced: existed, unchanged: false };
}

/** 目录里的普通文件（相对路径，排好序）；遇到符号链接与其他特殊文件报错。点开头的跳过（与共享资源同一条规则）。 */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(dir, prefix)).sort()) {
    if (name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = fs.lstatSync(path.join(dir, rel));
    if (info.isSymbolicLink()) throw new Error(`组件里不能有符号链接：${rel}`);
    if (info.isDirectory()) out.push(...listFiles(dir, rel));
    else if (info.isFile()) out.push(rel);
    else throw new Error(`组件里只能有普通文件：${rel}`);
  }
  return out;
}

function sameTree(source: string, files: readonly string[], target: string): boolean {
  let existing: string[];
  try {
    existing = listFiles(target);
  } catch {
    return false;
  }
  if (existing.join('\n') !== files.join('\n')) return false;
  return files.every((file) => fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(target, file))));
}
