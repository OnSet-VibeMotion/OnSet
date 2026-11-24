import { useEffect, useState } from 'react';
import { api, errorText, rawURL } from '../../api';
import type { Attachment, ProjectFilmStyle, Scene } from '../../types';
import { BrandKitsPanel } from '../BrandKits';
import { Markdown } from '../chat/Markdown';
import { FilmStyleDialog, FilmStylePicker, Poster, styleKey, useFilmStyles } from '../FilmStyles';
import { Empty, type RunAction } from './shared';

/** 镜头 id 换成镜头页用的编号（按镜头顺序，两位数）；找不到时原样返回。 */
function sceneNumber(scenes: Scene[], id: string): string {
  const index = scenes.findIndex((s) => s.id === id);
  return index < 0 ? id : '镜头 ' + String(index + 1).padStart(2, '0');
}

/**
 * 风格页：本项目的风格。默认风格（不写 film_style 的镜头用它）展示海报、适用题材、STYLE.md，
 * 可以换或去掉；下面是个别镜头点名用的其他风格，每种列出在用的镜头，可以添加、去掉。
 * 装、换、添加、去掉都是 onset film-style 写任务，会占项目写锁，进度在右上角任务里。
 * 哪个镜头用哪种风格要改分镜计划与 scene.json，那是编排工具的事，这里只读。
 */
