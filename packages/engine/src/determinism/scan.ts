//
// Package determinism 静态扫描镜头合成源码，拦下会让渲染结果不可复现的写法。
//
// HyperFrames 按帧 seek 出图：第 N 帧的画面只能由时间轴位置决定。读时钟、
// 未播种的随机数、requestAnimationFrame、定时器和渲染时网络请求都会让同一帧在
// 两次渲染间不同。这些禁令写在上游 hyperframes 技能的 Contract 里，但只是提示词——
// 渲染器照样能写出来，渲染照样退出码 0，问题要到重渲染对不上时才暴露。
//
// 扫描范围只取渲染真正加载的文件：从合成入口出发，沿 src / href /
// data-composition-src / import / url() 的本地引用逐个展开。镜头目录里没被
// 引用的草稿、技能模板副本不参与判定，避免误伤。
//
// 正则与 RE2 的对照：JS 正则不带 u 标志时 \b、\w、\d 只认 ASCII，与 RE2 相同；\s 展开成
// RE2 的 ASCII 空白类（S / SIN）；(?i) 不用 i 标志，而用 ci() 把字母展开成含 ſ、K 的字符类，
// 复现 RE2 的 Unicode 简单折叠；(?s) 的 . 写成 [\s\S]。偏移是 UTF-16 码元下标（Go 是字节），
// 只用于在同一份字符串里换算行号，结果一致。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { CI_LETTERS, S, SIN, ci, goClean, goDir, goExt, goJoin, goPathError, goTrimSpace } from './gostd';
import { AllowMarker, isIgnoredRef, isRemote, remoteProblem, scriptRules } from './rules';
import { blank, lexJS, stripCSSComments, stripHTMLComments } from './strip';

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

/** skippedDirs 是寻找入口时不进入的目录：重试归档、抽帧产物、渲染输出与依赖。 */
const skippedDirs = new Set(['attempts', 'visual-qc', 'node_modules', 'renders', 'snapshots']);

/**
 * entryDepth 是寻找 index.html 的最大目录深度。渲染器有时先 hyperframes init
 * 出一个子项目再在里面写合成，入口就落在镜头目录下一层。
 */
const entryDepth = 2;

/**
 * Scan 扫描 dir 下的合成源码。找不到入口不算失败，只写进 hints：
 * 这道门的前提是「宁可漏判，不可误判」。
 */
export function scan(dir: string): Report {
  const root = path.resolve(dir);
  const report: Report = { schema_version: ReportSchemaVersion, ok: false, entries: [], files: [], findings: [] };
  const entries = findEntries(root);
  if (entries.length === 0) {
    report.hints = [...(report.hints ?? []), '镜头目录里找不到 index.html 或顶层 .html 合成入口，未做源码扫描'];
    report.ok = true;
    return report;
  }
  const s = new Scanner(root, report);
  for (const entry of entries) {
    report.entries.push(entry);
    s.queue.push(entry);
  }
  while (s.queue.length > 0) {
    const next = s.queue.shift()!;
    if (s.seen.has(next)) {
      continue;
    }
    s.seen.add(next);
    s.scanFile(next);
  }
  report.files.sort(compareBytes);
  sortFindings(report.findings);
  if (report.allowed) sortFindings(report.allowed);
  report.ok = report.findings.length === 0;
  return report;
}

