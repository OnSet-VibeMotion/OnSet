/**
 * inputs_manifest：给原始输入建 SHA-256 清单、之后核对有没有被换掉。
 *
 * 制作提示词要求「对所有原始输入生成 SHA-256，写入 production/input-manifest.json，后续不得静默替换输入」。
 * 以前编排每个项目都现写一个哈希脚本、反复跑（2026-11 片场宣传视频：hash_inputs.py 跑了 34 次，每次连同脚本输出
 * 一起留在四十多万 token 的上下文里）。这里一次调用建好或核对完，输出只给计数与少量变动的路径。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { marshalIndent } from '@onset/engine/gojson';
import { atomicWrite } from '@onset/engine/fsutil';
import { bool, projectRoot, str, strs } from './ops/common';
import { defineGroup } from './ops/cli';
import { defineOp, ParamError } from './ops/op';

/** 清单缺省放在哪（项目里的相对路径）。 */
export const InputManifestFile = 'production/input-manifest.json';

/** 输出里最多列出几条变动，其余只给数目：清单可能有几千个文件。 */
const maxListed = 20;

export interface InputFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface InputManifest {
  schema: 1;
  created: string;
  /** 记录了哪些输入（项目里的相对路径，文件或目录）。 */
  roots: string[];
  file_count: number;
  /** 全部文件「摘要 两个空格 路径」逐行拼起来的摘要：比一眼就知道变没变。 */
  tree_sha256: string;
  files: InputFile[];
}

export interface InputDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * 算 roots（项目里的相对路径）下全部普通文件的摘要，按路径排好序。目录里名字以 . 开头的与 node_modules 跳过
 * （版本库、依赖不是原始输入）；符号链接不跟，记成错误，免得把项目外的东西算进来。
 */
