import { useEffect, useMemo, useState } from 'react';
import type { Attachment, BeatState } from '../../types';
import { Markdown } from '../chat/Markdown';
import { splitTitle } from './grid';

/** 故事与文案：片子讲什么、每段画面里出现哪些字。还在定故事时展开，之后收起成标题加梗概。 */
export function Story({
  story,
  open,
  onQuick,
}: {
  story: NonNullable<BeatState['story']>;
  open: boolean;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
}) {
  const { title, body } = useMemo(() => splitTitle(story.content), [story.content]);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open]);
  // 收起时只留标题下的第一段（约定里是一句话梗概），只在它是普通文字时显示。
  const first =
    body
      .split(/\n\s*\n/)
      .map((para) => para.trim())
      .find((para) => para !== '') ?? '';
  const lead = /^([-*+]\s|\d+\.\s|#|\||>|```)/.test(first) ? '' : first;
  return (
    <section className="beat-story" data-ctx-source={story.path} data-ctx-label="故事与文案">
      <div className="beat-story-head">
        <span className="label">故事与文案</span>
        <span className="path">{story.path}</span>
      </div>
      {title && <h2 className="beat-story-title">{title}</h2>}
      {expanded ? (
        <div className="beat-story-body">
          <Markdown text={body} />
        </div>
      ) : (
        lead && (
          <div className="beat-story-lead">
            <Markdown text={lead} />
          </div>
        )
      )}
      <div className="beat-actions">
        <button className="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开全文'}
        </button>
        <button onClick={() => onQuick('故事和文案：', [], true)}>提修改意见</button>
      </div>
    </section>
  );
}