function sortFindings(findings: Finding[]): void {
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

function isHTMLName(name: string): boolean {
  return goExt(name).toLowerCase() === '.html';
}

/**
 * findEntries 优先取镜头目录的 index.html；没有时取顶层全部 .html；
 * 仍没有时向下找 entryDepth 层内的 index.html。
 */
function findEntries(root: string): string[] {
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

function isRegular(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** source 是一个待扫描文件的原文与逐行文本，用于行号换算与豁免判定。 */
interface Source {
  rel: string;
  raw: string;
  lines: string[];
}

function lineOf(src: Source, offset: number): number {
  const end = Math.min(offset, src.raw.length);
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (src.raw.charCodeAt(i) === 10) count++;
  }
  return count;
}

const scriptBlock = new RegExp(`<${ci('script')}\\b([^>]*)>([\\s\\S]*?)</${ci('script')}${S}*>`, 'dg');
const attrType = new RegExp(`\\b${ci('type')}${S}*=${S}*["']?([^"'${SIN}>]+)`, 'd');
const attrSrc = new RegExp(`(?:^|${S})${ci('src')}${S}*=${S}*(?:"([^"]*)"|'([^']*)')`, 'd');
const htmlTag = /<([A-Za-z][\w:-]*)([^>]*)>/dg;
const resourceAttr = new RegExp(
  `(?:^|[${SIN}"'])(${ci('src')}|${ci('href')}|${ci('xlink:href')}|${ci('poster')}|${ci('data-composition-src')})${S}*=${S}*(?:"([^"]*)"|'([^']*)')`,
  'dg',
);
const linkRel = new RegExp(`\\b${ci('rel')}${S}*=${S}*["']?([^"'>]*)`, 'd');
const cssURL = new RegExp(
  `${ci('url')}\\(${S}*(?:"([^"]*)"|'([^']*)'|([^)'"${SIN}]+))${S}*\\)|@${ci('import')}${S}+(?:"([^"]*)"|'([^']*)')`,
  'dg',
);
const jsImport = new RegExp(`\\bimport${S}*(?:[\\w*{}${SIN},$]+${S}*from${S}*)?(?:\\(${S}*)?["']([^"']+)["']`, 'dg');
const jsonURL = /"((?:https?:)?\/\/[^"]+|\.{0,2}\/[^"]+)"/dg;

/** nonScriptTypes 是内容不是可执行 JS 的 <script type>。 */
const nonScriptTypes = new Set([
  'application/json',
  'application/ld+json',
  'text/template',
  'text/html',
  'text/x-template',
  'text/plain',
]);

const fontFaceBlock = new RegExp(`@${ci('font-face')}${S}*\\{([^}]*)\\}`, 'dg');
const fontDisplay = new RegExp(`\\b${ci('font-display')}${S}*:${S}*([${CI_LETTERS}-]+)`, 'd');

type Indices = Array<[number, number] | undefined>;

function indicesOf(m: RegExpMatchArray): Indices {
  return (m as RegExpMatchArray & { indices: Indices }).indices;
}

/** submatch 返回第一个非空捕获组及其起点。 */
function submatch(text: string, m: Indices): [string, number] {
  for (let i = 1; i < m.length; i++) {
    const g = m[i];
    if (g && g[1] > g[0]) {
      return [text.slice(g[0], g[1]), g[0]];
    }
  }
  return ['', m[0]![0]];
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return '';
}

class Scanner {
  readonly seen = new Set<string>();
  readonly reported = new Set<string>();
  readonly queue: string[] = [];

  constructor(
    readonly root: string,
    readonly report: Report,
  ) {}

  scanFile(rel: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.root, rel), 'utf8');
    } catch (err) {
      throw new Error(`读取合成源码失败：${goPathError('open', path.join(this.root, rel), err)}`, { cause: err });
    }
    const src: Source = { rel, raw, lines: raw.split('\n') };
    this.report.files.push(rel);
    switch (goExt(rel).toLowerCase()) {
      case '.html':
      case '.htm':
        this.scanHTML(src);
        break;
      case '.js':
      case '.mjs':
      case '.cjs':
        if (vendored(rel, src.raw)) {
          // 第三方库内部的 Math.random、requestAnimationFrame 不在渲染路径上，
          // 照常判定只会制造误判；只记下跳过了它，留痕可查。
          (this.report.skipped ??= []).push(rel);
          return;
        }
        this.scanScript(src, src.raw, 0);
        break;
      case '.css':
        this.scanCSS(src, stripCSSComments(src.raw), 0);
        break;
    }
  }

  scanHTML(src: Source): void {
    const text = stripHTMLComments(src.raw);
    const markup = text.split('');
    for (const match of text.matchAll(scriptBlock)) {
      const loc = indicesOf(match);
      const [attrStart, attrEnd] = loc[1]!;
      const [bodyStart, bodyEnd] = loc[2]!;
      const attrs = text.slice(attrStart, attrEnd);
      // 脚本正文里常有拼 HTML 的字符串，不能让属性扫描看到它们。
      blank(markup, bodyStart, bodyEnd);
      const srcMatch = attrSrc.exec(attrs);
      if (srcMatch) {
        this.reference(src, attrStart, firstNonEmpty(...srcMatch.slice(1)));
        continue;
      }
      let kind = '';
      const typeMatch = attrType.exec(attrs);
      if (typeMatch) {
        kind = typeMatch[1].toLowerCase();
      }
      const body = text.slice(bodyStart, bodyEnd);
      if (kind === 'importmap') {
        for (const m of body.matchAll(jsonURL)) {
          const [gs, ge] = indicesOf(m)[1]!;
          this.reference(src, bodyStart + gs, body.slice(gs, ge));
        }
      } else if (nonScriptTypes.has(kind)) {
        // 不是可执行 JS。
      } else {
        this.scanScript(src, body, bodyStart);
      }
    }
    const rest = markup.join('');
    for (const tagMatch of rest.matchAll(htmlTag)) {
      const tag = indicesOf(tagMatch);
      const name = rest.slice(tag[1]![0], tag[1]![1]).toLowerCase();
      const [attrsStart, attrsEnd] = tag[2]!;
      const attrs = rest.slice(attrsStart, attrsEnd);
      for (const m of attrs.matchAll(resourceAttr)) {
        const idx = indicesOf(m);
        const attr = attrs.slice(idx[1]![0], idx[1]![1]).toLowerCase();
        if (attr.endsWith('href') && !fetchesHref(name, attrs)) {
          continue;
        }
        const [value, start] = submatch(attrs, [idx[1], ...idx.slice(2)]);
        this.reference(src, attrsStart + start, value);
      }
    }
    this.scanCSS(src, stripCSSComments(rest), 0);
  }

  scanScript(src: Source, script: string, base: number): void {
    const { withStrings, codeOnly } = lexJS(script);
    for (const rule of scriptRules) {
      const text = rule.needsStrings ? withStrings : codeOnly;
      for (const m of text.matchAll(rule.pattern)) {
        this.add(src, base + m.index!, rule.id, rule.message);
      }
    }
    for (const m of withStrings.matchAll(jsImport)) {
      const [gs, ge] = indicesOf(m)[1]!;
      this.reference(src, base + gs, withStrings.slice(gs, ge));
    }
  }

  scanCSS(src: Source, css: string, base: number): void {
    for (const m of css.matchAll(cssURL)) {
      const [value, start] = submatch(css, indicesOf(m));
      this.reference(src, base + start, value);
    }
    this.scanFontFaces(src, css, base);
  }

  /**
   * scanFontFaces 检查 @font-face 的两类确定性问题。
   *
   * 渲染机是没有系统字体的无头 Chrome，并行抽帧：
   *   - src 指向镜头目录里不存在的文件：请求静默 404，字体回退，渲染照样成功；
   *   - font-display 显式写成 swap / fallback / optional：字体没就绪时先画回退字体，
   *     并行的几个抽帧进程各自赶上不同的时机，同一镜头里一部分帧是错的字形。
   *
   * 没写 font-display 不报：缺省值 auto 在 Chrome 里按 block 处理。local() 也不报：
   * 常见写法是 local() 后面跟一个 url() 兜底，只看 local() 会误判。
   */
  scanFontFaces(src: Source, css: string, base: number): void {
    for (const blockMatch of css.matchAll(fontFaceBlock)) {
      const [blockStart, blockEnd] = indicesOf(blockMatch)[1]!;
      const body = css.slice(blockStart, blockEnd);
      const m = fontDisplay.exec(body);
      if (m) {
        const [vs, ve] = indicesOf(m)[1]!;
        const value = body.slice(vs, ve).toLowerCase();
        if (value !== 'block' && value !== 'auto') {
          this.add(src, base + blockStart + m.index, 'font-display',
            '@font-face 使用了 font-display: ' + value + '；并行抽帧时部分帧会抓到回退字体，请改为 block');
        }
      }
      for (const u of body.matchAll(cssURL)) {
        const [value, start] = submatch(body, indicesOf(u));
        const missing = this.missingLocalFile(src, value);
        if (missing !== '') {
          this.add(src, base + blockStart + start, 'font-missing',
            '@font-face 的字体文件不在镜头目录里（' + missing + '）；渲染时静默 404，字体回退且不报错');
        }
      }
    }
  }

  /** missingLocalFile 返回 ref 解析后不存在的本地路径；远程、内联或无法静态求值的引用返回空串。 */
  missingLocalFile(src: Source, ref: string): string {
    ref = goTrimSpace(ref);
    if (isIgnoredRef(ref) || isRemote(ref)) {
      return '';
    }
    let target = ref;
    const cut = target.search(/[?#]/);
    if (cut >= 0) {
      target = target.slice(0, cut);
    }
    if (target === '' || target.includes(':')) {
      return '';
    }
    let resolved: string;
    if (target.startsWith('/')) {
      resolved = goClean(target.slice(1));
    } else {
      resolved = goJoin(goDir(src.rel), target);
    }
    if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) {
      return resolved;
    }
    if (isRegular(path.join(this.root, resolved))) {
      return '';
    }
    return resolved;
  }

  /** reference 处理一个资源引用：远程的按 CDN 规则判定，本地的入队继续展开。 */
  reference(src: Source, offset: number, ref: string): void {
    ref = goTrimSpace(ref);
    if (isIgnoredRef(ref)) {
      return;
    }
    if (isRemote(ref)) {
      const [rule, message] = remoteProblem(ref);
      if (rule !== '') {
        this.add(src, offset, rule, message + '（' + ref + '）');
      }
      return;
    }
    let target = ref;
    const cut = target.search(/[?#]/);
    if (cut >= 0) {
      target = target.slice(0, cut);
    }
    if (target === '' || target.includes(':')) {
      return;
    }
    let resolved: string;
    if (target.startsWith('/')) {
      resolved = goClean(target.slice(1));
    } else {
      resolved = goJoin(goDir(src.rel), target);
    }
    if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) {
      return;
    }
    switch (goExt(resolved).toLowerCase()) {
      case '.html':
      case '.htm':
      case '.js':
      case '.mjs':
      case '.cjs':
      case '.css':
        break;
      default:
        return;
    }
    if (isRegular(path.join(this.root, resolved)) && !this.seen.has(resolved)) {
      this.queue.push(resolved);
    }
  }

  add(src: Source, offset: number, rule: string, message: string): void {
    const line = lineOf(src, offset);
    let text = '';
    if (line - 1 < src.lines.length) {
      text = src.lines[line - 1];
    }
    let snippet = goTrimSpace(text);
    const runes = [...snippet];
    if (runes.length > 120) {
      snippet = runes.slice(0, 120).join('') + '…';
    }
    const finding: Finding = { file: src.rel, line, rule, message, snippet };
    // 同一行同一规则只报一次：一行里连写两次 Math.random() 是同一个问题。
    const key = `${src.rel}:${line}:${rule}:${message}`;
    if (this.reported.has(key)) {
      return;
    }
    this.reported.add(key);
    if (text.includes(AllowMarker)) {
      (this.report.allowed ??= []).push(finding);
      return;
    }
    this.report.findings.push(finding);
  }
}

/**
 * fetchesHref 报告这个标签的 href 会不会在渲染时被加载。<a> 和
 * <link rel="canonical"> 这类只是元数据，渲染器不会去请求，算作引用就是误判。
 */
function fetchesHref(tag: string, attrs: string): boolean {
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
function vendored(rel: string, body: string): boolean {
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
