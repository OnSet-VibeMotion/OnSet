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

function collectTopCommentDeviations(rel: string, ext: string, raw: string, out: EngineDeviation[]): void {
  const chunks: Array<{ line: number; text: string }> = [];
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    chunks.push(...extractCommentsByLine(raw, lexJS(raw).withStrings));
  } else if (ext === '.css') {
    chunks.push(...extractCommentsByLine(raw, stripCSSComments(raw)));
  } else if (ext === '.html' || ext === '.htm') {
    const noHtml = stripHTMLComments(raw);
    chunks.push(...extractCommentsByLine(raw, noHtml));
    // 同时提取前 50 行内 <script> 与 <style> 中的真实 JS/CSS 注释（忽略字符串字面量）。
    for (const match of noHtml.matchAll(scriptBlock)) {
      const loc = indicesOf(match);
      const start = loc[2]![0];
      const body = noHtml.slice(start, loc[2]![1]);
      const baseLine = noHtml.slice(0, start).split('\n').length - 1;
      if (baseLine >= 50) continue;
      for (const c of extractCommentsByLine(body, lexJS(body).withStrings, 50 - baseLine)) {
        chunks.push({ line: baseLine + c.line, text: c.text });
      }
    }
    for (const match of noHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      const start = (match.index ?? 0) + match[0].indexOf('>') + 1;
      const body = match[1];
      const baseLine = noHtml.slice(0, start).split('\n').length - 1;
      if (baseLine >= 50) continue;
      for (const c of extractCommentsByLine(body, stripCSSComments(body), 50 - baseLine)) {
        chunks.push({ line: baseLine + c.line, text: c.text });
      }
    }
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
