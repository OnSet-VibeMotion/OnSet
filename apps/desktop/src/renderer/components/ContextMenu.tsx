import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment } from '../types';
import '../context-menu.css';

/**
 * 工作台的右键菜单：按点到的东西给出「引用到对话」等动作，没有可做的就让浏览器自己的菜单出来。
 *
 * 页面元素用 data 属性声明自己是什么，菜单只认这几个：
 *   data-ctx-source="项目内路径"  data-ctx-label="口播稿"   一块可以引用文字的内容（选中文字时用）
 *   data-ctx-para="3"                                         其中的一段（没选文字时可以整段引用）
 *   data-ctx-scene="scene-003"                                一个镜头
 *   data-ctx-file="项目内路径"                                一个文件
 * 输入框、文本框里保留浏览器菜单（要用它粘贴、拼写检查）。
 */

export interface ContextActions {
  onAttach: (attachment: Attachment) => void;
  /** 把一句话填进输入框（draftOnly）或直接发出，可带附件。 */
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onScene: (id: string) => void;
  onFile: (path: string) => void;
}

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

interface MenuState {
  x: number;
  y: number;
  title: string;
  groups: Item[][];
}

/** 元素里给人看的文字：去掉标注出来的读法、只读不显示的部分与口播稿的段落编号。 */
export function readableText(node: Node): string {
  const clone = node.cloneNode(true) as Element | DocumentFragment;
  clone.querySelectorAll?.('rt, .spoken-only, .para-no').forEach((el) => el.remove());
  return (clone.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 右键点在选中的文字上时，返回那段文字与选区所在的元素。 */
function selectedText(target: Element): { text: string; anchor: Element | null } {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.containsNode(target, true)) return { text: '', anchor: null };
  const range = sel.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const anchor = container instanceof Element ? container : container.parentElement;
  return { text: readableText(range.cloneContents()), anchor };
}

function excerpt(text: string, limit = 24): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function focusChatInput() {
  window.setTimeout(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus(), 0);
}

function buildMenu(target: Element, actions: ContextActions): Omit<MenuState, 'x' | 'y'> | null {
  const groups: Item[][] = [];
  let title = '';
  const quote = (text: string, label: string, source?: string, draft?: string) => {
    const attachment: Attachment = { quote: text, label, source: source || undefined };
    if (draft) actions.onQuick(draft, [attachment], true);
    else actions.onAttach(attachment);
    focusChatInput();
  };

  // 选中的文字：最常用，排第一组。
  const { text, anchor } = selectedText(target);
  const sourceEl = (anchor ?? target).closest<HTMLElement>('[data-ctx-source], [data-ctx-label]');
  if (text) {
    const source = sourceEl?.dataset.ctxSource ?? '';
    const para = (anchor ?? target).closest<HTMLElement>('[data-ctx-para]')?.dataset.ctxPara;
    const label = (sourceEl?.dataset.ctxLabel ?? '选中的文字') + (para ? `第 ${para} 段` : '');
    title = `「${excerpt(text)}」`;
    groups.push([
      { label: '引用到对话', hint: '加进输入框上方的引用', run: () => quote(text, label, source) },
      { label: '引用并说哪里不满意…', run: () => quote(text, label, source, '这段我不满意：') },
      { label: '复制', run: () => copy(text) },
    ]);
  }

  // 一段内容（没选文字时整段引用）。
  const paraEl = target.closest<HTMLElement>('[data-ctx-para]');
  if (!text && paraEl) {
    const block = paraEl.closest<HTMLElement>('[data-ctx-source], [data-ctx-label]');
    const source = block?.dataset.ctxSource ?? '';
    const label = `${block?.dataset.ctxLabel ?? ''}第 ${paraEl.dataset.ctxPara} 段`;
    const paraText = readableText(paraEl);
    if (paraText) {
      title = title || label;
      groups.push([
        { label: '引用这一段到对话', run: () => quote(paraText, label, source) },
        { label: '引用这一段并说哪里不满意…', run: () => quote(paraText, label, source, '这段我不满意：') },
        { label: '复制这一段', run: () => copy(paraText) },
      ]);
    }
  }

  // 一整块可引用的内容（例如编排工具的一条回复、一个文件的全文），没选文字时整块引用。
  if (!text && !paraEl) {
    const block = target.closest<HTMLElement>('[data-ctx-label]');
    if (block && block.dataset.ctxWhole !== undefined) {
      const blockText = readableText(block);
      const label = block.dataset.ctxLabel ?? '';
      if (blockText) {
        title = title || label;
        groups.push([
          { label: `引用这条${label}`, run: () => quote(blockText.slice(0, 4000), label, block.dataset.ctxSource) },
          { label: '复制', run: () => copy(blockText) },
        ]);
      }
    }
  }

  const sceneId = target.closest<HTMLElement>('[data-ctx-scene]')?.dataset.ctxScene;
  if (sceneId) {
    title = title || `镜头 ${sceneId}`;
    const ref: Attachment = { ref: true, scene_id: sceneId };
    groups.push([
      {
        label: `引用镜头 ${sceneId} 到对话`,
        run: () => {
          actions.onAttach(ref);
          focusChatInput();
        },
      },
      { label: '说说这个镜头哪里不满意…', run: () => (actions.onQuick(`镜头 ${sceneId} 我不满意：`, [ref], true), focusChatInput()) },
      { label: '打开这个镜头', run: () => actions.onScene(sceneId) },
      { label: '复制镜头编号', run: () => copy(sceneId) },
    ]);
  }

  const file = target.closest<HTMLElement>('[data-ctx-file]')?.dataset.ctxFile;
  if (file) {
    title = title || file;
    groups.push([
      {
        label: '引用这个文件到对话',
        run: () => {
          actions.onAttach({ ref: true, source: file });
          focusChatInput();
        },
      },
      { label: '打开', run: () => actions.onFile(file) },
      { label: '复制路径', run: () => copy(file) },
    ]);
  }

  return groups.length ? { title, groups } : null;
}

export function ContextMenu(props: ContextActions) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const actions = useRef(props);
  actions.current = props;

  useEffect(() => {
    const open = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || !(target instanceof Element)) return;
      // 输入框里、按住 Shift 时用浏览器自己的菜单。
      if (event.shiftKey || target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!target.closest('.workspace')) return;
      const built = buildMenu(target, actions.current);
      if (!built) return;
      event.preventDefault();
      setMenu({ ...built, x: event.clientX, y: event.clientY });
    };
    document.addEventListener('contextmenu', open);
    return () => document.removeEventListener('contextmenu', open);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof MouseEvent && box.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // 贴着窗口边缘时往回收，不让菜单跑出屏幕。
  useLayoutEffect(() => {
    const el = box.current;
    if (!menu || !el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={box} className="ctx-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      {menu.title && <div className="ctx-title">{menu.title}</div>}
      {menu.groups.map((group, index) => (
        <div key={index} className="ctx-group">
          {group.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className="ctx-item"
              onClick={() => {
                setMenu(null);
                item.run();
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
      <div className="ctx-foot">按住 Shift 右键用浏览器菜单</div>
    </div>
  );
}