export function StyleTab({
  version,
  run,
  scenes,
  onScene,
  onQuick,
}: {
  version: number;
  run: RunAction;
  scenes: Scene[];
  onScene: (id: string) => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
}) {
  const [info, setInfo] = useState<ProjectFilmStyle | null>(null);
  const [error, setError] = useState('');
  const [doc, setDoc] = useState('');
  const [docKey, setDocKey] = useState('');
  const [dialog, setDialog] = useState<'' | 'default' | 'extra'>('');
  const [confirmRemove, setConfirmRemove] = useState('');
  const films = useFilmStyles(dialog !== '' || info?.installed === false);
  useEffect(() => {
    api<ProjectFilmStyle>('/api/film-style').then(
      (result) => {
        setInfo(result);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version]);
  const extras = info?.extras ?? [];
  const shown = extras.find((x) => styleKey(x.manifest) === docKey);
  const docFile = shown ? shown.style_file : info?.style_file;
  useEffect(() => {
    setDoc('');
    if (docFile)
      fetch(rawURL(docFile, version))
        .then((r) => (r.ok ? r.text() : ''))
        .then(setDoc, () => setDoc(''));
  }, [docFile, version]);
  const rendered = scenes.some((scene) => scene.exists);
  const staleNote = rendered
    ? '已经渲染的镜头不会自动更新，要重渲染才会换成新风格（整批渲染时 onset 会按输入指纹把它们判为过期）。'
    : '';
  const installedKeys = new Set([
    ...(info?.manifest ? [styleKey(info.manifest)] : []),
    ...extras.map((x) => styleKey(x.manifest)),
  ]);
  const pickDefault = (slug: string) => {
    if (!slug) return;
    setDialog('');
    run('/api/film-style', { style: slug, replace: true });
  };
  const addExtra = (slug: string) => {
    if (!slug) return;
    setDialog('');
    run('/api/film-style', { style: slug, as: 'extra' });
  };
  const sceneLinks = (ids: string[]) =>
    ids.length === 0 ? (
      <span className="muted small">还没有镜头用它</span>
    ) : (
      <span className="style-scenes">
        {ids.map((id) => (
          <button key={id} className="chip" onClick={() => onScene(id)} title={id}>
            {sceneNumber(scenes, id)}
          </button>
        ))}
      </span>
    );
  const dialogs = (
    <>
      {dialog === 'default' && info?.manifest && (
        <FilmStyleDialog
          title="换默认风格"
          intro={
            <>
              不写风格的镜头都会换成新风格；点名了其他风格的镜头不受影响。换好后分镜要按新风格的镜头语言改一遍，「接下来」会提示你交给
              AI。{staleNote}
            </>
          }
          confirm="换成这个风格"
          data={films.data}
          error={films.error}
          posterVersion={films.posterVersion}
          selected={styleKey(info.manifest)}
          installed={installedKeys}
          onPick={pickDefault}
          onClose={() => setDialog('')}
        />
      )}
      {dialog === 'extra' && (
        <FilmStyleDialog
          title="添加一种风格"
          intro="装进项目后，在对话里告诉 AI 哪些镜头或段落用它；它会改分镜，并给风格交界设计画面里的过渡。"
          confirm="添加"
          data={films.data}
          error={films.error}
          posterVersion={films.posterVersion}
          selected=""
          installed={installedKeys}
          onPick={addExtra}
          onClose={() => setDialog('')}
        />
      )}
    </>
  );
  const others = (
    <section className="style-others">
      <header>
        <h4>其他风格</h4>
        <span className="muted small">个别镜头用；相邻镜头风格不同时，交界会在画面里换过去</span>
        <span className="spacer" />
        <button onClick={() => setDialog('extra')} id="add-film-style">
          添加一种风格
        </button>
      </header>
      {(info?.missing ?? []).map((m) => (
        <p key={m.scene + m.style} className="bad small">
          {sceneNumber(scenes, m.scene)} 点名的 {m.style} 没装进项目，渲染会失败：添加这种风格，或在对话里让 AI 改掉。
        </p>
      ))}
      {extras.length === 0 ? (
        <p className="muted small">
          还没有。想让某一段换一种画法（回忆、片中片、对照……），先在这里添加，再在对话里说哪几个镜头用它。
        </p>
      ) : (
        <div className="style-other-list film-styles">
          {extras.map((x) => {
            const key = styleKey(x.manifest);
            return (
              <article key={key} className={'style-other' + (docKey === key ? ' on' : '')} data-style={key}>
                {x.style ? <Poster style={x.style} /> : <span className="fs-poster" />}
                <div className="style-other-text">
                  <strong>
                    {x.manifest.cn} <span className="muted">{x.manifest.en}</span>
                  </strong>
                  {sceneLinks(x.scenes)}
                  <div className="toolbar">
                    <button className="ghost" onClick={() => setDocKey(docKey === key ? '' : key)}>
                      {docKey === key ? '看默认风格' : '看说明'}
                    </button>
                    {confirmRemove === key ? (
                      <>
                        <button
                          className="danger"
                          onClick={() => (setConfirmRemove(''), run('/api/film-style', { remove: true, style: key }))}
                        >
                          确认去掉
                        </button>
                        <button className="ghost" onClick={() => setConfirmRemove('')}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="ghost"
                        disabled={x.scenes.length > 0}
                        title={x.scenes.length > 0 ? '还有镜头在用：先在对话里让 AI 把它们换掉' : ''}
                        onClick={() => setConfirmRemove(key)}
                      >
                        去掉
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
  if (error) return <Empty>{error}</Empty>;
  if (!info) return <Empty>正在读整片风格…</Empty>;
  if (!info.installed) {
    return (
      <div className="style-tab">
        {dialogs}
        <section className="style-intro">
          <div className="style-intro-head">
            <span className="style-badge">没有默认风格</span>
            <h3>各镜头按文案自己定视觉</h3>
          </div>
          <p>
            从风格来源里选一种作为默认风格，镜头都画成它：渲染器会遵守它的
            STYLE.md（外观、材质、配色逻辑、字体、动效与镜头语法），内容仍来自每个镜头自己的文案。个别段落之后还可以换成别的风格。
            {staleNote}
          </p>
        </section>
        {extras.length > 0 && others}
        <FilmStylePicker
          layout="grid"
          data={films.data}
          error={films.error}
          posterVersion={films.posterVersion}
          selected=""
          onPick={pickDefault}
        />
        <BrandKitsPanel version={version} onQuick={(text) => onQuick(text, [])} />
      </div>
    );
  }
  const style = info.style;
  const manifest = info.manifest!;
  return (
    <div className="style-tab">
      {dialogs}
      <section className="style-intro film">
        {style && (
          <div className="film-styles">
            <Poster style={style} full />
          </div>
        )}
        <div className="style-intro-head">
          <span className="style-badge">默认风格</span>
          <h3>
            {manifest.cn} <span className="muted">{manifest.en}</span>
          </h3>
        </div>
        {style && (
          <p>
            {style.category_cn} · 适合 {style.uses.join('、')}
            <br />
            <span className="muted small">
              {style.summary}（来源 {manifest.source}，版本 {manifest.version.slice(0, 12)}）
            </span>
          </p>
        )}
        {scenes.length > 0 && <div className="style-used">{sceneLinks(info.default_scenes ?? [])}</div>}
        <div className="toolbar">
          <button onClick={() => setDialog('default')}>换默认风格</button>
          {confirmRemove === '@default' ? (
            <>
              <span className="muted small">去掉后不写风格的镜头回到自主定视觉。{staleNote}</span>
              <button
                className="danger"
                onClick={() => {
                  setConfirmRemove('');
                  run('/api/film-style', { remove: true });
                }}
              >
                确认去掉
              </button>
              <button onClick={() => setConfirmRemove('')}>取消</button>
            </>
          ) : (
            <button onClick={() => setConfirmRemove('@default')}>去掉默认风格</button>
          )}
        </div>
      </section>
      {others}
      {doc ? (
        <section className="style-doc">
          {shown && <p className="style-doc-head muted small">{shown.manifest.cn} 的 STYLE.md</p>}
          <Markdown text={doc} />
        </section>
      ) : (
        <Empty>正在读 STYLE.md…</Empty>
      )}
      <BrandKitsPanel version={version} onQuick={(text) => onQuick(text, [])} />
    </div>
  );
}
