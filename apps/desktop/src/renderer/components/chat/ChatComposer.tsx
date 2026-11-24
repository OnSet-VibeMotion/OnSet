import type { MutableRefObject, RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentChoice, AgentsResponse, Attachment } from '../../types';
import { AgentPicker } from '../AgentPicker';
import { Icon } from '../Icon';
import { AttachmentTray } from './AttachmentTray';
import {
  applySuggestion,
  findToken,
  parseCommand,
  type SlashCommand,
  type Suggestion,
  slashCommands,
  suggest,
} from './complete';
import type { PolishState } from './Polish';

export interface ChatComposerProps {
  agents: AgentsResponse | null;
  choice: AgentChoice;
  onChoice: (choice: AgentChoice) => void;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  completion: { scenes: string[]; files: string[] };
  draft: string;
  onDraftChange: (value: string) => void;
  onPickDraft: (text: string, caret: number) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pendingCaretRef: MutableRefObject<number | null>;
  running: boolean;
  sending: boolean;
  uploading: boolean;
  busy: string;
  error: string;
  canSend: boolean;
  showStop: boolean;
  menu: '' | 'history' | 'plus';
  onMenu: (menu: '' | 'history' | 'plus') => void;
  polishing: PolishState | null;
  undoPolish: string | null;
  onUndoPolish: () => void;
  onPolish: () => void;
  onSend: () => void;
  onCancel: () => void;
  onUpload: (files: FileList | File[]) => void;
  onRunCommand: (command: SlashCommand, arg: string) => void;
}

