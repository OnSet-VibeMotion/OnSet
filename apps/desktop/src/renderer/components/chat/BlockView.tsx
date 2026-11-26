import { useMemo, useState } from 'react';
import type { FilmStyle, SessionEvent, ViewRequest } from '../../types';
import { Icon } from '../Icon';
import { Markdown } from './Markdown';
import {
  type Block,
  findMedia,
  formatQuestionAnswersForChat,
  parseChoices,
  parseQuestionsBlock,
  parseStylePicks,
  seconds,
  splitAttachmentText,
  stripChoices,
  type TurnBlock,
} from './model';
import { QuestionCard } from './QuestionCard';
import { QuestionSummary } from './QuestionSummary';
import { clockOf, TurnEnd } from './TurnEnd';
import { ExecutionShell } from './TurnProcess';
import { AnsweredOptions, MediaStrip, pickedOption, StylePicks, viewLabel } from './TurnWidgets';

export interface BlockProps {
  block: Block;
  latest: boolean;
  now: number;
  projectPath: string;
  choicesEnabled: boolean;
  /** 这一轮之后用户说的第一句话：有它说明选项已经答过，收起没选的。 */
  answer?: string;
  onChoice: (text: string) => void;
  onFocusComposer?: () => void;
  onRetry: (text: string) => void;
  onOpenFile: (path: string) => void;
  onView: (view: ViewRequest) => void;
  onReverted: () => void;
  styles: Map<string, FilmStyle>;
  posterVersion: number;
  files: string[];
  mtimes: Map<string, number>;
  /** 每一轮推进到了哪几站（站名）。 */
  stations?: Record<string, string[]>;
}

export function blockKey(block: Block): string {
  if (block.kind === 'turn') return 't' + block.id;
  return 'e' + block.event.seq;
}

/** blocks[index] 这一轮之后用户发的第一条消息（去掉引用、附件说明）。 */
export function answerAfter(blocks: Block[], index: number): string | undefined {
  for (let i = index + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === 'user') return splitAttachmentText(block.event.text ?? '').body.trim();
  }
  return undefined;
}

export function BlockView(props: BlockProps) {
  const { block } = props;
  if (block.kind === 'user') return <UserMessage event={block.event} />;
  if (block.kind === 'note') {
    return <div className={'chat-note' + (block.event.kind === 'error' ? ' error' : '')}>{block.event.text}</div>;
  }
  return <TurnView {...props} turn={block} />;
}

function UserMessage({ event }: { event: SessionEvent }) {
  const { body, extra } = splitAttachmentText(event.text ?? '');
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = body.split('\n').length > 6 || body.length > 280;
  return (
    <div className="user-stack msg-enter">
      <div className={'message user' + (long && !expanded ? ' clamped' : '')}>
        {body}
        {long && !expanded && (
          <button className="link expand" onClick={() => setExpanded(true)}>
            展开
          </button>
        )}
      </div>
      {extra && <p className="user-extra">{extra}</p>}
      <div className="message-actions">
        <span>{clockOf(event.time)}</span>
        <button
          className="icon-button"
          aria-label="复制"
          title="复制"
          onClick={() => {
            void navigator.clipboard?.writeText(body);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? '✓' : <Icon name="copy" size={12} />}
        </button>
      </div>
    </div>
  );
}

function TurnView(props: BlockProps & { turn: TurnBlock }) {
  const { turn } = props;
  const live = turn.state === 'running' || turn.state === 'thinking';
  const elapsed = seconds(turn.start, turn.end?.time ?? props.now);
  const proseText = turn.prose.map((event) => event.text ?? '').join('\n\n');
  const proseQuestions = useMemo(() => parseQuestionsBlock(proseText, turn.id), [proseText, turn.id]);
  const choices = useMemo(() => parseChoices(proseText), [proseText]);
  const picks = useMemo(() => parseStylePicks(proseText, new Set(props.styles.keys())), [proseText, props.styles]);
  const media = useMemo(() => findMedia(proseText, props.files), [proseText, props.files]);
  const resolvedQuestions = turn.questions.filter((item) => item.resolution !== undefined);
  const optionCount = choices.length + picks.length + (proseQuestions ? proseQuestions.questions.length : 0);
  const answered = props.answer !== undefined && !props.choicesEnabled && optionCount > 0;
  const picked = answered ? pickedOption(props.answer ?? '', choices, picks, props.styles) : undefined;
  const options = (
    <>
      {picks.length > 0 && (
        <StylePicks
          picks={picks}
          styles={props.styles}
          version={props.posterVersion}
          enabled={props.choicesEnabled}
          onPick={props.onChoice}
        />
      )}
      {proseQuestions && !answered && (
        <QuestionCard
          ask={proseQuestions}
          disabled={!props.choicesEnabled}
          onSubmit={(payload) => {
            if (payload.status === 'answered' && payload.answers) {
              props.onChoice(formatQuestionAnswersForChat(proseQuestions, payload.answers, payload.note));
            }
          }}
          onSkip={props.onFocusComposer}
        />
      )}
      {choices.length > 0 && (
        <div className="choices" role="group" aria-label="选一个回复">
          {choices.map((choice, index) => (
            <button
              key={choice}
              className={'choice pill' + (index === 0 ? ' primary-pill' : '') + (choice === picked ? ' picked' : '')}
              disabled={!props.choicesEnabled}
              onClick={() => props.onChoice(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
    </>
  );
  return (
    <div className="assistant-flow msg-enter">
      {(turn.process.length > 0 || live) && (
        <ExecutionShell
          turn={turn}
          live={live}
          elapsed={elapsed}
          projectPath={props.projectPath}
          onOpenFile={props.onOpenFile}
        />
      )}
      {resolvedQuestions.map((item) => (
        <QuestionSummary key={item.request.id} item={item} />
      ))}
      {proseText.trim() && (
        <div className="message assistant" data-ctx-label="回复" data-ctx-whole>
          <Markdown text={stripChoices(proseText)} />
        </div>
      )}
      {turn.views.some((view) => view.page) && (
        <div className="view-links" aria-label="请你看的页面">
          {turn.views
            .filter((view) => view.page)
            .map((view, index) => (
              <button key={index} className="view-link" onClick={() => props.onView(view)} title="打开这一页">
                <span className="view-arrow" aria-hidden="true">
                  ↗
                </span>
                <span className="view-page">{viewLabel(view)}</span>
                {view.note && <span className="view-note">{view.note}</span>}
              </button>
            ))}
        </div>
      )}
      {media.length > 0 && <MediaStrip media={media} mtimes={props.mtimes} onOpenFile={props.onOpenFile} />}
      {answered ? (
        <AnsweredOptions picked={picked} count={optionCount}>
          {options}
        </AnsweredOptions>
      ) : (
        options
      )}
      {turn.end && (
        <TurnEnd
          turn={turn}
          latest={props.latest}
          elapsed={elapsed}
          stations={props.stations}
          onRetry={props.onRetry}
          onOpenFile={props.onOpenFile}
          onReverted={props.onReverted}
        />
      )}
    </div>
  );
}
