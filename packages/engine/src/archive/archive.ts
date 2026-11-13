// 移植自 internal/archive/archive.go。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../envutil';
import { compareBytes, marshalIndent, sortedKeys } from '../gojson';

export interface Plan {
  repository: string;
  mainRef: string;
  mainCommit: string;
  sourceRef: string;
  sourceCommit: string;
  destination: string;
  candidates: string[];
  shared: string[];
  ignored: string[];
}

/** strings.TrimSpace（Unicode 空白，不含 U+FEFF）。 */
function trimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isGoSpace(s.charCodeAt(start))) start++;
  while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** unicode.IsSpace。 */
function isGoSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

const errnoText: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EEXIST: 'file exists',
  ENOTEMPTY: 'directory not empty',
  EXDEV: 'cross-device link',
};

function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (code && errnoText[code]) || (err instanceof Error ? err.message : String(err));
}

/** Go 的 *PathError 文案：「op path: 原因」。 */
function pathError(op: string, file: string, err: unknown): Error {
  return new Error(`${op} ${file}: ${reasonOf(err)}`, { cause: err });
}

function gitPath(): string {
  return lookPath('git', process.env.PATH ?? '');
}

function gitOutput(root: string, ...args: string[]): Buffer {
  const result = spawnSync(gitPath(), args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${trimSpace(result.stderr.toString('utf8'))}`);
  }
  return result.stdout;
}

/** 忽略错误的 gitOutput，对应 Go 里 `out, _ := gitOutput(...)`。 */
function gitOutputOrEmpty(root: string, ...args: string[]): Buffer {
  try {
    return gitOutput(root, ...args);
  } catch {
    return Buffer.alloc(0);
  }
}

function splitNUL(body: Buffer): string[] {
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body[i] === 0) {
      if (i > start) {
        result.push(body.subarray(start, i).toString('utf8'));
      }
      start = i + 1;
    }
  }
  return result;
}

function existsAt(root: string, commit: string, file: string): boolean {
  const result = spawnSync(gitPath(), ['cat-file', '-e', commit + ':' + file], { cwd: root, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/** filepath.Base：去掉末尾斜杠后取最后一段；空串得 "."，全是斜杠得 "/"。 */
function goBase(p: string): string {
  if (p === '') return '.';
  let s = p;
  while (s.length > 0 && s.endsWith('/')) s = s.slice(0, -1);
  if (s === '') return '/';
  return s.slice(s.lastIndexOf('/') + 1);
}

const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** strconv.Quote（fmt 的 %q）。 */
function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '\x07':
        out += '\\a';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\f':
        out += '\\f';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '\v':
        out += '\\v';
        continue;
    }
    if (ch === ' ' || (c >= 0x21 && c < 0x7f) || (c >= 0x80 && printable.test(ch))) {
      out += ch;
    } else if (c < 0x20 || c === 0x7f) {
      out += '\\x' + c.toString(16).padStart(2, '0');
    } else if (c < 0x10000) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else {
      out += '\\U' + c.toString(16).padStart(8, '0');
    }
  }
  return out + '"';
}

export function buildPlan(root: string, mainRef: string, archiveRoot: string, name: string): Plan {
  const top = gitOutput(root, 'rev-parse', '--show-toplevel');
  root = trimSpace(top.toString('utf8'));
  const mainCommitRaw = gitOutput(root, 'rev-parse', '--verify', mainRef + '^{commit}');
  const sourceCommitRaw = gitOutput(root, 'rev-parse', '--verify', 'HEAD');
  const sourceRefRaw = gitOutputOrEmpty(root, 'branch', '--show-current');
  if (archiveRoot === '') {
    archiveRoot = path.join(path.dirname(root), '_archive');
  }
  if (!path.isAbsolute(archiveRoot)) {
    archiveRoot = path.join(root, archiveRoot);
  }
  archiveRoot = path.resolve(archiveRoot);
  if (archiveRoot === root || archiveRoot.startsWith(root + path.sep)) {
    throw new Error(`归档目录不得位于仓库内部：${archiveRoot}`);
  }
  if (name === '') {
    name = trimSpace(sourceRefRaw.toString('utf8')).replaceAll('/', '-');
    if (name === '') {
      name = 'detached-project';
    }
  }
  if (name === '.' || name === '..' || goBase(name) !== name || /[\r\n\x00]/.test(name)) {
    throw new Error(`归档目录名不得包含路径分隔符或控制字符：${goQuote(name)}`);
  }
  const plan: Plan = {
    repository: root,
    mainRef,
    mainCommit: trimSpace(mainCommitRaw.toString('utf8')),
    sourceRef: trimSpace(sourceRefRaw.toString('utf8')),
    sourceCommit: trimSpace(sourceCommitRaw.toString('utf8')),
    destination: path.join(archiveRoot, name),
    candidates: [],
    shared: [],
    ignored: [],
  };
  const diff = gitOutput(root, 'diff', '--name-status', '-z', plan.mainCommit, '--');
  const records = splitNUL(diff);
  for (let i = 0; i < records.length; ) {
    const status = records[i];
    i++;
    let count = 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      count = 2;
    }
    for (let n = 0; n < count && i < records.length; n++, i++) {
      const file = records[i];
      if (existsAt(root, plan.mainCommit, file)) {
        plan.shared.push(file);
      } else if (lstatOrNull(path.join(root, file)) !== null) {
        plan.candidates.push(file);
      }
    }
  }
  const untracked = gitOutputOrEmpty(root, 'ls-files', '-z', '--others', '--exclude-standard');
  plan.candidates.push(...splitNUL(untracked));
  const ignored = gitOutputOrEmpty(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard');
  plan.ignored = splitNUL(ignored);
  plan.candidates = uniqueSorted(plan.candidates);
  plan.shared = uniqueSorted(plan.shared);
  plan.ignored = uniqueSorted(plan.ignored);
  return plan;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareBytes);
}

interface ManifestEntry {
  path: string;
  sha256?: string;
  symlink_target?: string;
}

export function execute(plan: Plan): void {
  if (plan.shared.length > 0) {
    throw new Error(`main 共享文件有修改，拒绝归档：${plan.shared.join(', ')}`);
  }
  if (plan.ignored.length > 0) {
    throw new Error(`存在 ignored 文件，拒绝归档：${plan.ignored.join(', ')}`);
  }
  // Go：!os.IsNotExist(err)。只有 ENOENT 算不存在，其余错误（如 ENOTDIR）同样拒绝。
  let exists = true;
  try {
    fs.statSync(plan.destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
  }
  if (exists) {
    throw new Error(`归档目标已存在：${plan.destination}`);
  }
  const payload = path.join(plan.destination, 'files');
  mkdirAll(payload);
  const moved: string[] = [];
  const rollback = (): void => {
    for (let i = moved.length - 1; i >= 0; i--) {
      const from = path.join(payload, moved[i]);
      const to = path.join(plan.repository, moved[i]);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
      } catch {
        // 照 Go：忽略错误，尽量恢复。
      }
      try {
        fs.renameSync(from, to);
      } catch {
        // 同上。
      }
    }
    try {
      fs.rmSync(plan.destination, { recursive: true, force: true });
    } catch {
      // 同上。
    }
  };
  for (const relative of plan.candidates) {
    const from = path.join(plan.repository, relative);
    const to = path.join(payload, relative);
    try {
      mkdirAll(path.dirname(to));
    } catch (err) {
      rollback();
      throw err;
    }
    try {
      fs.renameSync(from, to);
    } catch (err) {
      rollback();
      throw new Error(`移动 ${relative}: rename ${from} ${to}: ${reasonOf(err)}`, { cause: err });
    }
    moved.push(relative);
  }
  const entries: ManifestEntry[] = [];
  for (const relative of moved) {
    const file = path.join(payload, relative);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(file);
    } catch (err) {
      rollback();
      throw pathError('lstat', file, err);
    }
    const entry: ManifestEntry = { path: relative };
    if (info.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(file);
        if (target !== '') entry.symlink_target = target;
      } catch {
        // Go：entry.SymlinkTarget, _ = os.Readlink(path)。
      }
    } else {
      let body: Buffer;
      try {
        body = fs.readFileSync(file);
      } catch (err) {
        rollback();
        throw pathError(err && (err as NodeJS.ErrnoException).code === 'EISDIR' ? 'read' : 'open', file, err);
      }
      entry.sha256 = crypto.createHash('sha256').update(body).digest('hex');
    }
    entries.push(entry);
  }
  // Go 用 map[string]any，键按字典序输出。
  const manifest = sortedKeys<unknown>({
    schema_version: 1,
    source_ref: plan.sourceRef,
    source_commit: plan.sourceCommit,
    main_ref: plan.mainRef,
    main_commit: plan.mainCommit,
    moved_count: moved.length,
    files: entries.map((e) => ({ path: e.path, sha256: e.sha256, symlink_target: e.symlink_target })),
  });
  const body = marshalIndent(manifest);
  const manifestPath = path.join(plan.destination, 'MANIFEST.json');
  try {
    fs.writeFileSync(manifestPath, body + '\n', { mode: 0o644 });
  } catch (err) {
    rollback();
    throw pathError('open', manifestPath, err);
  }
  let git: string;
  try {
    git = gitPath();
  } catch (err) {
    rollback();
    throw err;
  }
  const result = spawnSync(git, ['switch', '--detach', plan.mainCommit], {
    cwd: plan.repository,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    rollback();
    // CombinedOutput：两路输出合在一起（顺序无法复原，先 stdout 后 stderr）。
    const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString('utf8');
    throw new Error(`复位到 main 失败：${trimSpace(output)}`);
  }
}

/** os.MkdirAll(dir, 0o755)，错误写成 Go 的文案。 */
function mkdirAll(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw pathError('mkdir', dir, err);
  }
}