export function ChatComposer(props: ChatComposerProps) {
  const [dragging, setDragging] = useState(false);
  // @ 与 / 补全：光标位置决定正在补全哪一段；按 Esc 收起，直到再输入。
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const token = dismissed ? null : findToken(props.draft, caret);
  const suggestions = token ? suggest(token, props.completion, props.running) : [];
  useEffect(() => setPicked(0), [token?.trigger, token?.query, token?.command?.name]);

  // 输入框随内容长高，最高 min(184px, 34vh)，再多就滚动。
  useLayoutEffect(() => {
    const el = props.textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.min(184, window.innerHeight * 0.34))}px`;
  }, [props.draft]);

  useLayoutEffect(() => {
    const el = props.textareaRef.current;
    if (el && props.pendingCaretRef.current !== null) {
      el.setSelectionRange(props.pendingCaretRef.current, props.pendingCaretRef.current);
      setCaret(props.pendingCaretRef.current);
      props.pendingCaretRef.current = null;
    }
  }, [props.draft]);

  const pick = (item: Suggestion) => {
    if (!token) return;
    if (token.trigger === '/' && token.command) {
      setDismissed(false);
      props.onRunCommand(token.command, item.value);
      return;
    }
    if (token.trigger === '/') {
      const command = slashCommands.find((c) => c.name === item.value);
      if (command && !command.arg) {
        setDismissed(false);
        props.onRunCommand(command, '');
        return;
      }
    }
    const next = applySuggestion(props.draft, token, item);
    props.onPickDraft(next.text, next.caret);
  };

  const handleSend = () => {
    if (parseCommand(props.draft.trim())) setDismissed(false);
    props.onSend();
  };

  return (
    <footer className="composer">
      <div
        className={'composer-shell' + (dragging ? ' dragging' : '')}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!e.dataTransfer?.files.length) return;
          e.preventDefault();
          props.onUpload(e.dataTransfer.files);
        }}
      >
        {props.attachments.length > 0 && (
          <AttachmentTray attachments={props.attachments} onRemove={props.onRemoveAttachment} />
        )}
        {suggestions.length > 0 && token && (
          <ul
            className="completions"
            id="completions"
            role="listbox"
            aria-label={token.trigger === '@' ? '引用镜头或文件' : '命令'}
          >
            <li className="completions-head" aria-hidden="true">
              {token.trigger === '@'
                ? '引用镜头或文件，发送时一起交给 AI'
                : token.command
                  ? `/${token.command.name} 的参数`
                  : '命令'}
            </li>
            {suggestions.map((item, index) => (
              <li
                key={item.kind + item.value}
                role="option"
                aria-selected={index === picked}
                className={'completion' + (index === picked ? ' on' : '')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setPicked(index)}
              >
                <span className={'completion-kind ' + item.kind} aria-hidden="true">
                  {item.kind === 'command' ? (
                    '/'
                  ) : item.kind === 'scene' ? (
                    <Icon name="film" size={12} />
                  ) : item.kind === 'page' ? (
                    '↗'
                  ) : (
                    <Icon name="file" size={12} />
                  )}
                </span>
                <span className="completion-label">{item.label}</span>
                {item.hint && <span className="completion-hint">{item.hint}</span>}
              </li>
            ))}
            <li className="completions-foot" aria-hidden="true">
              ↑↓ 选择 · Enter / Tab 确定 · Esc 收起
            </li>
          </ul>
        )}
        <label htmlFor="prompt" className="sr-only">
          消息
        </label>
        <textarea
          id="prompt"
          ref={props.textareaRef}
          rows={2}
          value={props.draft}
          placeholder={props.running ? '补充要求会排在这一轮之后…' : '说说要改什么，可以拖入或粘贴文章、图片、音频'}
          onChange={(e) => {
            props.onDraftChange(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart ?? 0);
            setDismissed(false);
          }}
          onKeyUp={(e) => {
            if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
              setCaret(e.currentTarget.selectionStart ?? 0);
            }
          }}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onBlur={() => window.setTimeout(() => setDismissed(true), 150)}
          onFocus={() => setDismissed(false)}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="completions"
          aria-autocomplete="list"
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
              e.preventDefault();
              props.onUpload(files);
            }
          }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || e.keyCode === 229;
            if (suggestions.length > 0 && !composing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setPicked((index) => (index + step + suggestions.length) % suggestions.length);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                e.preventDefault();
                pick(suggestions[Math.min(picked, suggestions.length - 1)]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
            // Enter 发送，Shift+Enter 换行；输入法组字时的 Enter 不算。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              if (props.canSend) handleSend();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="plus">
            <button
              className="icon-button"
              id="plus"
              aria-label="添加"
              title="添加文件"
              aria-expanded={props.menu === 'plus'}
              onClick={() => props.onMenu(props.menu === 'plus' ? '' : 'plus')}
            >
              <Icon name="plus" size={13} />
            </button>
            {props.menu === 'plus' && (
              <div className="popover menu up" role="menu">
                <button
                  role="menuitem"
                  id="upload"
                  onClick={() => {
                    props.onMenu('');
                    fileInput.current?.click();
                  }}
                >
                  <Icon name="attach" size={13} />
                  上传文件或图片
                  <span className="muted small">也可以拖进来或粘贴</span>
                </button>
              </div>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = e.currentTarget.files;
                if (files) props.onUpload(files);
                e.currentTarget.value = '';
              }}
            />
          </div>
          <AgentPicker
            agents={props.agents}
            value={props.choice}
            disabled={props.running || props.sending}
            onChange={props.onChoice}
          />
          <span className="spacer" />
          {props.undoPolish !== null && (
            <button className="link polish-undo" id="polish-undo" onClick={props.onUndoPolish} title="换回润色前的原话">
              换回原话
            </button>
          )}
          <button
            className="icon-button polish-button"
            id="polish"
            disabled={
              props.draft.trim() === '' ||
              props.polishing?.status === 'working' ||
              parseCommand(props.draft.trim()) !== null
            }
            onClick={props.onPolish}
            aria-label="润色"
            title="润色：把这句话改得更清楚、更好执行（不会发送）"
          >
            <Icon name="spark" size={13} />
          </button>
          {props.showStop ? (
            <button
              id="cancel-turn"
              className="primary-slot stop"
              onClick={props.onCancel}
              aria-label="停止本轮"
              title="停止本轮（排队的消息一并作废）"
            >
              <span className="stop-glyph" />
            </button>
          ) : (
            <button
              id="send"
              className="primary-slot"
              disabled={!props.canSend}
              onClick={handleSend}
              aria-label={props.running ? '排队发送' : '发送'}
              title={props.running ? '排到这一轮之后发送（Enter）' : '发送（Enter，Shift+Enter 换行）'}
            >
              <Icon name="up" size={13} />
            </button>
          )}
        </div>
      </div>
      {(props.error || props.uploading || (props.busy && !props.running)) && (
        <p className={'composer-hint' + (props.error ? ' error' : '')}>
          {props.error || (props.uploading ? '上传中…' : `项目正忙：${props.busy}`)}
        </p>
      )}
    </footer>
  );
}
