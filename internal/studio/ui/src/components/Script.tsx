import { useEffect, useRef, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import type { Attachment, ScriptNode, ScriptResponse } from '../types';
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

function Nodes({ nodes }: { nodes: ScriptNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'alt':
            if (!node.text) {
              return (
                <span key={index} class="spoken-only" title="只朗读、不显示在字幕里">
                  {node.spoken}
                </span>
              );
            }
            if (!node.spoken) {
              return (
                <span key={index} class="display-only" title="只显示在字幕里、不朗读">
                  {node.text}
                </span>
              );
            }
            return (
              <ruby key={index} class="alt" title={`字幕显示「${node.text}」，配音读作「${node.spoken}」`}>
                {node.text}
                <rt>{node.spoken}</rt>
              </ruby>
            );
          case 'phrase':
            return (
              <mark key={index} class="phrase" title={`受保护短语 ${node.id}：会单独出现在画面上，配音不能在中间断开`}>
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
}

/** 口播稿页：终稿排成可读的文稿，标出读法与受保护短语；确认或提意见都交给对话。 */
export function ScriptTab({ version, busy, onQuick, onFile }: Props) {
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
      const fragment = sel.getRangeAt(0).cloneContents();
      fragment.querySelectorAll('rt, .spoken-only').forEach((el) => el.remove());
      setSelection((fragment.textContent ?? '').trim());
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  if (error) return <div class="empty">{error}</div>;
  if (!script) return <div class="empty">正在读取…</div>;
  if (!script.path) {
    return (
      <div class="empty">
        还没有口播稿。开始制作后，编排工具会先把文章整理成口播终稿（{scriptFinalPath}），稿子整理好就显示在这里，你确认之后才会配音。
      </div>
    );
  }

  const voiced = !!script.voice;
  const toggleMarks = () => {
    setMarks(!marks);
    writeBool('am-studio.script-marks', !marks);
  };
  const quote = selection.length > 120 ? selection.slice(0, 120) + '…' : selection;

  return (
    <div class="script-tab">
      <div class="toolbar">
        <span class="script-name">{script.final ? '口播终稿' : '原稿'}</span>
        <button class="link mono small" onClick={() => onFile(script.path)} title="在文件页查看原文">
          {script.path}
        </button>
        <span class="spacer" />
        {script.final && script.blocks && (
          <button class={marks ? 'on' : ''} aria-pressed={marks} onClick={toggleMarks} title="标出读法与受保护短语">
            标记
          </button>
        )}
        {script.final && (
          <>
            <button
              disabled={!selection}
              title={selection ? '把选中的这段带进输入框' : '先在稿子里选中一段文字'}
              onClick={() => onQuick(`口播稿这一段要改：\n> ${quote}\n\n`, [], true)}
            >
              针对所选提意见
            </button>
            <button onClick={() => onQuick('口播稿要改：', [], true)}>提修改意见</button>
            {!voiced && (
              <button
                class="primary"
                disabled={!!busy}
                title={busy ? '编排工具正在工作，等这一轮结束' : '确认终稿，开始正式配音'}
                onClick={() => onQuick('口播稿我看过了，没问题，按这版继续配音。', [])}
              >
                确认，开始配音
              </button>
            )}
          </>
        )}
      </div>

      {script.final && (
        <div class="script-stats small muted">
          {script.stats && <span>{script.stats.units} 字</span>}
          {script.stats && <span>{script.stats.paragraphs} 段</span>}
          {script.estimate_seconds ? <span title="按每秒 4.5 字估算">预计 {duration(script.estimate_seconds)}</span> : null}
          {script.voice && <span class="voiced">已配音 {duration(script.voice.seconds)}</span>}
          {script.stats && script.stats.phrases > 0 && <span>{script.stats.phrases} 个受保护短语</span>}
          {script.updated_at && <span>更新于 {new Date(script.updated_at).toLocaleString()}</span>}
        </div>
      )}
      {voiced && script.final && <div class="script-note">已按这版配音。改稿之后要重新配音、对齐，已渲染的镜头可能要跟着改。</div>}
      {script.parse_error && (
        <div class="script-note bad">终稿的标记写错了：{script.parse_error}。下面是原文；让编排工具修好标记再配音。</div>
      )}

      {script.blocks ? (
        <article ref={body} class={`script-body${marks ? ' marks' : ''}`}>
          {script.blocks.map((block, index) =>
            block.kind === 'heading' ? (
              <h3 key={index} class={`level-${Math.min(block.level ?? 1, 3)}`}>
                {block.text}
              </h3>
            ) : (
              <p key={index}>
                <Nodes nodes={block.nodes ?? []} />
              </p>
            ),
          )}
        </article>
      ) : (
        <div ref={body}>
          {!script.final && <p class="small muted">还没有口播终稿，下面是项目里的原稿。</p>}
          <pre class="text">{script.content}</pre>
        </div>
      )}

      {script.final && script.blocks && marks && (
        <p class="script-legend small muted">
          <ruby class="alt">
            2025年<rt>二零二五年</rt>
          </ruby>{' '}
          上面是字幕、下面是读法 · <mark class="phrase">受保护短语</mark> 会单独上画面 ·{' '}
          <span class="spoken-only">嗯</span> 只读不显示 · <span class="display-only">注</span> 只显示不读
        </p>
      )}

      {script.change_log && (
        <details class="script-changes">
          <summary>修改记录（与原稿相比）</summary>
          <Markdown text={script.change_log.content} />
        </details>
      )}
    </div>
  );
}
