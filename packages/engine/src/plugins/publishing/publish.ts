/**
 * 发布信息（publish.md）的校验与解析：必填字段、状态、密钥、引用路径、平台封面、标题字数与固定章节。
 * 原在 validate 包里（移植自 internal/validate），随「发布」搬进内置插件 publishing。
 */
import fs from 'node:fs';
import { goPathError } from '../../gofmt';
import { compareBytes } from '../../gojson';
import { frontmatter, safeRelative } from '../../validate/validate';
import { formatV, get, hasKey, isGoMap, toPlain, type GoMap } from '../../validate/yamlany';
import { validateCopyTitles, validatePlatformHashtags } from './copy_titles';
import { validateCoverImages } from './cover_images';

// Go 的 (?i)(sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*[^\s"']+|password\s*[:=]\s*[^\s"']+)。
// RE2 的 (?i) 按 Unicode 简单折叠：s 还匹配 ſ（U+017F），k 还匹配 K（U+212A），[A-Za-z] 也含这两个；
// \s 只是 ASCII 空白。这里逐字母展开，不给 JS 正则加 i / u 标志。
const ciS = '[sS\\u017F]';
const ciK = '[kK\\u212A]';
const asciiSpace = '[\\t\\n\\f\\r ]';
const notSpaceOrQuote = '[^\\t\\n\\f\\r "\']';
const secretValue = new RegExp(
  `(${ciS}${ciK}-[A-Za-z0-9_\\u017F\\u212A-]{12,}` +
    `|[aA][pP][iI][_-]?${ciK}[eE][yY]${asciiSpace}*[:=]${asciiSpace}*${notSpaceOrQuote}+` +
    `|[pP][aA]${ciS}${ciS}[wW][oO][rR][dD]${asciiSpace}*[:=]${asciiSpace}*${notSpaceOrQuote}+)`,
);

/**
 * 校验 publish.md：必填字段、状态、密钥、引用路径、平台封面、标题字数与固定章节。
 * 通过时返回 frontmatter 字段（普通 JS 值）。
 */
export function publish(file: string, projectRoot: string): Record<string, unknown> {
  const [data, body] = frontmatter(file);
  const required = ['schema_version', 'workflow', 'publish_status', 'platform', 'generated_at', 'video', 'cover', 'copy', 'credits', 'manual_checks', 'evidence'];
  for (const key of required) {
    if (!hasKey(data, key)) throw new Error(`缺少必填字段：${key}`);
  }
  const d = data as GoMap;
  if (d.schema_version !== 1) throw new Error('schema_version 必须为 1');
  const statuses = new Set(['draft', 'pending_manual_checks', 'blocked', 'ready']);
  const status = typeof d.publish_status === 'string' ? d.publish_status : '';
  if (!statuses.has(status)) throw new Error(`无效的 publish_status：${formatV(d.publish_status)}`);
  let rawBody: Buffer;
  try {
    rawBody = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`读取 ${file}: ${goPathError('open', file, err)}`, { cause: err });
  }
  if (secretValue.test(rawBody.toString('utf8'))) throw new Error('publish.md 不得包含密钥');
  const video = d.video;
  if (!isGoMap(video)) throw new Error('video 必须是对象');
  safeRelative(projectRoot, get(video, 'path'));
  const evidence = d.evidence;
  if (isGoMap(evidence)) {
    // Go 遍历 map 的顺序是随机的；这里按键排序，报错时取第一个出错的键。
    for (const key of Object.keys(evidence).sort(compareBytes)) {
      const value = evidence[key];
      if (Array.isArray(value)) {
        for (const item of value) safeRelative(projectRoot, item);
      } else safeRelative(projectRoot, value);
    }
  }
  validateCoverImages(projectRoot, d);
  validateCopyTitles(d);
  validatePlatformHashtags(d);
  for (const heading of ['## 发布状态', '## 发布平台', '## 主标题', '## 发布介绍', '## 话题标签', '## 封面文字', '## 素材署名', '## 成片规格与 SHA-256', '## 证据索引', '## 发布前人工检查', '## 未完成事项']) {
    if (!body.includes(heading)) throw new Error(`markdown 缺少章节：${heading}`);
  }
  return toPlain(d) as Record<string, unknown>;
}

/**
 * 只解析 publish.md 的 frontmatter，不做任何校验。Studio 发布页
 * 用它把发布信息排成表单式的页面；合不合格仍以 publish（onset validate publish）为准。
 * 返回 null 表示 frontmatter 为空（Go 的 nil map）。
 */
export function readPublish(file: string): Record<string, unknown> | null {
  const [data] = frontmatter(file);
  return data === null ? null : (toPlain(data) as Record<string, unknown>);
}
