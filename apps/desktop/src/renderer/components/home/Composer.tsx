import type { RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { AgentsResponse, CanvasOption, ModeOption, StylesResponse } from '../../types';
import { FilmStyleDialog, styleKey, useFilmStyles } from '../FilmStyles';
import type { HomeMaterial } from '../homeAttachments';
import { Icon } from '../Icon';
import { CanvasGlyph, Dropdown, FolderPicker, MenuItem, Typewriter } from './Controls';
import { formatSize, placeholders, shortCanvas, type Template } from './helpers';

export function Composer(props: {
  text: string;
  onText: (value: string) => void;
  files: HomeMaterial[];
  onRemoveFile: (index: number) => void;
  onAddFiles: (list: FileList | File[]) => void;
  onDrop: (data: DataTransfer) => Promise<void>;
  reading: number;
  working: boolean;
  canSend: boolean;
  prereqsReady: boolean;
  drawingOk: boolean;
  drawingReason: string;
  styles: StylesResponse | null;
  canvas: string;
  canvasInfo?: CanvasOption;
  onCanvas: (id: string) => void;
  modes: ModeOption[];
  mode: string;
  modeInfo: ModeOption;
  onMode: (id: string) => void;
  currentTemplate?: Template;
  onClearTemplate: () => void;
  agents: AgentsResponse | null;
  tool: string;
  onTool: (id: string) => void;
  filmStyle: string;
  onFilmStyle: (style: string) => void;
  parent: string;
  onParent: (path: string) => void;
  onSubmit: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [menu, setMenu] = useState('');
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = props.textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [props.text, props.textareaRef]);

  const films = useFilmStyles(menu === 'style' || props.filmStyle !== '');
  const styleLabel = props.filmStyle
    ? (films.data?.styles.find((s) => styleKey(s) === props.filmStyle)?.cn ?? props.filmStyle)
    : '不用整片风格';

  return (
    <div className="composer-card">
      <div
        className={'input-card' + (focused ? ' focused' : '') + (dragging ? ' dragging' : '')}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setFocused(false);
        }}
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
          if (!props.working) void props.onDrop(e.dataTransfer);
        }}
      >
        {props.files.length > 0 && (
          <ul className="home-tray" aria-label="引用素材">
            {props.files.map((file, index) => (
              <li key={index} title={file.name}>
                <Icon name={file.kind === 'directory' ? 'folder' : 'file'} size={15} />
                <span className="doc-text">
                  <span className="doc-name">{file.name}</span>
                  <span className="doc-meta">
                    {file.kind === 'directory'
                      ? `文件夹引用 · ${file.files.length} 个文件`
                      : formatSize(file.file.size)}
                  </span>
                </span>
                <button className="remove" aria-label="移除" onClick={() => props.onRemoveFile(index)}>
                  <Icon name="close" size={9} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {props.reading > 0 && <p role="status">正在读取文件夹…</p>}
        <div className="prompt-editor">
          <textarea
            id="home-prompt"
            ref={props.textareaRef}
            rows={2}
            value={props.text}
            aria-label="想做什么视频"
            onChange={(e) => props.onText(e.currentTarget.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData?.files;
              if (pasted && pasted.length) {
                e.preventDefault();
                props.onAddFiles(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                props.onSubmit();
              }
            }}
          />
          {!props.text && (
            <Typewriter
              lines={props.currentTemplate ? [props.currentTemplate.example] : placeholders}
              paused={focused}
            />
          )}
        </div>
        <div className="input-foot">
          <div className="foot-left">
            <button
              className="round"
              aria-label="添加文件"
              title="添加文章、图片、音频（也可以拖进来或粘贴）"
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="plus" size={14} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.currentTarget.files) props.onAddFiles(e.currentTarget.files);
                e.currentTarget.value = '';
              }}
            />
            <Dropdown
              id="canvas"
              open={menu === 'canvas'}
              onOpen={(open) => setMenu(open ? 'canvas' : '')}
              label={
                <>
                  <CanvasGlyph canvas={props.canvasInfo} />
                  {props.canvasInfo ? shortCanvas(props.canvasInfo) : '画幅'}
                </>
              }
            >
              {props.styles?.canvases.map((c) => (
                <MenuItem
                  key={c.id}
                  selected={c.id === props.canvas}
                  title={shortCanvas(c)}
                  desc={`${c.width}×${c.height}`}
                  icon={<CanvasGlyph canvas={c} />}
                  onClick={() => {
                    props.onCanvas(c.id);
                    setMenu('');
                  }}
                />
              ))}
            </Dropdown>
            <Dropdown
              id="mode"
              open={menu === 'mode'}
              onOpen={(open) => setMenu(open ? 'mode' : '')}
              label={props.modeInfo.label}
            >
              {props.modes.map((m) => (
                <MenuItem
                  key={m.id}
                  selected={m.id === props.mode}
                  title={m.label}
                  desc={m.hint}
                  onClick={() => {
                    props.onMode(m.id);
                    setMenu('');
                  }}
                />
              ))}
            </Dropdown>
            {props.currentTemplate && (
              <button className="template-chip" title="取消模板" onClick={props.onClearTemplate}>
                {props.currentTemplate.title}
                <Icon name="close" size={9} />
              </button>
            )}
          </div>
          <div className="foot-right">
            <Dropdown
              id="tool"
              align="right"
              open={menu === 'tool'}
              onOpen={(open) => setMenu(open ? 'tool' : '')}
              label={props.agents?.agents.find((a) => a.id === props.tool)?.label ?? 'AI'}
            >
              {props.agents?.agents.map((agent) => (
                <MenuItem
                  key={agent.id}
                  selected={agent.id === props.tool}
                  disabled={!agent.installed}
                  title={agent.label}
                  desc={agent.installed ? '编排整片制作' : (agent.hint ?? `没有找到 ${agent.command}`)}
                  onClick={() => {
                    props.onTool(agent.id);
                    setMenu('');
                  }}
                />
              ))}
            </Dropdown>
            <button
              id="home-send"
              className="send"
              disabled={!props.canSend}
              onClick={props.onSubmit}
              aria-label="开始制作"
              title={
                !props.prereqsReady
                  ? '先在工具准备页把必需的工具装好'
                  : !props.drawingOk
                    ? props.drawingReason
                    : '建项目并开始制作（Enter）'
              }
            >
              {props.working ? <span className="spinner" /> : <Icon name="up" size={15} />}
            </button>
          </div>
        </div>
        {focused && !props.working && <span className="composer-beam" aria-hidden="true" />}
      </div>
      <div className="under-row">
        <div className="dropdown">
          <button
            id="home-style"
            className="chip-button flat"
            aria-haspopup="dialog"
            aria-expanded={menu === 'style'}
            onClick={() => setMenu('style')}
          >
            整片风格：{styleLabel}
            <Icon name="chevron" size={10} />
          </button>
        </div>
        {menu === 'style' && (
          <FilmStyleDialog
            title="选一种整片风格"
            intro="全片所有镜头都画成这一种风格；内容仍来自每个镜头自己的文案。"
            data={films.data}
            error={films.error}
            posterVersion={films.posterVersion}
            selected={props.filmStyle}
            none={{
              title: '不用整片风格',
              desc: '每个镜头按文案自己定配色、字体与动效。AI 会在稿件审核时按题材推荐几种风格，也可以之后在「风格」页里选。',
            }}
            onPick={props.onFilmStyle}
            onClose={() => setMenu('')}
          />
        )}
        <FolderPicker
          value={props.parent}
          open={menu === 'folder'}
          onOpen={(open) => setMenu(open ? 'folder' : '')}
          onChange={props.onParent}
        />
      </div>
    </div>
  );
}
