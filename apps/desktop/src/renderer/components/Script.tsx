import { confirmGate } from './Progress';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api';
import type { Attachment, ScriptBlock, ScriptNode, ScriptResponse } from '../types';
import { focusChatInput, readableText } from './ContextMenu';
import { Markdown } from './chat/Markdown';
import '../script.css';

/** 口播终稿在项目里的位置；聊天与文件树点到它时打开口播稿页。 */
export const scriptFinalPath = 'production/script-final.md';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // 存不下只是下次不记得开关。
  }
}

function duration(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 给正文段落编号（标题不算），右键引用时说「口播稿第 3 段」。 */
function numberParagraphs(blocks: ScriptBlock[]): { block: ScriptBlock; para: number }[] {
  let para = 0;
  return blocks.map((block) => ({ block, para: block.kind === 'para' ? ++para : 0 }));
}

/** 稿子里有没有读法或短语标记：没有就不显示图例。 */
function hasMarks(nodes: ScriptNode[]): boolean {
  return nodes.some((node) => node.kind !== 'text' || hasMarks(node.children ?? []));
}

function Nodes({ nodes }: { nodes: ScriptNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'alt':
            if (!node.text) {
              return (
                <span key={index} className="spoken-only" title="只朗读、不显示在字幕里">
                  {node.spoken}
                </span>
              );
            }
            if (!node.spoken) {
              return (
                <span key={index} className="display-only" title="只显示在字幕里、不朗读">
                  {node.text}
                </span>
              );
            }
            return (
              <ruby key={index} className="alt" title={`字幕显示「${node.text}」，配音读作「${node.spoken}」`}>
                {node.text}
                <rt>{node.spoken}</rt>
              </ruby>
            );
          case 'phrase':
            return (
              <mark key={index} className="phrase" title={`受保护短语 ${node.id}：会单独出现在画面上，配音不能在中间断开`}>
                <Nodes nodes={node.children ?? []} />
              </mark>
            );
          default:
            return <span key={index}>{node.text}</span>;
        }
      })}
    </>
  );
}

interface Props {
  version: number;
  busy: string;
  /** 把一条消息交给对话：draftOnly 为 true 时只填进输入框。 */
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onFile: (path: string) => void;
  onAttach: (attachment: Attachment) => void;
}

