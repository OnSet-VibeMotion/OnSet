import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../../api';
import type { Attachment, ProjectFilmStyle, Scene } from '../../types';
import { SceneStyleDialog, styleKey } from '../FilmStyles';

/** 镜头页里的风格一行：这个镜头用的是哪种风格，「换风格」打开风格弹窗（SceneStyleDialog，分镜页也用它）。 */
export function SceneStyle(props: {
  scene: Scene;
  label: string;
  version: number;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean, appendDraft?: boolean) => void;
}) {
  const [info, setInfo] = useState<ProjectFilmStyle | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api<ProjectFilmStyle>('/api/film-style').then(setInfo, () => setInfo(null));
  }, [props.version]);
  if (!info) return null;
  const raw = info.scenes?.find((x) => x.id === props.scene.id)?.film_style ?? '';
  const extras = info.extras ?? [];
  const nameOf = (key: string) => extras.find((x) => styleKey(x.manifest) === key)?.manifest.cn;
  let label: ReactNode;
  if (raw === '')
    label = info.manifest ? (
      <>
        {info.manifest.cn}
        <span className="muted">（默认）</span>
      </>
    ) : (
      <span className="muted">自主定视觉</span>
    );
  else if (raw === 'none') label = <span className="muted">不用整片风格</span>;
  else
    label = (
      <>
        {nameOf(raw) ?? raw.split('/').pop()}
        {info.missing?.some((m) => m.scene === props.scene.id) && <span className="bad">（没装进项目）</span>}
      </>
    );
  const installed = new Set([
    ...(info.manifest ? [styleKey(info.manifest)] : []),
    ...extras.map((x) => styleKey(x.manifest)),
  ]);
  return (
    <>
      <p className="scene-style">
        <span className="muted">风格</span>
        <strong>{label}</strong>
        <button className="ghost small" id="scene-style" onClick={() => setOpen(true)}>
          换风格
        </button>
      </p>
      {open && (
        <SceneStyleDialog
          who={`${props.label}（${props.scene.id}）`}
          current={raw}
          defaultStyle={info.manifest ? { key: styleKey(info.manifest), cn: info.manifest.cn } : undefined}
          installed={installed}
          nameOf={nameOf}
          onAsk={(text) => props.onQuick(text, [], true)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
