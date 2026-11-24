import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, post } from '../api';
import './review-annotations.css';

export type ReviewMarkKind = 'pen' | 'rectangle' | 'ellipse' | 'arrow' | 'text';

export interface ReviewPoint {
  x: number;
  y: number;
}

export interface ReviewMark {
  kind: ReviewMarkKind;
  points: ReviewPoint[];
  text?: string;
}

export interface ReviewAnnotation {
  version: 1;
  coordinate_space: 'normalized';
  width: number;
  height: number;
  marks: ReviewMark[];
}

export interface ReviewCommentItem {
  id: string;
  revision: number;
  text: string;
  status: 'open' | 'resolved';
  stale: boolean;
  source_revision: string;
  anchor: {
    scope: 'project' | 'frame' | 'element';
    target: string;
    scene_id?: string;
    time_seconds?: number;
    annotation?: ReviewAnnotation;
  };
  created_at: string;
  updated_at: string;
}

const ToolLabels: Array<[ReviewMarkKind, string]> = [
  ['rectangle', '矩形'],
  ['ellipse', '椭圆'],
  ['arrow', '箭头'],
  ['pen', '画笔'],
  ['text', '标签'],
];

/** 渲染归一化矢量标绘的 SVG 图层（供画面预览叠加与历史批注回显共用）。 */
export function AnnotationSvgLayer(props: {
  marks: readonly ReviewMark[];
  draftMark?: ReviewMark | null;
  interactive?: boolean;
  onPointerDown?: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove?: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp?: (e: ReactPointerEvent<SVGSVGElement>) => void;
}) {
  const all = props.draftMark ? [...props.marks, props.draftMark] : props.marks;
  return (
    <svg
      className={`review-annotation-svg${props.interactive ? ' interactive' : ''}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
    >
      <defs>
        <marker id="onset-review-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent)" />
        </marker>
      </defs>
      {all.map((m, idx) => {
        if (m.kind === 'rectangle' && m.points.length === 2) {
          const [a, b] = m.points;
          return (
            <rect
              key={idx}
              x={Math.min(a.x, b.x) * 100}
              y={Math.min(a.y, b.y) * 100}
              width={Math.abs(b.x - a.x) * 100}
              height={Math.abs(b.y - a.y) * 100}
              className="review-mark-shape"
            />
          );
        }
        if (m.kind === 'ellipse' && m.points.length === 2) {
          const [a, b] = m.points;
          return (
            <ellipse
              key={idx}
              cx={((a.x + b.x) / 2) * 100}
              cy={((a.y + b.y) / 2) * 100}
              rx={(Math.abs(b.x - a.x) / 2) * 100}
              ry={(Math.abs(b.y - a.y) / 2) * 100}
              className="review-mark-shape"
            />
          );
        }
        if (m.kind === 'arrow' && m.points.length === 2) {
          const [a, b] = m.points;
          return (
            <line
              key={idx}
              x1={a.x * 100}
              y1={a.y * 100}
              x2={b.x * 100}
              y2={b.y * 100}
              className="review-mark-line"
              markerEnd="url(#onset-review-arrow)"
            />
          );
        }
        if (m.kind === 'pen' && m.points.length >= 2) {
          const d = m.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x * 100},${p.y * 100}`).join(' ');
          return <path key={idx} d={d} className="review-mark-line" />;
        }
        if (m.kind === 'text' && m.points.length === 1 && m.text) {
          const [p] = m.points;
          return (
            <text key={idx} x={p.x * 100} y={p.y * 100} className="review-mark-text">
              {m.text}
            </text>
          );
        }
        return null;
      })}
    </svg>
  );
}

