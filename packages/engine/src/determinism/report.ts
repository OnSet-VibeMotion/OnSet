import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { goExt, goPathError } from './gostd';

/** Finding 是一条违规，file 为相对镜头目录的斜杠路径。 */
export interface Finding {
  file: string;
  line: number;
  rule: string;
  message: string;
  snippet: string;
}

/** Finding.String()。 */
export function findingString(f: Finding): string {
  return `${f.file}:${f.line} [${f.rule}] ${f.message}：${f.snippet}`;
}

/** Report 是一次扫描的机器可读结果。ok 只由 findings 决定。 */
export interface Report {
  schema_version: number;
  ok: boolean;
  entries: string[];
  files: string[];
  findings: Finding[];
  allowed?: Finding[];
  /** skipped 是按第三方库跳过规则判定的文件。 */
  skipped?: string[];
  hints?: string[];
}

/** ReportSchemaVersion 是 Report 的结构版本。 */
export const ReportSchemaVersion = 1;

/** Problems 把违规逐条格式化成给人看的文字。 */
export function problems(r: Report): string[] {
  return r.findings.map((finding) => '源码不确定：' + findingString(finding));
}

function findingJSON(f: Finding) {
  return { file: f.file, line: f.line, rule: f.rule, message: f.message, snippet: f.snippet };
}

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

/** WriteJSON 原子写出报告。 */
export function writeJSON(r: Report, target: string): void {
  const body = marshalIndent({
    schema_version: r.schema_version,
    ok: r.ok,
    entries: r.entries ?? null,
    files: r.files ?? null,
    findings: r.findings ? r.findings.map(findingJSON) : null,
    allowed: nonEmpty(r.allowed)?.map(findingJSON),
    skipped: nonEmpty(r.skipped),
    hints: nonEmpty(r.hints),
  });
  atomicWrite(target, body + '\n', 0o644);
}

export function sortFindings(findings: Finding[]): void {
  findings.sort((a, b) => {
    if (a.file !== b.file) {
      return compareBytes(a.file, b.file);
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return compareBytes(a.rule, b.rule);
  });
}

/** skippedDirs 是寻找入口时不进入的目录：重试归档、抽帧产物、渲染输出与依赖。 */
const skippedDirs = new Set(['attempts', 'visual-qc', 'node_modules', 'renders', 'snapshots']);

/**
 * entryDepth 是寻找 index.html 的最大目录深度。渲染器有时先 hyperframes init
 * 出一个子项目再在里面写合成，入口就落在镜头目录下一层。
 */
const entryDepth = 2;

function isHTMLName(name: string): boolean {
  return goExt(name).toLowerCase() === '.html';
}

/**
 * findEntries 优先取镜头目录的 index.html；没有时取顶层全部 .html；
 * 仍没有时向下找 entryDepth 层内的 index.html。
 */
export function findEntries(root: string): string[] {
  if (isRegular(path.join(root, 'index.html'))) {
    return ['index.html'];
  }
  let items: fs.Dirent[];
  try {
    items = readDirSorted(root);
  } catch (err) {
    throw new Error(`无法读取镜头目录：${goPathError('open', root, err)}`, { cause: err });
  }
  const entries: string[] = [];
  for (const item of items) {
    if (!item.isDirectory() && isHTMLName(item.name)) {
      entries.push(item.name);
    }
  }
  if (entries.length > 0) {
    return entries;
  }
  // filepath.WalkDir：按词法序遍历，不跟随符号链接；出错的目录跳过。
  const walk = (current: string, rel: string): void => {
    let children: fs.Dirent[];
    try {
      children = readDirSorted(current);
    } catch {
      return;
    }
    for (const d of children) {
      const childRel = rel === '' ? d.name : rel + '/' + d.name;
      const depth = childRel.split('/').length;
      if (d.isDirectory()) {
        if (skippedDirs.has(d.name) || d.name.startsWith('.') || depth > entryDepth) {
          continue;
        }
        walk(path.join(current, d.name), childRel);
        continue;
      }
      if (d.name === 'index.html' && depth <= entryDepth + 1) {
        entries.push(childRel);
      }
    }
  };
  walk(root, '');
  entries.sort(compareBytes);
  return entries;
}

/** os.ReadDir：按文件名字节序返回。 */
function readDirSorted(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}

export function isRegular(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
