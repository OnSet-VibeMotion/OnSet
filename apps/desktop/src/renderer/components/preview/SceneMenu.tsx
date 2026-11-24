import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { canReveal, revealInFinder, revealLabel } from '../../reveal';
import type { Attachment, Scene } from '../../types';
import { Icon } from '../Icon';
import { type BuiltinTab, quickActions, type RunAction, usageLabel, usageTitle } from './shared';

export function SceneMenu(props: {
  scene: Scene;
  note: string;
  onNote: (value: string) => void;
  onAttach: () => void;
  onFixFrame: () => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean, appendDraft?: boolean) => void;
  onFeedback: (verdict: 'up' | 'down') => void;
  onTab?: (tab: BuiltinTab) => void;
  run: RunAction;
}) {
  const { scene, note } = props;
  const menu = useRef<HTMLDetailsElement>(null);
  const menuBody = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number; maxHeight: number } | null>(
    null,
  );

  // 菜单挂到 body 后按视口定位，避开面板动画的 transform 包含块与外层裁剪。
  // 下方放得下就往下开，否则往上开，高度不够时菜单内部滚动。
  const placeMenu = () => {
    const el = menu.current;
    const summary = el?.querySelector('summary');
    if (!el?.open || !summary) return setMenuPos(null);
    const r = summary.getBoundingClientRect();
    const gap = 8;
    const margin = 12;
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const right = Math.max(margin, window.innerWidth - r.right);
    if (below >= 360 || below >= above) setMenuPos({ top: r.bottom + gap, right, maxHeight: below });
    else setMenuPos({ bottom: window.innerHeight - r.top + gap, right, maxHeight: above });
  };

  useEffect(() => {
    if (!menuPos) return;
    const update = () => placeMenu();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [menuPos !== null]);

  // 「⋯」菜单点外面就收起；菜单里的输入框与按钮不收。
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = menu.current;
      const target = e.target as Node;
      if (el?.open && !el.contains(target) && !menuBody.current?.contains(target)) el.open = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [scene.id]);

  return (
    <details className="scene-menu" ref={menu} onToggle={placeMenu}>
      <summary aria-label="更多操作" title="更多操作">
        <Icon name="more" size={16} />
      </summary>
      {/* details toggle 异步送达，定位完成后再显示。 */}
      {menuPos &&
        createPortal(
          <div className="scene-menu-body" ref={menuBody} style={menuPos}>
            {scene.exists && (
              <div className="menu-group">
                <button id="attach-frame" onClick={props.onAttach}>
                  附当前帧到对话
                </button>
                <button onClick={props.onFixFrame} title="带上当前帧（和圈选的区域），在对话里说哪里不对">
                  修这一帧…
                </button>
              </div>
            )}
            <div className="menu-group quick-actions" role="group" aria-label="让 AI">
              <span className="menu-label">让 AI</span>
              {quickActions
                .filter((action) => scene.exists || !action.needsOutput)
                .map((action) => (
                  <button key={action.label} onClick={() => props.onQuick(action.text(scene.id), [])}>
                    {action.label}
                  </button>
                ))}
            </div>
            {scene.exists && (
              <div className="menu-group">
                <span className="menu-label">记一笔（进记忆）</span>
                <input
                  className="feedback-note"
                  value={note}
                  placeholder="说明（可选）"
                  aria-label="反馈说明"
                  onChange={(e) => props.onNote(e.currentTarget.value)}
                />
                <div className="menu-row">
                  <button title="记为好的经历" aria-label="赞" onClick={() => props.onFeedback('up')}>
                    👍 这一镜好
                  </button>
                  <button
                    title="记为需要改进的经历，下次整理时参考"
                    aria-label="踩"
                    onClick={() => props.onFeedback('down')}
                  >
                    👎 不满意
                  </button>
                </div>
              </div>
            )}
            <div className="menu-group">
              <button
                id="audition-scene"
                title="同一个镜头交给几位选手（工具 + 模型）各拍一遍，你盲评后选一份"
                onClick={() => {
                  if (menu.current) menu.current.open = false;
                  props.onTab?.('audition');
                }}
              >
                试镜：几个模型各拍一遍…
              </button>
            </div>
            <div className="menu-group">
              <button onClick={() => props.run('/api/commands/scene.validate', { scene_id: scene.id })}>校验</button>
              {canReveal && (
                <button
                  id="reveal-scene"
                  onClick={() =>
                    revealInFinder(
                      scene.exists && scene.output ? scene.directory + '/' + scene.output : scene.directory,
                    )
                  }
                >
                  {revealLabel}
                </button>
              )}
              {scene.attempts > 0 && (
                <span className="menu-note" title={usageTitle(scene)}>
                  {usageLabel(scene)}
                </span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </details>
  );
}