/** 批量审片批注清单面板：展示待修/已解决批注、支持新增带矢量标绘的批注、并一键发给剧组批量返修。 */
export function ReviewCommentsPanel(props: {
  version: number;
  sceneId?: string;
  target?: string;
  timeSeconds?: number;
  canvasSize?: { width: number; height: number };
  onScene?: (id: string) => void;
  onBatchSend?: (prompt: string) => void;
}) {
  const [comments, setComments] = useState<ReviewCommentItem[]>([]);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [tool, setTool] = useState<ReviewMarkKind>('arrow');
  const [text, setText] = useState('');
  const [marks, setMarks] = useState<ReviewMark[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = filter === 'open' ? '?status=open' : '';
    api<{ comments: ReviewCommentItem[] }>('/api/review-comments' + q).then(
      (res) => {
        setComments(res.comments ?? []);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [filter]);

  useEffect(() => {
    load();
  }, [load, props.version]);

  const addComment = async () => {
    const clean = text.trim();
    if (!clean) return;
    setBusy(true);
    setError('');
    try {
      const target = props.target || (props.sceneId ? `scenes/${props.sceneId}/scene.mp4` : 'final.mp4');
      const isFrame = props.timeSeconds !== undefined || Boolean(props.sceneId);
      const anchor: ReviewCommentItem['anchor'] = isFrame
        ? {
            scope: 'frame',
            target,
            scene_id: props.sceneId,
            time_seconds: props.timeSeconds ?? 0,
            ...(marks.length > 0
              ? {
                  annotation: {
                    version: 1,
                    coordinate_space: 'normalized',
                    width: props.canvasSize?.width ?? 1080,
                    height: props.canvasSize?.height ?? 1440,
                    marks,
                  },
                }
              : {}),
          }
        : { scope: 'project', target };
      await post('/api/review-comments', { text: clean, anchor });
      setText('');
      setMarks([]);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleResolve = async (item: ReviewCommentItem) => {
    setBusy(true);
    try {
      const resp = await fetch(`/api/review-comments/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expected_revision: item.revision,
          status: item.status === 'open' ? 'resolved' : 'open',
        }),
      });
      if (!resp.ok) throw new Error(`更新批注失败（HTTP ${resp.status}）`);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: ReviewCommentItem) => {
    setBusy(true);
    try {
      const resp = await fetch(
        `/api/review-comments/${encodeURIComponent(item.id)}?expected_revision=${item.revision}`,
        { method: 'DELETE' },
      );
      if (!resp.ok) throw new Error(`删除批注失败（HTTP ${resp.status}）`);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const sendBatch = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await post<{ count: number; prompt: string }>('/api/review-comments/batch-prompt', {});
      if (res.prompt && props.onBatchSend) props.onBatchSend(res.prompt);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const openCount = comments.filter((c) => c.status === 'open').length;

  return (
    <section className="review-comments" aria-label="审片批注清单">
      <div className="review-comments-head">
        <h4>审片批注清单（{openCount} 条待修）</h4>
        <div className="review-comments-tabs">
          <button className={filter === 'open' ? 'primary' : 'ghost'} onClick={() => setFilter('open')}>
            待修
          </button>
          <button className={filter === 'all' ? 'primary' : 'ghost'} onClick={() => setFilter('all')}>
            全部
          </button>
          {openCount > 0 && props.onBatchSend && (
            <button className="primary" disabled={busy} onClick={sendBatch}>
              批量发给剧组返修
            </button>
          )}
        </div>
      </div>

      <div className="review-comments-composer">
        <div className="review-comments-tools">
          {ToolLabels.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className={tool === kind ? 'primary' : 'ghost'}
              onClick={() => setTool(kind)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() =>
              setMarks((prev) => [
                ...prev,
                tool === 'text'
                  ? { kind: 'text', points: [{ x: 0.5, y: 0.5 }], text: '此处调整' }
                  : {
                      kind: tool,
                      points: [
                        { x: 0.25, y: 0.25 },
                        { x: 0.75, y: 0.75 },
                      ],
                    },
              ])
            }
          >
            + 添加标绘（{marks.length}）
          </button>
        </div>
        <div className="review-comments-row">
          <input
            value={text}
            placeholder={props.sceneId ? `记录镜头 ${props.sceneId} 的修改意见…` : '记录整片审片修改意见…'}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
          <button className="primary" disabled={busy || !text.trim()} onClick={addComment}>
            加入清单
          </button>
        </div>
      </div>

      {error && <p className="error-line">{error}</p>}

      {comments.length === 0 ? (
        <p className="muted small">
          暂无{filter === 'open' ? '待修' : ''}批注。可以在看片时连续记下多条意见，再一键批量交给剧组返修。
        </p>
      ) : (
        <ul className="review-comments-list">
          {comments.map((item) => (
            <li key={item.id} className={`review-comment-item${item.status === 'resolved' ? ' resolved' : ''}`}>
              <div className="review-comment-meta">
                <span>
                  {item.anchor.scene_id ? `镜头 ${item.anchor.scene_id}` : item.anchor.target}
                  {item.anchor.time_seconds !== undefined ? ` @ ${item.anchor.time_seconds.toFixed(2)}s` : ''}
                </span>
                {item.stale && <span className="review-comment-stale">源码已变，坐标可能过期</span>}
                {item.anchor.annotation && (
                  <span className="muted small">{item.anchor.annotation.marks.length} 处标绘</span>
                )}
              </div>
              <p className="review-comment-body">{item.text}</p>
              <div className="review-comment-actions">
                {item.anchor.scene_id && props.onScene && (
                  <button className="ghost" onClick={() => props.onScene?.(item.anchor.scene_id!)}>
                    定位镜头
                  </button>
                )}
                <button className="ghost" disabled={busy} onClick={() => toggleResolve(item)}>
                  {item.status === 'open' ? '标为已解决' : '重新打开'}
                </button>
                <button className="ghost" disabled={busy} onClick={() => remove(item)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
