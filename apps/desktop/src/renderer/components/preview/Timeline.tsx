import type { ProjectUsage, Scene } from '../../types';
import { clock, projectUsageTitle, sceneStatus, statusText, tokenLabel, usageLabel } from './shared';

/** 镜头时间线：宽度按时长比例，底部色条是出片状态。点哪个镜头就预览哪个。 */
export function Timeline({
  scenes,
  usage,
  sceneId,
  version,
  onScene,
}: {
  scenes: Scene[];
  usage: ProjectUsage | null;
  sceneId: string;
  version: number;
  onScene: (id: string) => void;
}) {
  if (scenes.length === 0) return null;
  const total = scenes.reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0);
  // 镜头条就是缩略图：每格是那个镜头的画面，宽度按时长；状态只在出问题时用一道色条提示。
  return (
    <section className="timeline" aria-label="时间线">
      <div className="strip">
        {scenes.map((scene, index) => {
          const status = sceneStatus(scene);
          return (
            <button
              key={scene.id}
              className={`scene ${status}${scene.id === sceneId ? ' on' : ''}`}
              data-ctx-scene={scene.id}
              style={{ flex: `${scene.duration_seconds || 1} 1 0` }}
              title={`镜头 ${String(index + 1).padStart(2, '0')}（${scene.id}）${scene.duration_seconds ? ` · ${scene.duration_seconds.toFixed(1)} 秒` : ''} · ${statusText[status]}${scene.attempts ? ` · ${usageLabel(scene)}` : ''}`}
              aria-pressed={scene.id === sceneId}
              onClick={() => onScene(scene.id)}
            >
              {scene.exists && (
                <video
                  className="thumb"
                  muted
                  preload="metadata"
                  aria-hidden="true"
                  tabIndex={-1}
                  src={`/api/scenes/${encodeURIComponent(scene.id)}/asset?v=${scene.output_stamp ?? version}#t=${Math.min(1, (scene.duration_seconds || 2) / 2)}`}
                />
              )}
              <span className="scene-no" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="sr-only">
                {scene.id} {statusText[status]}
              </span>
            </button>
          );
        })}
      </div>
      <span
        className="timeline-total"
        title={
          usage && (usage.attempts > 0 || usage.orchestrator.calls > 0)
            ? `本项目 ${tokenLabel(usage.total)}\n${projectUsageTitle(usage)}`
            : undefined
        }
      >
        {total > 0 ? clock(total).replace(/\.\d+$/, '') : ''}
      </span>
    </section>
  );
}
