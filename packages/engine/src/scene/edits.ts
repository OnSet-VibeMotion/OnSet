import fs from 'node:fs';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { contained } from './scene';

/** 镜头目录里存放可视化属性覆盖的文件名。 */
export const EditsFile = 'onset-edits.json';

const BlockStart = '<!-- onset-edits:start -->';
const BlockEnd = '<!-- onset-edits:end -->';

export interface ElementEdit {
  selector: string;
  dx?: number;
  dy?: number;
  scaleX?: number;
  scaleY?: number;
  rotate?: number;
  opacity?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  text?: string;
  hidden?: boolean;
}

export interface SceneEdits {
  schema: 1;
  elements: Record<string, ElementEdit>;
}

export function emptyEdits(): SceneEdits {
  return { schema: 1, elements: {} };
}

const colorHexRe = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const colorFuncRe = /^(?:rgba?|hsla?)\(\s*[0-9.%\s,/-]+\)$/;
const colorNameRe = /^[a-zA-Z]{3,24}$/;

export function isValidColor(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 64) return false;
  return colorHexRe.test(v) || colorFuncRe.test(v) || colorNameRe.test(v);
}

export function isValidSelector(selector: string): boolean {
  const s = selector.trim();
  if (!s || s.length > 512) return false;
  if (/[\0\r\n{};<]|\/\*|\*\/|@import/i.test(s)) return false;
  // 校验括号、方括号与引号成对闭合，拦截 #[、div( 等语法残缺选择器。
  let parens = 0;
  let brackets = 0;
  let quote: '' | '"' | "'" = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') {
      if (i + 1 >= s.length) return false;
      i++;
      continue;
    }
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') parens++;
    else if (ch === ')') {
      if (--parens < 0) return false;
    } else if (ch === '[') brackets++;
    else if (ch === ']') {
      if (--brackets < 0) return false;
    }
  }
  if (quote !== '' || parens !== 0 || brackets !== 0) return false;
  if (/^[#.\s>+~]|[#.\s>+~]$/.test(s.replace(/^[#.](?=[A-Za-z_\\-])/, ''))) {
    // 裸 # / . 或悬挂组合符（如 "#[" 已在上面被拦，这里再拦 "# "、"div >"）
    if (/(?:^|[\s>+~])[#.](?:$|[\s>+~,\[:])/.test(s) || /[>+~,]$/.test(s)) return false;
  }
  return true;
}

function finiteNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} 必须是有限数字`);
  if (value < min || value > max) throw new Error(`${name} 超出允许范围（${min}..${max}）`);
  return Math.round(value * 1000) / 1000;
}

function hasEffect(edit: ElementEdit): boolean {
  return (
    (edit.dx !== undefined && edit.dx !== 0) ||
    (edit.dy !== undefined && edit.dy !== 0) ||
    (edit.scaleX !== undefined && edit.scaleX !== 1) ||
    (edit.scaleY !== undefined && edit.scaleY !== 1) ||
    (edit.rotate !== undefined && edit.rotate !== 0) ||
    edit.opacity !== undefined ||
    edit.color !== undefined ||
    edit.backgroundColor !== undefined ||
    edit.fontSize !== undefined ||
    edit.text !== undefined ||
    edit.hidden === true
  );
}

/** 校验并规范化可视化属性编辑数据，剔除无效果项与非法 CSS 值。 */
export function validateEdits(raw: unknown): SceneEdits {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('画面编辑数据必须是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== undefined && obj.schema !== 1) {
    throw new Error(`不支持的画面编辑 schema：${String(obj.schema)}`);
  }
  const rawElements = obj.elements;
  if (rawElements === undefined || rawElements === null) return emptyEdits();
  if (typeof rawElements !== 'object' || Array.isArray(rawElements)) {
    throw new Error('elements 必须是对象');
  }
  const entries = Object.entries(rawElements as Record<string, unknown>);
  if (entries.length > 200) throw new Error('单镜头最多支持 200 个元素的属性覆盖');
  const elements: Record<string, ElementEdit> = {};
  for (const [key, item] of entries) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`元素编辑项必须是对象：${key}`);
    }
    const rec = item as Record<string, unknown>;
    const selector = (typeof rec.selector === 'string' && rec.selector.trim() !== '' ? rec.selector : key).trim();
    if (!isValidSelector(selector)) throw new Error(`无效的元素选择器：${selector}`);
    const edit: ElementEdit = { selector };
    const dx = finiteNumber(rec.dx, 'dx', -10000, 10000);
    const dy = finiteNumber(rec.dy, 'dy', -10000, 10000);
    const scaleX = finiteNumber(rec.scaleX, 'scaleX', 0.05, 20);
    const scaleY = finiteNumber(rec.scaleY, 'scaleY', 0.05, 20);
    const rotate = finiteNumber(rec.rotate, 'rotate', -3600, 3600);
    const opacity = finiteNumber(rec.opacity, 'opacity', 0, 1);
    const fontSize = finiteNumber(rec.fontSize, 'fontSize', 4, 600);
    if (dx !== undefined && dx !== 0) edit.dx = dx;
    if (dy !== undefined && dy !== 0) edit.dy = dy;
    if (scaleX !== undefined && scaleX !== 1) edit.scaleX = scaleX;
    if (scaleY !== undefined && scaleY !== 1) edit.scaleY = scaleY;
    if (rotate !== undefined && rotate !== 0) edit.rotate = rotate;
    if (opacity !== undefined) edit.opacity = opacity;
    if (fontSize !== undefined) edit.fontSize = fontSize;
    if (rec.color !== undefined && rec.color !== null && rec.color !== '') {
      if (typeof rec.color !== 'string' || !isValidColor(rec.color)) throw new Error(`无效的文字颜色：${String(rec.color)}`);
      edit.color = rec.color.trim();
    }
    if (rec.backgroundColor !== undefined && rec.backgroundColor !== null && rec.backgroundColor !== '') {
      if (typeof rec.backgroundColor !== 'string' || !isValidColor(rec.backgroundColor)) {
        throw new Error(`无效的背景颜色：${String(rec.backgroundColor)}`);
      }
      edit.backgroundColor = rec.backgroundColor.trim();
    }
    if (rec.text !== undefined && rec.text !== null) {
      if (typeof rec.text !== 'string') throw new Error('text 必须是字符串');
      if (rec.text.length > 4000) throw new Error('text 长度不能超过 4000 字');
      edit.text = rec.text;
    }
    if (rec.hidden !== undefined && rec.hidden !== null) {
      if (typeof rec.hidden !== 'boolean') throw new Error('hidden 必须是布尔值');
      if (rec.hidden) edit.hidden = true;
    }
    if (hasEffect(edit)) elements[selector] = edit;
  }
  const sorted: Record<string, ElementEdit> = {};
  for (const k of Object.keys(elements).sort(compareBytes)) sorted[k] = elements[k];
  return { schema: 1, elements: sorted };
}

/** 生成覆盖 CSS：translate / scale / rotate 与动画写入的 transform 独立叠加，不破坏原有动效。 */
export function buildEditsCSS(edits: SceneEdits): string {
  const rules: string[] = [];
  for (const selector of Object.keys(edits.elements).sort(compareBytes)) {
    const e = edits.elements[selector];
    const decls: string[] = [];
    if (e.hidden) {
      decls.push('display: none !important', 'visibility: hidden !important');
    } else {
      if (e.dx !== undefined || e.dy !== undefined) {
        decls.push(`translate: ${e.dx ?? 0}px ${e.dy ?? 0}px !important`);
      }
      if (e.scaleX !== undefined || e.scaleY !== undefined) {
        decls.push(`scale: ${e.scaleX ?? 1} ${e.scaleY ?? 1} !important`);
      }
      if (e.rotate !== undefined) {
        decls.push(`rotate: ${e.rotate}deg !important`);
      }
      if (e.color !== undefined) decls.push(`color: ${e.color} !important`);
      if (e.backgroundColor !== undefined) decls.push(`background-color: ${e.backgroundColor} !important`);
      if (e.fontSize !== undefined) decls.push(`font-size: ${e.fontSize}px !important`);
    }
    if (decls.length > 0) rules.push(`${selector} { ${decls.join('; ')}; }`);
  }
  return rules.join('\n');
}

/**
 * 生成确定性后置脚本（仅在存在文案替换或不透明度缩放时输出）：
 * 零时钟、零随机数、零 requestAnimationFrame、零网络请求，100% 通过 determinism 扫描。
 * 在每次时间轴 seek 之后叠加不透明度倍率与文案覆盖，既保留入场/出场淡入淡出，又不会被 render(frame) 冲掉。
 */
export function buildEditsScript(edits: SceneEdits): string {
  const dynamic: { selector: string; opacity?: number; text?: string }[] = [];
  for (const selector of Object.keys(edits.elements).sort(compareBytes)) {
    const e = edits.elements[selector];
    if (e.hidden) continue;
    if (e.opacity !== undefined || e.text !== undefined) {
      const item: { selector: string; opacity?: number; text?: string } = { selector };
      if (e.opacity !== undefined) item.opacity = e.opacity;
      if (e.text !== undefined) item.text = e.text;
      dynamic.push(item);
    }
  }
  if (dynamic.length === 0) return '';
  const payload = JSON.stringify(dynamic).replace(/</g, '\\u003c');
  return [
    '(function(){',
    `var items=${payload};`,
    'function q(s){try{return document.querySelector(s);}catch(e){return null;}}',
    'function restoreOp(el,val){if(val!==undefined&&val!==""){el.style.opacity=val;}else{el.style.removeProperty("opacity");}}',
    'function clearOp(){if(window.__ONSET_EDITOR_ACTIVE__)return;for(var i=0;i<items.length;i++){var it=items[i];if(it.opacity===undefined)continue;var el=q(it.selector);if(el&&el.dataset.onsetOpApplied==="1"){restoreOp(el,el.dataset.onsetOrigOp);delete el.dataset.onsetOpApplied;delete el.dataset.onsetFrameOp;delete el.dataset.onsetAppliedOp;}}}',
    'function apply(){if(window.__ONSET_EDITOR_ACTIVE__)return;for(var i=0;i<items.length;i++){var it=items[i];var el=q(it.selector);if(!el)continue;if(it.text!==undefined){if(el.dataset.onsetOrigText===undefined){el.dataset.onsetOrigText=el.textContent||"";if(el.children&&el.children.length>0&&!el.__onsetOrigNodes){var ns=[];while(el.firstChild)ns.push(el.removeChild(el.firstChild));el.__onsetOrigNodes=ns;}}el.textContent=it.text;}if(it.opacity!==undefined){if(el.dataset.onsetOpApplied==="1"&&el.style.opacity===el.dataset.onsetAppliedOp){restoreOp(el,el.dataset.onsetFrameOp);}if(el.dataset.onsetOrigOp===undefined){el.dataset.onsetOrigOp=el.style.opacity||"";}el.dataset.onsetFrameOp=el.style.opacity||"";var cur=el.style.opacity;var base=cur!==""&&isFinite(Number(cur))?Number(cur):Number(getComputedStyle(el).opacity);if(!isFinite(base))base=1;var nextOp=String(Math.max(0,Math.min(1,base*it.opacity)));el.style.opacity=nextOp;el.dataset.onsetAppliedOp=el.style.opacity;el.dataset.onsetOpApplied="1";}}}',
    'function wrapMethod(obj,name){if(!obj||typeof obj[name]!=="function"||obj[name].__onsetEdits)return;var orig=obj[name];var fn=function(){clearOp();var r=orig.apply(this,arguments);apply();return r;};fn.__onsetEdits=true;obj[name]=fn;}',
    'function hookAll(){var tls=window.__timelines;if(tls&&typeof tls==="object"){var ks=Object.keys(tls);for(var i=0;i<ks.length;i++){wrapMethod(tls[ks[i]],"seek");wrapMethod(tls[ks[i]],"time");wrapMethod(tls[ks[i]],"progress");}}wrapMethod(window.__hf,"seek");wrapMethod(window.__player,"seek");}',
    'hookAll();apply();',
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){hookAll();apply();});}',
    'window.addEventListener("load",function(){hookAll();apply();});',
    '})();',
  ].join('');
}

const BlockRe = /\n?<!-- onset-edits:start -->[\s\S]*?<!-- onset-edits:end -->\n?/g;

/** 幂等地把覆盖块注入或移出 index.html，不破坏原有脚本与结构。 */
export function injectEditsHtml(html: string, edits: SceneEdits): string {
  const cleaned = html.replace(BlockRe, '');
  const css = buildEditsCSS(edits);
  const js = buildEditsScript(edits);
  if (!css && !js) return cleaned;
  const parts = [BlockStart];
  if (css) parts.push(`<style id="onset-edits-css">\n${css}\n</style>`);
  if (js) parts.push(`<script id="onset-edits-js">\n${js}\n</script>`);
  parts.push(BlockEnd);
  const block = '\n' + parts.join('\n') + '\n';
  const bodyClose = cleaned.lastIndexOf('</body>');
  if (bodyClose >= 0) return cleaned.slice(0, bodyClose) + block + cleaned.slice(bodyClose);
  const htmlClose = cleaned.lastIndexOf('</html>');
  if (htmlClose >= 0) return cleaned.slice(0, htmlClose) + block + cleaned.slice(htmlClose);
  return cleaned + block;
}

/** 读取镜头目录的 onset-edits.json；不存在时返回空编辑集合。 */
export function readEdits(sceneDir: string): SceneEdits {
  const file = contained(sceneDir, EditsFile, EditsFile);
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyEdits();
    throw err;
  }
  return validateEdits(JSON.parse(body));
}

/** 原子写入 onset-edits.json 并同步更新镜头 index.html 的确定性覆盖块。 */
export function writeEdits(sceneDir: string, raw: unknown): SceneEdits {
  const edits = validateEdits(raw);
  const htmlFile = contained(sceneDir, 'index.html', 'index.html');
  const editsPath = contained(sceneDir, EditsFile, EditsFile);
  if (!fs.existsSync(htmlFile)) throw new Error('镜头目录里还没有 index.html 合成文件');
  const html = fs.readFileSync(htmlFile, 'utf8');
  const nextHtml = injectEditsHtml(html, edits);
  const htmlChanged = nextHtml !== html;
  if (htmlChanged) atomicWrite(htmlFile, nextHtml, 0o644);
  try {
    if (Object.keys(edits.elements).length === 0) {
      try {
        fs.unlinkSync(editsPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    } else {
      atomicWrite(editsPath, marshalIndent(edits) + '\n', 0o644);
    }
  } catch (err) {
    if (htmlChanged) {
      try {
        atomicWrite(htmlFile, html, 0o644);
      } catch {
        // 回滚失败时保留原始错误抛出。
      }
    }
    throw err;
  }
  return edits;
}