/** 口播稿页：终稿排成可读的文稿，标出读法与受保护短语；确认或提意见都交给对话。 */
export function ScriptTab({ version, busy, onQuick, onFile, onAttach }: Props) {
  const [script, setScript] = useState<ScriptResponse | null>(null);
  const [error, setError] = useState('');
  const [marks, setMarks] = useState(() => readBool('am-studio.script-marks', true));
  const [selection, setSelection] = useState('');
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<ScriptResponse>('/api/script').then(
      (result) => {
        setScript(result);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version]);

  // 在稿子里选中一段文字，就能针对这段提意见。
  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      if (!sel || sel.isCollapsed || !node || !body.current?.contains(node) || sel.rangeCount === 0) {
        setSelection('');
        return;
      }
      // 引用的是字幕文字：去掉标注出来的读法与只读不显示的部分。
      setSelection(readableText(sel.getRangeAt(0).cloneContents()));
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  if (error) return <div className="empty">{error}</div>;
  if (!script) return <div className="empty">正在读取…</div>;
  if (!script.path) {
    return (
      <div className="empty">
        还没有口播稿。开始制作后，AI 会先把文章整理成口播终稿（{scriptFinalPath}），稿子整理好就显示在这里，你确认之后才会配音。
      </div>
    );
  }

  const voiced = !!script.voice;
  const toggleMarks = () => {
    setMarks(!marks);
    writeBool('am-studio.script-marks', !marks);
  };

  // 第一个标题当文稿的大标题，正文里不再重复它。
  const titleIndex = script.blocks?.findIndex((block) => block.kind === 'heading') ?? -1;
  const title = titleIndex >= 0 ? script.blocks![titleIndex].text : '';
  const blocks = script.blocks?.filter((_, index) => index !== titleIndex);

  return (
    <div className="script-tab">
      <header className="script-head">
        <span className="eyebrow">
          {script.final ? '口播稿' : '原稿'}
          {script.final && (voiced ? ' · 已配音' : ' · 待确认')}
        </span>
        {title && <h1 className="script-title">{title}</h1>}
        {script.final && (
          <div className="script-stats">
            {script.stats && <span>{script.stats.units} 字</span>}
            {script.estimate_seconds ? <span title="按每秒 4.5 字估算">预计 {duration(script.estimate_seconds)}</span> : null}
            {script.voice && <span className="voiced">配音 {duration(script.voice.seconds)}</span>}
            <button className="link" onClick={() => onFile(script.path)} title={`在文件页查看原文：${script.path}`}>
              原文
            </button>
          </div>
        )}
        {script.final && (
          <div className="script-actions">
            {script.blocks && (
              <button className={marks ? 'on' : ''} aria-pressed={marks} onClick={toggleMarks} title="标出读法与受保护短语">
                标记
              </button>
            )}
            <button
              disabled={!selection}
              title={selection ? '把选中的文字加进对话的引用（也可以右键）' : '先在稿子里选中一段文字，或在段落上右键'}
              onClick={() => {
                onAttach({ quote: selection, label: '口播稿', source: script.path });
                focusChatInput();
              }}
            >
              引用所选
            </button>
            <button onClick={() => onQuick('口播稿要改：', [], true)}>提修改意见</button>
            {!voiced && script.gate && (
              <button
                className="primary"
                disabled={!!busy}
                title={busy ? 'AI 正在工作，等这一轮结束' : '确认终稿，开始正式配音'}
                onClick={() => script.gate && void confirmGate(script.gate.id, onQuick, script.gate.confirm)}
              >
                确认，开始配音
              </button>
            )}
          </div>
        )}
        {voiced && script.final && <p className="script-note">已按这版配音。改稿之后要重新配音、对齐，已渲染的镜头可能要跟着改。</p>}
        {script.parse_error && (
          <p className="script-note bad">终稿的标记写错了：{script.parse_error}。下面是原文；让 AI 修好标记再配音。</p>
        )}
      </header>

      {script.blocks ? (
        <article ref={body} className={`script-body${marks ? ' marks' : ''}`} data-ctx-source={script.path} data-ctx-label="口播稿">
          {numberParagraphs(blocks ?? []).map(({ block, para }, index) =>
            block.kind === 'heading' ? (
              <h3 key={index} className={`level-${Math.min(block.level ?? 1, 3)}`}>
                {block.text}
              </h3>
            ) : (
              <p key={index} data-ctx-para={para}>
                <span className="para-no" aria-hidden="true">
                  {String(para).padStart(2, '0')}
                </span>
                <Nodes nodes={block.nodes ?? []} />
              </p>
            ),
          )}
        </article>
      ) : (
        <div ref={body}>
          {!script.final && <p className="small muted">还没有口播终稿，下面是项目里的原稿。</p>}
          <pre className="text" data-ctx-source={script.path} data-ctx-label={script.final ? '口播稿' : '原稿'}>
            {script.content}
          </pre>
        </div>
      )}

      {script.final && script.blocks && marks && script.blocks.some((block) => hasMarks(block.nodes ?? [])) && (
        <p className="script-legend small muted">
          <ruby className="alt">
            2025年<rt>二零二五年</rt>
          </ruby>{' '}
          上面是字幕、下面是读法 · <mark className="phrase">受保护短语</mark> 会单独上画面 ·{' '}
          <span className="spoken-only">嗯</span> 只读不显示 · <span className="display-only">注</span> 只显示不读
        </p>
      )}

      {script.change_log && (
        <details className="script-changes">
          <summary>修改记录（与原稿相比）</summary>
          <Markdown text={script.change_log.content} />
        </details>
      )}
    </div>
  );
}