export function hashInputs(root: string, roots: readonly string[], options: { exclude?: string; allowMissing?: boolean } = {}): InputFile[] {
  const files: InputFile[] = [];
  const visit = (rel: string): void => {
    if (rel === options.exclude) return;
    const abs = path.join(root, rel);
    const info = fs.lstatSync(abs);
    if (info.isSymbolicLink()) throw new Error(`原始输入里有符号链接，不跟进去：${rel}`);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        visit(rel === '' ? name : `${rel}/${name}`);
      }
    } else if (info.isFile()) {
      files.push({ path: rel, bytes: info.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') });
    }
  };
  for (const r of roots) {
    const rel = normalize(root, r);
    if (!fs.existsSync(path.join(root, rel))) {
      if (options.allowMissing) continue;
      throw new ParamError(`原始输入不存在：${r}`);
    }
    visit(rel);
  }
  const seen = new Set<string>();
  return files.filter((f) => !seen.has(f.path) && seen.add(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 项目里的相对路径（正斜杠）；跑出项目报错。 */
function normalize(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new ParamError(`原始输入要在项目里：${p}`);
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ParamError(`原始输入不能经过符号链接：${p}`);
  }
  return rel.split(path.sep).join('/');
}

export function treeDigest(files: readonly InputFile[]): string {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(`${f.sha256}  ${f.path}\n`);
  return h.digest('hex');
}

export function diffInputs(before: readonly InputFile[], after: readonly InputFile[]): InputDiff {
  const old = new Map(before.map((f) => [f.path, f.sha256]));
  const now = new Map(after.map((f) => [f.path, f.sha256]));
  return {
    added: [...now.keys()].filter((p) => !old.has(p)),
    removed: [...old.keys()].filter((p) => !now.has(p)),
    changed: [...now.entries()].filter(([p, sha]) => old.has(p) && old.get(p) !== sha).map(([p]) => p),
  };
}

function listed(title: string, paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const shown = paths.slice(0, maxListed).map((p) => `  ${p}\n`).join('');
  return `${title} ${paths.length} 个：\n${shown}${paths.length > maxListed ? `  ……另有 ${paths.length - maxListed} 个\n` : ''}`;
}

defineGroup({
  path: ['inputs'],
  summary: '原始输入',
  description: '原始输入的 SHA-256 清单：开工时记一份，之后核对有没有被换掉。',
});

defineOp({
  name: 'inputs_manifest',
  cli: ['inputs', 'manifest'],
  summary: '给原始输入建 SHA-256 清单，或核对它们有没有被换掉',
  description: `原始输入（用户给的文章、素材目录、源码快照、参考视频……）开工时记一份 SHA-256 清单，之后不得静默替换。
不要自己写哈希脚本：用这个工具，一次调用建好或核对完。

建清单：给 paths（项目里的文件或目录，可以几个），写到 ${InputManifestFile}（out 可改）。目录递归，
名字以 . 开头的与 node_modules 跳过；遇到符号链接报错。已有清单时不覆盖，要换就加 replace。

核对：check 为 true，按清单里记下的 paths 重新算，报告新增、删除、改动的文件，不改清单。
输入确实要换（用户给了新版素材）时，向用户说明后再用 replace 重建，并在变更记录里写明。

输出只给文件数、总摘要与最多 ${maxListed} 条变动；完整清单在文件里，结构化结果里也有全部变动。`,
  examples: [
    'inputs_manifest({"paths": ["production/inputs/source", "article.md"]})',
    '# 之后核对原始输入有没有被换掉',
    'inputs_manifest({"check": true})',
    '# 用户给了新版素材，说明后重建',
    'inputs_manifest({"paths": ["production/inputs/source"], "replace": true})',
  ],
  params: {
    paths: { type: 'strings', description: '原始输入：项目里的文件或目录（建清单时必填；核对时按清单里记下的）' },
    check: { type: 'boolean', description: '只核对，不改清单' },
    replace: { type: 'boolean', description: '已有清单时换成这次的' },
    out: { type: 'string', description: `清单路径，缺省 ${InputManifestFile}`, default: InputManifestFile },
    project_root: projectRoot,
  },
  run: (p, { out }) => {
    const root = path.resolve(str(p.project_root));
    const file = path.join(root, normalize(root, str(p.out) || InputManifestFile));
    const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as InputManifest) : null;
    if (bool(p.check)) {
      if (!existing) throw new ParamError(`还没有输入清单：${path.relative(root, file)}。先用 paths 建一份`);
      const now = hashInputs(root, existing.roots, { exclude: normalize(root, file), allowMissing: true });
      const diff = diffInputs(existing.files, now);
      const same = diff.added.length + diff.removed.length + diff.changed.length === 0;
      out.write(same
        ? `原始输入没有变：${now.length} 个文件，总摘要 ${treeDigest(now)}\n`
        : `原始输入和清单对不上（清单建于 ${existing.created}）：\n` + listed('改动', diff.changed) + listed('新增', diff.added) + listed('删除', diff.removed));
      return { data: { ok: same, file_count: now.length, tree_sha256: treeDigest(now), recorded_tree_sha256: existing.tree_sha256, ...diff } };
    }
    const roots = strs(p.paths);
    if (roots.length === 0) throw new ParamError('建清单要给 paths：原始输入在项目里的文件或目录');
    if (existing && !bool(p.replace)) throw new ParamError(`已经有输入清单：${path.relative(root, file)}。核对用 check；输入确实换了、要重建时加 replace`);
    const files = hashInputs(root, roots, { exclude: normalize(root, file) });
    const manifest: InputManifest = {
      schema: 1,
      created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      roots: roots.map((r) => normalize(root, r)),
      file_count: files.length,
      tree_sha256: treeDigest(files),
      files,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, marshalIndent(manifest) + '\n', 0o644);
    const diff = existing ? diffInputs(existing.files, files) : null;
    out.write(`${existing ? '已重建' : '已建'}输入清单：${path.relative(root, file)}（${files.length} 个文件，总摘要 ${manifest.tree_sha256}）\n` +
      (diff ? listed('相比旧清单改动', diff.changed) + listed('新增', diff.added) + listed('删除', diff.removed) : ''));
    return { data: { file: path.relative(root, file), file_count: files.length, tree_sha256: manifest.tree_sha256, ...(diff ?? {}) } };
  },
});
