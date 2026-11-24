//
// 正则与 RE2 的对照：JS 正则不带 u 标志时 \b、\w、\d 只认 ASCII，与 RE2 相同；\s 展开成
// RE2 的 ASCII 空白类（S / SIN）；(?i) 不用 i 标志，而用 ci() 把字母展开成含 ſ、K 的字符类，
// 复现 RE2 的 Unicode 简单折叠；(?s) 的 . 写成 [\s\S]。偏移是 UTF-16 码元下标（Go 是字节），
// 只用于在同一份字符串里换算行号，结果一致。
import { CI_LETTERS, ci, goClean, goDir, goJoin, goTrimSpace, S, SIN } from './gostd';

export const scriptBlock = new RegExp(`<${ci('script')}\\b([^>]*)>([\\s\\S]*?)</${ci('script')}${S}*>`, 'dg');
export const attrType = new RegExp(`\\b${ci('type')}${S}*=${S}*["']?([^"'${SIN}>]+)`, 'd');
export const attrSrc = new RegExp(`(?:^|${S})${ci('src')}${S}*=${S}*(?:"([^"]*)"|'([^']*)')`, 'd');
export const htmlTag = /<([A-Za-z][\w:-]*)([^>]*)>/dg;
export const resourceAttr = new RegExp(
  `(?:^|[${SIN}"'])(${ci('src')}|${ci('href')}|${ci('xlink:href')}|${ci('poster')}|${ci('data-composition-src')})${S}*=${S}*(?:"([^"]*)"|'([^']*)')`,
  'dg',
);
const linkRel = new RegExp(`\\b${ci('rel')}${S}*=${S}*["']?([^"'>]*)`, 'd');
export const cssURL = new RegExp(
  `${ci('url')}\\(${S}*(?:"([^"]*)"|'([^']*)'|([^)'"${SIN}]+))${S}*\\)|@${ci('import')}${S}+(?:"([^"]*)"|'([^']*)')`,
  'dg',
);
export const jsImport = new RegExp(
  `\\bimport${S}*(?:[\\w*{}${SIN},$]+${S}*from${S}*)?(?:\\(${S}*)?["']([^"']+)["']`,
  'dg',
);
export const jsonURL = /"((?:https?:)?\/\/[^"]+|\.{0,2}\/[^"]+)"/dg;

/** nonScriptTypes 是内容不是可执行 JS 的 <script type>。 */
export const nonScriptTypes = new Set([
  'application/json',
  'application/ld+json',
  'text/template',
  'text/html',
  'text/x-template',
  'text/plain',
]);

export const fontFaceBlock = new RegExp(`@${ci('font-face')}${S}*\\{([^}]*)\\}`, 'dg');
export const fontDisplay = new RegExp(`\\b${ci('font-display')}${S}*:${S}*([${CI_LETTERS}-]+)`, 'd');

export type Indices = Array<[number, number] | undefined>;

export function indicesOf(m: RegExpMatchArray): Indices {
  return (m as RegExpMatchArray & { indices: Indices }).indices;
}

/** submatch 返回第一个非空捕获组及其起点。 */
export function submatch(text: string, m: Indices): [string, number] {
  for (let i = 1; i < m.length; i++) {
    const g = m[i];
    if (g && g[1] > g[0]) {
      return [text.slice(g[0], g[1]), g[0]];
    }
  }
  return ['', m[0]![0]];
}

export function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return '';
}

/** 解析本地相对/根路径引用；空或含协议冒号时返回空串。 */
export function resolveLocalRef(srcRel: string, ref: string): string {
  let target = ref;
  const cut = target.search(/[?#]/);
  if (cut >= 0) {
    target = target.slice(0, cut);
  }
  if (target === '' || target.includes(':')) {
    return '';
  }
  return target.startsWith('/') ? goClean(target.slice(1)) : goJoin(goDir(srcRel), target);
}

/**
 * fetchesHref 报告这个标签的 href 会不会在渲染时被加载。<a> 和
 * <link rel="canonical"> 这类只是元数据，渲染器不会去请求，算作引用就是误判。
 */
export function fetchesHref(tag: string, attrs: string): boolean {
  switch (tag) {
    case 'image':
    case 'use':
    case 'feimage':
      return true;
    case 'link': {
      const match = linkRel.exec(attrs);
      if (match === null) {
        return false;
      }
      // strings.Fields 按 Unicode 空白切分。
      for (const rel of goFields(match[1].toLowerCase())) {
        switch (rel) {
          case 'stylesheet':
          case 'preload':
          case 'modulepreload':
          case 'icon':
          case 'import':
            return true;
        }
      }
    }
  }
  return false;
}

function goFields(s: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (const ch of s) {
    if (isGoSpaceChar(ch)) {
      if (current !== '') fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') fields.push(current);
  return fields;
}

function isGoSpaceChar(ch: string): boolean {
  return ch.length === 1 && goTrimSpace(ch) === '';
}

// vendorDirs 下的文件、以及带 .min / .bundle / .umd 后缀或许可证横幅的文件，
// 视为随镜头拷贝的第三方库。
const vendorDirs = new Set(['vendor', 'vendors', 'lib', 'libs', 'node_modules', 'third_party']);
const vendorSuffix = new RegExp(
  `[.-](${ci('min')}|${ci('bundle')}|${ci('umd')}|${ci('prod')}|${ci('production')})\\.(${ci('m')}|${ci('c')})?${ci('js')}$`,
);

/** body 的前 n 个 UTF-8 字节（Go 的 body[:n]；切在多字节字符中间时，这里不含那个字符）。 */
function headBytes(body: string, n: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of body) {
    bytes += Buffer.byteLength(ch);
    if (bytes > n) break;
    out += ch;
  }
  return out;
}

/**
 * vendored 报告 rel 是否是第三方库。自己写的合成代码不会落在这些位置、
 * 也不会带许可证横幅；误把第三方库当成作者代码判定，代价远高于漏检。
 */
export function vendored(rel: string, body: string): boolean {
  for (const part of goDir(rel).split('/')) {
    if (vendorDirs.has(part.toLowerCase())) {
      return true;
    }
  }
  if (vendorSuffix.test(rel)) {
    return true;
  }
  const head = goTrimSpace(headBytes(body, 512));
  return (
    head.startsWith('/*!') ||
    head.startsWith('/**!') ||
    (head.startsWith('/*') && head.toLowerCase().includes('@license'))
  );
}
