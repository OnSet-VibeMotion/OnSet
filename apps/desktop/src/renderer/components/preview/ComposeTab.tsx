import { useEffect, useRef, useState } from 'react';
import { cssSelector } from '../../selector';
import type { Attachment, ProjectState, Scene, TreeFile } from '../../types';
import { Icon } from '../Icon';
import { Empty, noSceneText, relativeScene } from './shared';

export function ComposeTab(props: {
  scene: Scene | null;
  scenes: Scene[];
  state: ProjectState | null;
  tree: TreeFile[];
  version: number;
  onAttach: (attachment: Attachment) => void;
}) {
  const { scene } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const [picking, setPicking] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setPicking(false);
    setMissing(!props.tree.some((f) => scene && f.path === relativeScene(props.state, scene) + '/index.html'));
  }, [scene?.id, props.tree]);

  // iframe 与 Studio 同源，可以直接在合成页面上挂监听，取被点中元素的选择器。
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!picking || !doc || !scene) return;
    let hovered: HTMLElement | null = null;
    const over = (e: Event) => {
      hovered?.style.removeProperty('outline');
      hovered = e.target as HTMLElement;
      hovered.style.outline = '2px dashed #d9a35f';
    };
    const click = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      hovered?.style.removeProperty('outline');
      props.onAttach({
        scene_id: scene.id,
        selector: cssSelector(e.target as Element),
        source: relativeScene(props.state, scene) + '/index.html',
      });
      setPicking(false);
    };
    doc.addEventListener('mouseover', over, true);
    doc.addEventListener('click', click, true);
    return () => {
      hovered?.style.removeProperty('outline');
      doc.removeEventListener('mouseover', over, true);
      doc.removeEventListener('click', click, true);
    };
  }, [picking, scene?.id]);

  if (!scene) return <Empty>{noSceneText(props.scenes)}</Empty>;
  if (missing) return <Empty>镜头目录里还没有 index.html 合成文件。</Empty>;
  return (
    <div className="compose-tab">
      <div className="toolbar">
        <span className="scene-title">{scene.id}</span>
        <span className="small muted">合成实时预览：镜头目录里的 index.html</span>
        <span className="spacer" />
        <button
          className={picking ? 'armed' : ''}
          aria-pressed={picking}
          id="pick-element"
          onClick={() => setPicking(!picking)}
        >
          <Icon name="pointer" />
          {picking ? '取消选取' : '选元素附到对话'}
        </button>
      </div>
      <iframe
        ref={frame}
        className="compose-frame"
        title="合成预览"
        src={`/preview/scenes/${encodeURIComponent(scene.id)}/?v=${props.version}`}
      />
    </div>
  );
}
