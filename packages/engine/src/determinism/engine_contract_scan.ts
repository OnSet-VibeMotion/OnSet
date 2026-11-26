/**
 * 引擎契约源码信号抽取与显式偏离声明解析（供 engine_contract.ts 调用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goExt } from './gostd';
import { attrSrc, attrType, firstNonEmpty, indicesOf, scriptBlock, vendored } from './match';
import { lexJS, stripCSSComments, stripHTMLComments } from './strip';

export interface EngineDeviation {
  engine: string;
  replacement: string;
  reason: string;
  source: string;
}

export interface EngineSignals {
  hasThree: boolean;
  hasWebGL2: boolean;
  hasCanvas2D: boolean;
  fake3dHits: Set<string>;
  fakeShaderHits: Set<string>;
  deviations: EngineDeviation[];
}

const deviationCommentRe =
  /onset-engine-deviation\s*:\s*([a-z0-9_*-]+)\s*->\s*([a-z0-9_./ -]+?)\s*\|\s*reason\s*:\s*(.+)/i;
const threeImportRe =
  /(?:import\b[^;\n]*\bfrom\s*|import\s*\(\s*|require\s*\(\s*)['"](?:three(?:\/[^'"]*)?|[^'"]*\/three(?:\.module)?(?:\.min)?\.m?js)['"]/i;
const threeGlobalRe = /\bTHREE\s*\.\s*[A-Za-z_]/;
const threeScriptSrcRe = /(?:^|[/\\])three(?:\.module)?(?:\.min)?\.m?js(?:[?#]|$)/i;
const webglContextRe = /\.getContext\s*\(\s*['"](?:webgl2|webgl|experimental-webgl)['"]/i;
const canvas2dContextRe = /\.getContext\s*\(\s*['"]2d['"]/i;
const cssFake3dRe =
  /(transform-style\s*:\s*preserve-3d|\bperspective\s*(?::|\()|\brotate[XY]\s*\(|\brotate3d\s*\(|\btranslateZ\s*\(|\bmatrix3d\s*\()/gi;
const cssFakeShaderRe = /((?:-webkit-)?backdrop-filter\s*:|\bfilter\s*:\s*[^;}\n"'`]*\bblur\s*\()/gi;

export function parseDeviationString(text: string, source: string): EngineDeviation | null {
  const m = deviationCommentRe.exec(text);
  if (!m) return null;
  const engine = m[1].trim().toLowerCase();
  const replacement = m[2].trim();
  const reason = m[3].replace(/(?:\*\/|-->|<\/script>|<\/style>).*$/i, '').trim();
  if (!engine || !replacement || !reason) return null;
  return { engine, replacement, reason, source };
}

export function collectConfigDeviations(raw: unknown, source: string, out: EngineDeviation[]): void {
  if (!raw) return;
  if (typeof raw === 'string') {
    const parsed = parseDeviationString(`onset-engine-deviation: ${raw}`, source) ?? parseDeviationString(raw, source);
    if (parsed) out.push(parsed);
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) collectConfigDeviations(item, source, out);
    return;
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.deviations)) {
      collectConfigDeviations(obj.deviations, source, out);
      return;
    }
    const engine = typeof obj.engine === 'string' ? obj.engine.trim().toLowerCase() : '';
    const replacement = typeof obj.replacement === 'string' ? obj.replacement.trim() : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (engine && replacement && reason) out.push({ engine, replacement, reason, source });
  }
}

function scanScriptSignals(script: string, signals: EngineSignals): void {
  const { withStrings, codeOnly } = lexJS(script);
  if (threeImportRe.test(withStrings) || threeGlobalRe.test(codeOnly)) signals.hasThree = true;
  if (webglContextRe.test(withStrings)) signals.hasWebGL2 = true;
  if (
    (/\bcreateShader\s*\(/.test(codeOnly) &&
      (/\bshaderSource\s*\(/.test(codeOnly) || /\bcompileShader\s*\(/.test(codeOnly))) ||
    /\b(?:Raw)?ShaderMaterial\b/.test(codeOnly)
  ) {
    signals.hasWebGL2 = true;
  }
  if (canvas2dContextRe.test(withStrings)) signals.hasCanvas2D = true;
  for (const m of withStrings.matchAll(cssFake3dRe)) signals.fake3dHits.add(m[1].trim());
  for (const m of withStrings.matchAll(cssFakeShaderRe)) signals.fakeShaderHits.add(m[1].trim());
}

function scanCSSSignals(css: string, signals: EngineSignals): void {
  const stripped = stripCSSComments(css);
  for (const m of stripped.matchAll(cssFake3dRe)) signals.fake3dHits.add(m[1].trim());
  for (const m of stripped.matchAll(cssFakeShaderRe)) signals.fakeShaderHits.add(m[1].trim());
}

function extractCommentsByLine(raw: string, stripped: string, maxLine = 50): Array<{ line: number; text: string }> {
  const rawLines = raw.split('\n');
  const strippedLines = stripped.split('\n');
  const limit = Math.min(maxLine, rawLines.length);
  const out: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < limit; i++) {
    const r = rawLines[i];
    const s = strippedLines[i] ?? '';
    let comment = '';
    for (let j = 0; j < r.length; j++) {
      comment += r[j] !== s[j] ? r[j] : ' ';
    }
    if (comment.trim() !== '') out.push({ line: i + 1, text: comment });
  }
  return out;
}

/** 仅提取 CSS 中的真实块注释（跳过单/双引号字符串字面量与转义）。 */
function extractCssComments(text: string, maxLine = 50): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let line = 1;
  let quote = '';
  for (let i = 0; i < text.length && line <= maxLine; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) {
        if (text[i + 1] === '\n') line++;
        i++;
      } else if (ch === quote) {
        quote = '';
      } else if (ch === '\n') {
        line++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '/' && text[i + 1] === '*') {
      const startLine = line;
      const end = text.indexOf('*/', i + 2);
      const body = end < 0 ? text.slice(i + 2) : text.slice(i + 2, end);
      for (const piece of body.split('\n')) {
        if (line <= maxLine && piece.trim() !== '') out.push({ line, text: piece });
        line++;
      }
      line = startLine + body.split('\n').length - 1;
      if (end < 0) break;
      i = end + 1;
    } else if (ch === '\n') {
      line++;
    }
  }
  return out;
}

