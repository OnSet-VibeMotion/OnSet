import { createContext } from 'preact';
import { useContext, useMemo } from 'preact/hooks';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { rawURL } from '../../api';

/**
 * 回复、修改记录等 Markdown 的渲染：GitHub 风格（表格、任务列表、删除线、嵌套列表、
 * 自动链接……）由 marked 解析，DOMPurify 清洗后才进页面——回复里的原始 HTML 只剩
 * 安全的标签，脚本、事件属性、javascript: 链接一律去掉。
 *
 * 在此之上做几件对话里用得着的事：
 *   - 标题降两级（回复里的 # 不该比面板标题还大）；
 *   - 外部链接新窗口打开；指向项目文件的链接、写成行内代码的项目文件路径可点，打开文件页；
 *   - 代码块带语言标签与「复制」按钮；表格可以横向滚动；
 *   - 图片写项目里的相对路径时从项目读。
 */

export interface MarkdownLinks {
  /** 项目里的文件，用来认出可点的路径。 */
  files: string[];
  onOpenFile?: (path: string) => void;
}

/** 由对话面板提供：Markdown 据此把项目文件路径变成可点的链接。 */
export const MarkdownContext = createContext<MarkdownLinks>({ files: [] });

const marked = new Marked({ gfm: true, breaks: true });

/**
 * 中文里的粗体、斜体、删除线。CommonMark 的「左右侧分隔符」规则按英文标点设计：
 * `**字体还没下载。**下载` 里收尾的 ** 前面是标点、后面紧跟汉字，不算右侧分隔符，
 * 整段原样显示星号（marked 与 GitHub 都这样）。编排工具的中文回复里这种写法到处都是，
 * 所以在内置规则之前先按「成对的符号、里面不以空白开头结尾」认一遍。
 */
const cjkEmphasis = [
  { name: 'cjkStrong', mark: '**', tag: 'strong', pattern: /^\*\*(?=\S)([\s\S]*?\S)\*\*/ },
  { name: 'cjkDel', mark: '~~', tag: 'del', pattern: /^~~(?=\S)([\s\S]*?\S)~~/ },
] as const;
marked.use({
  extensions: cjkEmphasis.map(({ name, mark, tag, pattern }) => ({
    name,
    level: 'inline' as const,
    start(src: string) {
      const index = src.indexOf(mark);
      return index < 0 ? undefined : index;
    },
    tokenizer(this: { lexer: { inlineTokens: (src: string) => unknown[] } }, src: string) {
      const match = pattern.exec(src);
      if (!match) return undefined;
      return { type: name, raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(this: { parser: { parseInline: (tokens: unknown[]) => string } }, token: { tokens?: unknown[] }) {
      return `<${tag}>${this.parser.parseInline(token.tokens ?? [])}</${tag}>`;
    },
  })) as never,
});

function projectPath(value: string, files: Set<string>): string {
  const clean = value.trim().replace(/^\.\//, '').replace(/[，。,.;；:：]+$/, '');
  return files.has(clean) ? clean : '';
}

function render(text: string, files: Set<string>): string {
  const html = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'], FORBID_ATTR: ['style'] });
  const root = document.createElement('template');
  root.innerHTML = clean;
  const doc = root.content;

  // 标题降级：h1→h3、h2→h4，其余→h5。
  doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const level = Number(heading.tagName[1]);
    const tag = level <= 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
    if (heading.tagName.toLowerCase() === tag) return;
    const next = document.createElement(tag);
    next.innerHTML = heading.innerHTML;
    heading.replaceWith(next);
  });

  doc.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer');
      return;
    }
    const path = projectPath(decodeURIComponent(href), files);
    if (path) {
      link.setAttribute('href', '#');
      link.setAttribute('data-open-file', path);
      link.classList.add('file-link');
    } else if (!href.startsWith('#') && !/^mailto:/i.test(href)) {
      // 既不是外链也不是项目文件：留下文字，去掉打不开的链接。
      link.replaceWith(...Array.from(link.childNodes));
    }
  });

  doc.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return;
    const path = projectPath(decodeURIComponent(src), files);
    if (path) img.setAttribute('src', rawURL(path));
    else img.remove();
  });

  // 行内代码写的是项目文件路径时可点。
  doc.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre')) return;
    const path = projectPath(code.textContent ?? '', files);
    if (path) {
      code.classList.add('file-link');
      code.setAttribute('data-open-file', path);
      code.setAttribute('title', '打开 ' + path);
    }
  });

  doc.querySelectorAll('pre').forEach((pre) => {
    pre.classList.add('prose-code');
    const code = pre.querySelector('code');
    const language = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1] ?? '';
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="code-lang"></span><span class="code-copy" role="button" tabindex="0" data-copy>复制</span>`;
    head.querySelector('.code-lang')!.textContent = language;
    pre.prepend(head);
  });

  doc.querySelectorAll('table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  });

  return root.innerHTML;
}

export function Markdown({ text }: { text: string }) {
  const links = useContext(MarkdownContext);
  const files = useMemo(() => new Set(links.files), [links.files]);
  const html = useMemo(() => render(text, files), [text, files]);
  const act = (target: HTMLElement) => {
    const copy = target.closest<HTMLElement>('[data-copy]');
    if (copy) {
      const code = copy.closest('pre')?.querySelector('code')?.textContent ?? '';
      void navigator.clipboard?.writeText(code);
      copy.textContent = '已复制';
      window.setTimeout(() => (copy.textContent = '复制'), 1200);
      return true;
    }
    const file = target.closest<HTMLElement>('[data-open-file]');
    if (file && links.onOpenFile) {
      links.onOpenFile(file.dataset.openFile ?? '');
      return true;
    }
    return false;
  };
  return (
    <div
      class="prose"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        if (act(event.target as HTMLElement)) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && act(event.target as HTMLElement)) event.preventDefault();
      }}
    />
  );
}
