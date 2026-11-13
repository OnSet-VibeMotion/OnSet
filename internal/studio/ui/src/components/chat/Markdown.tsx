import type { ComponentChildren } from 'preact';

/**
 * 编排工具回复的极简 Markdown：段落、标题、有序 / 无序列表、代码块、引用、
 * 行内代码、粗体、链接。只认这几种，不引第三方库——回复里用得到的就这些，
 * 而且不渲染任何 HTML，回复内容原样当文本，没有注入的口子。
 */
export function Markdown({ text }: { text: string }) {
  return <div class="prose">{blocks(text)}</div>;
}

function blocks(text: string): ComponentChildren[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ComponentChildren[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++} class="prose-code">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      const Tag = (['h3', 'h4', 'h5'] as const)[level - 1];
      out.push(<Tag key={key++}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        i++;
        // 列表项的续行：缩进的非空行并进上一项。
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(item);
      }
      const list = items.map((item, n) => <li key={n}>{inline(item)}</li>);
      out.push(ordered ? <ol key={key++}>{list}</ol> : <ul key={key++}>{list}</ul>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key++}>{inline(quote.join(' '))}</blockquote>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])) paragraph.push(lines[i++]);
    if (paragraph.length === 0) paragraph.push(lines[i++]);
    out.push(<p key={key++}>{inlineLines(paragraph)}</p>);
  }
  return out;
}

/** 段落里的换行保留成 <br>：回复常用单换行分句。 */
function inlineLines(lines: string[]): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  lines.forEach((line, n) => {
    if (n > 0) out.push(<br key={'br' + n} />);
    out.push(...inline(line, n));
  });
  return out;
}

const token = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, salt = 0): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const part = match[0];
    const key = `${salt}-${n++}`;
    if (part.startsWith('`')) out.push(<code key={key}>{part.slice(1, -1)}</code>);
    else if (part.startsWith('**')) out.push(<strong key={key}>{part.slice(2, -2)}</strong>);
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      const href = link?.[2] ?? '';
      out.push(
        /^https?:\/\//.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {link?.[1]}
          </a>
        ) : (
          <span key={key}>{link?.[1]}</span>
        ),
      );
    }
    last = index + part.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