/**
 * 仅提取 HTML 文档中的真实注释（`<!-- ... -->`）以及 `<script>` / `<style>` 内的真实 JS/CSS 注释；
 * 跳过标签属性引号字符串、`<script>` 内字符串与 `<style>` 内字符串。
 */
function extractHtmlTopComments(raw: string, maxLine = 50): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let line = 1;
  let i = 0;
  const countLines = (s: string) => {
    let n = 0;
    for (let k = 0; k < s.length; k++) if (s[k] === '\n') n++;
    return n;
  };
  while (i < raw.length && line <= maxLine) {
    if (raw.startsWith('<!--', i)) {
      const end = raw.indexOf('-->', i + 4);
      const body = end < 0 ? raw.slice(i + 4) : raw.slice(i + 4, end);
      const startLine = line;
      for (const piece of body.split('\n')) {
        if (line <= maxLine && piece.trim() !== '') out.push({ line, text: piece });
        line++;
      }
      line = startLine + countLines(body);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (raw[i] === '<') {
      const openEnd = findTagEnd(raw, i);
      const tagText = raw.slice(i, openEnd + 1);
      const tagMatch = /^<\s*(script|style)\b/i.exec(tagText);
      line += countLines(tagText);
      i = openEnd + 1;
      if (tagMatch) {
        const tagName = tagMatch[1].toLowerCase();
        const closeRe = tagName === 'script' ? /<\/script\s*>/i : /<\/style\s*>/i;
        const rest = raw.slice(i);
        const closeMatch = closeRe.exec(rest);
        const body = closeMatch ? rest.slice(0, closeMatch.index) : rest;
        const baseLine = line - 1;
        if (baseLine < maxLine) {
          const inner =
            tagName === 'script'
              ? extractCommentsByLine(body, lexJS(body).withStrings, maxLine - baseLine)
              : extractCssComments(body, maxLine - baseLine);
          for (const c of inner) out.push({ line: baseLine + c.line, text: c.text });
        }
        line += countLines(body);
        if (!closeMatch) break;
        line += countLines(closeMatch[0]);
        i += closeMatch.index + closeMatch[0].length;
      }
      continue;
    }
    if (raw[i] === '\n') line++;
    i++;
  }
  return out;
}

function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return html.length - 1;
}

function collectTopCommentDeviations(rel: string, ext: string, raw: string, out: EngineDeviation[]): void {
  const chunks: Array<{ line: number; text: string }> = [];
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    chunks.push(...extractCommentsByLine(raw, lexJS(raw).withStrings));
  } else if (ext === '.css') {
    chunks.push(...extractCssComments(raw));
  } else if (ext === '.html' || ext === '.htm') {
    chunks.push(...extractHtmlTopComments(raw));
  }
  for (const chunk of chunks) {
    if (!chunk.text.toLowerCase().includes('onset-engine-deviation')) continue;
    const parsed = parseDeviationString(chunk.text, `${rel}:${chunk.line}`);
    if (parsed) out.push(parsed);
  }
}

/** 扫描镜头入口及引用的本地源码文件，收集引擎使用、CSS 伪装与偏离声明信号。 */
export function analyzeContractFiles(root: string, files: readonly string[], signals: EngineSignals): void {
  for (const rel of files) {
    const abs = path.join(root, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const ext = goExt(rel).toLowerCase();
    collectTopCommentDeviations(rel, ext, raw, signals.deviations);
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      if (vendored(rel, raw)) continue;
      scanScriptSignals(raw, signals);
    } else if (ext === '.css') {
      scanCSSSignals(raw, signals);
    } else if (ext === '.html' || ext === '.htm') {
      const stripped = stripHTMLComments(raw);
      for (const match of stripped.matchAll(scriptBlock)) {
        const loc = indicesOf(match);
        const attrs = stripped.slice(loc[1]![0], loc[1]![1]);
        const body = stripped.slice(loc[2]![0], loc[2]![1]);
        const srcMatch = attrSrc.exec(attrs);
        if (srcMatch) {
          const srcVal = firstNonEmpty(...srcMatch.slice(1));
          if (threeScriptSrcRe.test(srcVal)) signals.hasThree = true;
          continue;
        }
        const typeMatch = attrType.exec(attrs);
        const kind = typeMatch ? typeMatch[1].toLowerCase() : '';
        if (kind === '' || kind === 'module' || kind === 'text/javascript' || kind === 'application/javascript') {
          scanScriptSignals(body, signals);
        }
      }
      scanCSSSignals(stripped, signals);
    }
  }
}
