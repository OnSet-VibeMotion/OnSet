import { cssSelector } from '../../selector';
import type { ElementEdit, SceneEdits } from '../../types';

export function emptyEdits(): SceneEdits {
  return { schema: 1, elements: {} };
}

export function cloneEdits(edits: SceneEdits): SceneEdits {
  const elements: Record<string, ElementEdit> = {};
  for (const [k, v] of Object.entries(edits.elements)) elements[k] = { ...v };
  return { schema: 1, elements };
}

export function editsEqual(a: SceneEdits, b: SceneEdits): boolean {
  return JSON.stringify(a.elements) === JSON.stringify(b.elements);
}

export function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 将 rgb()/rgba()/#hex 转为 input[type=color] 需要的 #rrggbb。 */
export function toHexColor(value: string): string {
  const v = value.trim();
  const hex3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
  if (hex3) return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`.toLowerCase();
  const hex6 = /^#([0-9a-fA-F]{6})/.exec(v);
  if (hex6) return `#${hex6[1]}`.toLowerCase();
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v);
  if (rgb) {
    const ch = (s: string) =>
      Math.max(0, Math.min(255, Math.round(Number(s))))
        .toString(16)
        .padStart(2, '0');
    return `#${ch(rgb[1])}${ch(rgb[2])}${ch(rgb[3])}`;
  }
  return '#ffffff';
}

export function isTransparent(bg: string): boolean {
  const v = bg.trim().toLowerCase();
  return !v || v === 'transparent' || v === 'rgba(0, 0, 0, 0)' || v === 'rgba(0,0,0,0)';
}

export function hasEditEffect(e: ElementEdit): boolean {
  return (
    (e.dx !== undefined && e.dx !== 0) ||
    (e.dy !== undefined && e.dy !== 0) ||
    (e.scaleX !== undefined && e.scaleX !== 1) ||
    (e.scaleY !== undefined && e.scaleY !== 1) ||
    (e.rotate !== undefined && e.rotate !== 0) ||
    e.opacity !== undefined ||
    e.color !== undefined ||
    e.backgroundColor !== undefined ||
    e.fontSize !== undefined ||
    e.text !== undefined ||
    e.hidden === true
  );
}

/** 构造注入到预览 iframe 的实时覆盖 CSS，与后端 buildEditsCSS 规则一致。 */
export function buildPreviewCSS(edits: SceneEdits): string {
  const rules: string[] = [];
  for (const [selector, e] of Object.entries(edits.elements)) {
    const decls: string[] = [];
    if (e.hidden) {
      decls.push('display: none !important', 'visibility: hidden !important');
    } else {
      if (e.dx !== undefined || e.dy !== undefined) decls.push(`translate: ${e.dx ?? 0}px ${e.dy ?? 0}px !important`);
      if (e.scaleX !== undefined || e.scaleY !== undefined) {
        decls.push(`scale: ${e.scaleX ?? 1} ${e.scaleY ?? 1} !important`);
      }
      if (e.rotate !== undefined) decls.push(`rotate: ${e.rotate}deg !important`);
      if (e.color !== undefined) decls.push(`color: ${e.color} !important`);
      if (e.backgroundColor !== undefined) decls.push(`background-color: ${e.backgroundColor} !important`);
      if (e.fontSize !== undefined) decls.push(`font-size: ${e.fontSize}px !important`);
    }
    if (decls.length > 0) rules.push(`${selector} { ${decls.join('; ')}; }`);
  }
  return rules.join('\n');
}

export function isRootOrNonVisual(el: Element, doc: Document): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body' || tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') {
    return true;
  }
  if (el.hasAttribute('data-composition-id')) return true;
  if (el.id === 'root' && el.parentElement === doc.body) return true;
  return false;
}

/** 尽量生成在当前文档内唯一命中 el 的 CSS 选择器。 */
export function uniqueSelector(doc: Document, el: Element): string {
  const base = cssSelector(el);
  try {
    const matches = doc.querySelectorAll(base);
    if (matches.length === 1 && matches[0] === el) return base;
  } catch {
    // 退回到逐级路径。
  }
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
    if (node.id) {
      parts.unshift('#' + CSS.escape(node.id));
      const candidate = parts.join(' > ');
      try {
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // 继续往上补父级。
      }
    } else {
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    if (node.tagName.toLowerCase() === 'body') break;
    node = node.parentElement;
  }
  return parts.join(' > ') || base;
}

export function hasDirectText(el: Element): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '') return true;
  }
  return el.children.length === 0 && (el.textContent ?? '').trim() !== '';
}

export function findElementAt(doc: Document, cx: number, cy: number, compW: number, compH: number): HTMLElement | null {
  if (typeof doc.elementsFromPoint !== 'function') return null;
  const list = doc.elementsFromPoint(cx, cy);
  for (const raw of list) {
    if (
      !(raw instanceof (doc.defaultView?.HTMLElement ?? HTMLElement)) &&
      !(raw instanceof (doc.defaultView?.SVGElement ?? SVGElement))
    ) {
      continue;
    }
    if (isRootOrNonVisual(raw, doc)) continue;
    const style = doc.defaultView?.getComputedStyle(raw);
    if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) <= 0.01)) {
      continue;
    }
    const rect = raw.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) continue;
    // 跳过铺满整张画布的纯透明容器，但允许选中铺满画布的背景色块或叶子节点。
    if (
      rect.width >= compW * 0.96 &&
      rect.height >= compH * 0.96 &&
      raw.children.length > 0 &&
      style &&
      isTransparent(style.backgroundColor)
    ) {
      continue;
    }
    return raw as HTMLElement;
  }
  return null;
}

export function safeQuery(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}
