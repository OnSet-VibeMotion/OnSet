import type { StoryboardMotionEffect } from '../../types';
import type { OnQuick } from './StoryboardParts';
import './motion-badges.css';

function shortMotionId(ref: string): string {
  const idx = ref.indexOf(':');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

/**
 * 分镜卡片与镜头右栏的动效标签组：
 * 展示本镜选定的动效（如 `005 遮罩显现`），hover 显示摘要，缺失项标红降级；
 * 点击后将调整草稿填入对话输入框。
 */
export function MotionBadges({
  effects,
  sceneLabel,
  onQuick,
  compact = false,
}: {
  effects?: StoryboardMotionEffect[];
  sceneLabel: string;
  onQuick?: OnQuick;
  compact?: boolean;
}) {
  if (!effects || effects.length === 0) return null;

  const draftAdjust = (effect: StoryboardMotionEffect) => {
    if (!onQuick) return;
    const text = effect.missing
      ? `请修复${sceneLabel}中缺失的动效引用「${effect.ref}」，在 production/scene-plan.json（或 scene.json）的 motion_effects 中替换为有效动效或移除：`
      : `请调整${sceneLabel}的动效「${effect.name}」（${effect.ref}）：`;
    onQuick(text, [], true);
  };

  return (
    <div className={`sb-motions${compact ? ' compact' : ''}`} role="group" aria-label={`${sceneLabel} 动效`}>
      <span className="sb-motions-label">动效</span>
      {effects.map((effect) => {
        const code = shortMotionId(effect.ref);
        const title = effect.missing
          ? `未在当前动效目录中找到 ${effect.ref}，点击在对话中修复`
          : effect.summary
            ? `${effect.ref} · ${effect.summary}（点击在对话中调整）`
            : `${effect.ref}（点击在对话中调整）`;
        return (
          <button
            key={effect.ref}
            type="button"
            className={`sb-motion-badge${effect.missing ? ' missing' : ''}`}
            title={title}
            onClick={() => draftAdjust(effect)}
          >
            {effect.missing ? (
              <>
                <span className="sb-motion-code">{effect.ref}</span>
                <span>（缺失）</span>
              </>
            ) : (
              <>
                <span className="sb-motion-code">{code}</span>
                <span>{effect.name}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
