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
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import { goExt, goPathError, goTrimSpace } from './gostd';
import {
  attrSrc,
  attrType,
  cssURL,
  fetchesHref,
  firstNonEmpty,
  fontDisplay,
  fontFaceBlock,
  htmlTag,
  indicesOf,
  jsImport,
  jsonURL,
  nonScriptTypes,
  resolveLocalRef,
  resourceAttr,
  scriptBlock,
  submatch,
  vendored,
} from './match';
import { type Finding, findEntries, isRegular, type Report, ReportSchemaVersion, sortFindings } from './report';
import { AllowMarker, isIgnoredRef, isRemote, remoteProblem, scriptRules } from './rules';
import { blank, lexJS, stripCSSComments, stripHTMLComments } from './strip';

export { type Finding, findingString, problems, type Report, ReportSchemaVersion, writeJSON } from './report';

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
          const msg = '@font-face 使用了 font-display: ' + value + '；并行抽帧时部分帧会抓到回退字体，请改为 block';
          this.add(src, base + blockStart + m.index, 'font-display', msg);
        }
      }
      for (const u of body.matchAll(cssURL)) {
        const [value, start] = submatch(body, indicesOf(u));
        const missing = this.missingLocalFile(src, value);
        if (missing !== '') {
          const msg = '@font-face 的字体文件不在镜头目录里（' + missing + '）；渲染时静默 404，字体回退且不报错';
          this.add(src, base + blockStart + start, 'font-missing', msg);
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
    const resolved = resolveLocalRef(src.rel, ref);
    if (resolved === '') {
      return '';
    }
    if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) {
      return resolved;
    }
    return isRegular(path.join(this.root, resolved)) ? '' : resolved;
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
    const resolved = resolveLocalRef(src.rel, ref);
    if (resolved === '' || resolved === '.' || resolved === '..' || resolved.startsWith('../')) {
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
