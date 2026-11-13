import fs from 'node:fs';
import path from 'node:path';
import { goPathError, goTrimSpace } from '../gofmt';
import { decodeFrontmatterYAML, type GoMap } from './yamlany';

function readFile(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw new Error(goPathError(err && (err as NodeJS.ErrnoException).code === 'EISDIR' ? 'read' : 'open', file, err), { cause: err });
  }
}

/** frontmatter：读文件并解析 YAML frontmatter，返回字段与正文。 */
export function frontmatter(file: string): [GoMap | null, string] {
  return parseFrontmatter(file, readFile(file));
}

/** bytes.SplitN(body, "---", 3)。 */
function splitN(body: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = body;
  while (out.length < n - 1) {
    const index = rest.indexOf(sep);
    if (index < 0) break;
    out.push(rest.slice(0, index));
    rest = rest.slice(index + sep.length);
  }
  out.push(rest);
  return out;
}

export function parseFrontmatter(file: string, body: Buffer | string): [GoMap | null, string] {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  const parts = splitN(text, '---', 3);
  if (parts.length !== 3 || goTrimSpace(parts[0]).length !== 0) throw new Error(`${file} 缺少 YAML frontmatter`);
  return [decodeFrontmatterYAML(parts[1]), parts[2]];
}

/** Go filepath.EvalSymlinks：失败时给出「lstat <第一个不存在的前缀>: …」。 */
function evalSymlinks(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    const abs = path.resolve(p);
    let current: string = path.sep;
    for (const part of abs.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        fs.lstatSync(current);
      } catch (inner) {
        throw new Error(goPathError('lstat', current, inner), { cause: inner });
      }
    }
    throw new Error(goPathError('lstat', abs, err), { cause: err });
  }
}

/** 路径必须是项目内的相对路径；解析符号链接后仍要落在项目里。非字符串或空串不查。 */
export function safeRelative(root: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') return;
  const p = value;
  if (path.isAbsolute(p) || p.includes('://')) throw new Error(`路径必须位于项目内：${p}`);
  const absRoot = path.resolve(root);
  const target = path.resolve(path.join(absRoot, p));
  const resolvedRoot = evalSymlinks(absRoot);
  const resolvedTarget = resolveExisting(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === '..' || rel.startsWith('..' + path.sep)) throw new Error(`路径逃出项目目录：${p}`);
}

/**
 * 解析路径里已经存在的那一段，再接上还不存在的部分。
 *
 * 只解析直接父目录不够：目标在一个还没建出来的子目录里时（例如还没出图的
 * covers/），父目录解析失败，路径就停留在未解析的形态；而项目根是解析过的
 * （macOS 的临时目录 /var 实际是 /private/var），两者一比就误判成逃出项目。
 */
export function resolveExisting(target: string): string {
  let rest = '';
  for (let dir = target; ; dir = path.dirname(dir)) {
    try {
      const resolved = fs.realpathSync(dir);
      return rest === '' ? resolved : path.join(resolved, rest);
    } catch {
      // 继续往上找。
    }
    const parent = path.dirname(dir);
    if (parent === dir) return target;
    rest = rest === '' ? path.basename(dir) : path.join(path.basename(dir), rest);
  }
}
