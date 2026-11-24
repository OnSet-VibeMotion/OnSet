import type { SceneEdits } from '../../types';
import { buildPreviewCSS, safeQuery } from './dom';
import type { HFWindow } from './types';

/** 记录原始文案、原始子节点（保护混合内容里的 span/样式与动画目标）与原始行内透明度，取消或恢复默认时完整还原。 */
export interface OrigElementMaps {
  text: Map<string, string>;
  nodes: Map<string, Node[]>;
  opacity: Map<string, string>;
}

/** 把草稿覆盖实时应用进 iframe DOM，不写磁盘。 */
export function applyLiveEditsToDoc(doc: Document, edits: SceneEdits, orig: OrigElementMaps): void {
  const win = doc.defaultView as HFWindow | null;
  if (win) win.__ONSET_EDITOR_ACTIVE__ = true;
  // 禁用 index.html 里已落盘的旧覆盖样式，统一由实时样式接管，保证撤销/重置准确。
  const baked = doc.getElementById('onset-edits-css') as HTMLStyleElement | null;
  if (baked) baked.disabled = true;

  let styleEl = doc.getElementById('onset-edits-live') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.id = 'onset-edits-live';
    (doc.head || doc.documentElement).appendChild(styleEl);
  }
  styleEl.textContent = buildPreviewCSS(edits);

  // 先把上次动态改过的文案和子节点复原（透明度已在 seekIframe 的 seek 之前清掉，这里不再用旧帧的 origOpacityRef 覆盖动画值）。
  for (const [sel, origText] of orig.text.entries()) {
    const el = safeQuery(doc, sel);
    if (el && edits.elements[sel]?.text === undefined) {
      const savedNodes = orig.nodes.get(sel);
      if (savedNodes) {
        el.replaceChildren(...savedNodes);
        orig.nodes.delete(sel);
      } else {
        el.textContent = origText;
      }
      orig.text.delete(sel);
    }
  }
  for (const sel of [...orig.opacity.keys()]) {
    if (edits.elements[sel]?.opacity === undefined) orig.opacity.delete(sel);
  }

  for (const [sel, edit] of Object.entries(edits.elements)) {
    if (edit.hidden) continue;
    const el = safeQuery(doc, sel) as HTMLElement | null;
    if (!el) continue;
    if (edit.text !== undefined) {
      if (!orig.text.has(sel)) {
        orig.text.set(sel, el.dataset.onsetOrigText ?? el.textContent ?? '');
        const bakedNodes = (el as HTMLElement & { __onsetOrigNodes?: Node[] }).__onsetOrigNodes;
        if (bakedNodes && bakedNodes.length > 0 && !orig.nodes.has(sel)) {
          orig.nodes.set(sel, bakedNodes);
        } else if (el.children.length > 0 && !orig.nodes.has(sel)) {
          const nodes: Node[] = [];
          while (el.firstChild) nodes.push(el.removeChild(el.firstChild));
          orig.nodes.set(sel, nodes);
        }
      }
      el.textContent = edit.text;
    }
    if (edit.opacity !== undefined) {
      if (!orig.opacity.has(sel)) orig.opacity.set(sel, el.dataset.onsetOrigOp ?? el.style.opacity ?? '');
      const raw = el.style.opacity;
      const base =
        raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : Number(win?.getComputedStyle(el).opacity ?? '1');
      const safeBase = Number.isFinite(base) ? base : 1;
      el.style.opacity = String(Math.max(0, Math.min(1, safeBase * edit.opacity)));
    }
  }
}

/** 把 iframe 内的 HyperFrames / GSAP / CSS 动画精准 seek 到指定秒数，并叠加草稿编辑。 */
export function seekIframeDoc(
  iframe: HTMLIFrameElement | null,
  seconds: number,
  edits: SceneEdits,
  orig: OrigElementMaps,
): void {
  const doc = iframe?.contentDocument;
  const win = iframe?.contentWindow as HFWindow | null;
  if (!doc || !win) return;
  win.__ONSET_EDITOR_ACTIVE__ = true;
  // seek 之前清掉编辑器临时覆写的行内透明度，让动画算出本帧的真实透明度。
  for (const [sel, origOp] of orig.opacity.entries()) {
    const el = safeQuery(doc, sel) as HTMLElement | null;
    if (el) {
      if (origOp === '') el.style.removeProperty('opacity');
      else el.style.opacity = origOp;
    }
  }
  try {
    if (typeof win.__hf?.seek === 'function') {
      win.__hf.seek(seconds);
    } else if (typeof win.__player?.seek === 'function') {
      win.__player.seek(seconds);
    }
    const tls = win.__timelines;
    if (tls && typeof tls === 'object') {
      for (const tl of Object.values(tls)) {
        tl?.pause?.();
        tl?.seek?.(seconds, false);
      }
    }
    if (typeof doc.getAnimations === 'function') {
      for (const anim of doc.getAnimations()) {
        anim.pause();
        anim.currentTime = seconds * 1000;
      }
    }
  } catch {
    // 某些自定义脚本在部分时间点可能抛错，不影响界面交互。
  }
  applyLiveEditsToDoc(doc, edits, orig);
}
