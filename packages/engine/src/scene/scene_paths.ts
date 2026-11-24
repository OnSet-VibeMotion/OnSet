import fs from 'node:fs';
import path from 'node:path';
import { goPathError, goTrimSpace } from '../gofmt';

export const TextOpen = '<scene-text>';
export const TextClose = '</scene-text>';

/**
 * Go 的 `(?i)<\s*\/?\s*scene-text`。RE2 的 \s 只含 ASCII 空白；(?i) 下 s 还匹配 ſ（U+017F）。
 * 码点用 fromCodePoint 拼：源码里写 \u 转义会被编辑工具改写成真实字符。
 */
const longS = String.fromCodePoint(0x17f);
const delimiterSource = `<[\\t\\n\\f\\r ]*/?[\\t\\n\\f\\r ]*[sS${longS}][cC][eE][nN][eE]-[tT][eE][xX][tT]`;
export const delimiterMatch = new RegExp(delimiterSource);
export const delimiterMatchAll = new RegExp(delimiterSource, 'g');

/** 项目根的标志：项目配置文件。 */
export const projectMarker = 'onset.conf';

/** Go filepath.EvalSymlinks：失败时给出与 Go 相同的「lstat <第一个不存在的前缀>: …」文案。 */
export function evalSymlinks(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    const abs = path.resolve(p);
    // 找到第一个 lstat 失败的前缀，Go 的报错停在那里。
    const parts = abs.split(path.sep).filter(Boolean);
    let current: string = path.sep;
    for (const part of parts) {
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

/** Go filepath.Rel 对两个绝对路径的结果（同一路径为 "."）。 */
export function relPath(base: string, target: string): string {
  return path.relative(base, target) || '.';
}

function escapes(rel: string): boolean {
  return path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep);
}

export function contained(root: string, value: string, field: string): string {
  if (value === '' || path.isAbsolute(value)) throw new Error(`${field} 必须是非空相对路径`);
  root = path.resolve(root);
  const target = path.resolve(path.join(root, value));
  let resolvedRoot: string;
  try {
    resolvedRoot = evalSymlinks(root);
  } catch (err) {
    throw new Error(`无法解析镜头目录：${(err as Error).message}`, { cause: err });
  }
  let resolvedTarget: string;
  try {
    resolvedTarget = fs.realpathSync(target);
  } catch {
    let cur = path.dirname(target);
    const tail: string[] = [path.basename(target)];
    while (true) {
      try {
        resolvedTarget = path.join(fs.realpathSync(cur), ...tail.reverse());
        break;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) {
          resolvedTarget = target;
          break;
        }
        tail.push(path.basename(cur));
        cur = parent;
      }
    }
  }
  const rel = relPath(resolvedRoot, resolvedTarget);
  if (escapes(rel)) throw new Error(`${field} 不得逃出镜头目录：${value}`);
  return resolvedTarget;
}

export function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function verifySceneText(text: string): void {
  if (goTrimSpace(text) === '') throw new Error('text 必须是非空字符串');
  if (text.includes('[[USER_MESSAGE]]') || delimiterMatch.test(text)) {
    throw new Error('text 含保留的阶段消息或 scene-text 定界标记');
  }
}

/** 镜头所在的项目根（从镜头目录逐级向上第一个有 onset.conf 的目录）；不在项目里时为空。 */
export function findProjectRoot(sceneDir: string): string {
  for (let dir = path.resolve(sceneDir); ; ) {
    if (isRegularFile(path.join(dir, projectMarker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}
