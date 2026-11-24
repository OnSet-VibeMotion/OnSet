import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent, sortedKeys } from '../gojson';
import { archiveContent } from '../renderassets';
import {
  existsAt,
  gitOutput,
  gitOutputOrEmpty,
  gitPath,
  goBase,
  goQuote,
  lstatOrNull,
  mkdirAll,
  pathError,
  reasonOf,
  splitNUL,
  trimSpace,
  uniqueSorted,
} from './git';

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
  // 内容池可能属于 main，也可能先于镜头被移动；在任何移动前取出字节，归档中的镜头独立可读。
  const resources = new Map(
    plan.candidates.flatMap((relative) => {
      const content = archiveContent(plan.repository, path.join(plan.repository, relative));
      return content ? [[relative, content] as const] : [];
    }),
  );
  const payload = path.join(plan.destination, 'files');
  mkdirAll(payload);
  const moved: string[] = [];
  const rollback = (): void => {
    for (let i = moved.length - 1; i >= 0; i--) {
      const from = path.join(payload, moved[i]);
      const to = path.join(plan.repository, moved[i]);
      const resource = resources.get(moved[i]!);
      if (resource) {
        try {
          fs.rmSync(from, { force: true });
          fs.symlinkSync(resource.link, from, 'file');
        } catch {
          // 与下面的恢复一样尽力执行，原始错误由调用处报告。
        }
      }
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
    const resource = resources.get(relative);
    if (resource) {
      try {
        atomicWrite(to, resource.body);
      } catch (err) {
        rollback();
        throw err;
      }
    }
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
