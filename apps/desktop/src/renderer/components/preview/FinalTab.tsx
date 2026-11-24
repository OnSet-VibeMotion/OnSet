import { useLayoutEffect, useRef } from 'react';
import { rawURL } from '../../api';
import { playerProps } from '../../media';
import { canReveal, revealInFinder, revealLabel } from '../../reveal';
import type { TreeFile } from '../../types';
import {
  type FilmReviewProps,
  FilmVersions,
  finalLabels,
  reviewMismatch,
  reviewProblems,
  silentMaster,
} from './filmReview';
import { type BuiltinTab, clock, Empty, type RunAction } from './shared';

/** 成片页：左边是片子，右边是复查摘要与下一步。复查的细节（交界帧、联系表）在「复查」页。 */
export function FinalTab({
  video: current,
  variants,
  onVideo,
  review,
  tree,
  version,
  run,
  onTab,
}: FilmReviewProps & {
  tree: TreeFile[];
  version: number;
  run: RunAction;
  onTab?: (tab: BuiltinTab) => void;
}) {
  // 只跟随影片自身的文件版本。项目里其他文件更新时，播放器保持当前位置。
  const currentFile = tree.find((file) => file.path === current);
  const currentMtime = currentFile?.mtime;
  const currentSize = currentFile?.size;
  const selectedFilm = useRef<object | null>(null);
  useLayoutEffect(() => {
    selectedFilm.current = {};
    return () => {
      selectedFilm.current = null;
    };
  }, [current, currentMtime, currentSize]);
  const report = review?.available && review.path === current ? review.report : undefined;
  const problems = reviewProblems(report);
  const seconds = report?.media?.duration_seconds;
  const num = (v?: number, digits = 1) => (v == null ? '—' : v.toFixed(digits).replace('-', '−'));
  return (
    <div className="final-tab">
      <div className="scene-layout">
        <div className="scene-stage">
          {current ? (
            <div className="stage-frame">
              <video {...playerProps} preload="metadata" src={rawURL(current, currentMtime ?? version)} />
            </div>
          ) : (
            <Empty>还没有成片。镜头都出片后，可以先拼接无声母版。</Empty>
          )}
        </div>
        <aside className="scene-info">
          <span className="eyebrow">成片{seconds ? ` · ${clock(seconds).replace(/\.\d+$/, '')}` : ''}</span>
          <h1 className="scene-title">{current ? (finalLabels[current] ?? current) : '还没有成片'}</h1>
          <FilmVersions video={current} variants={variants} onVideo={onVideo} />
          {report ? (
            <dl className="final-review">
              <dt>复查</dt>
              <dd className={problems.length ? 'bad' : 'ok'}>
                {problems.length ? (
                  <button className="link" onClick={() => onTab?.('review')}>
                    {problems.length} 个问题，去看
                  </button>
                ) : (
                  '没有问题'
                )}
              </dd>
              {report.expected_frames != null && (
                <>
                  <dt>帧数</dt>
                  <dd className="mono">
                    {report.counted_frames ?? '—'} / {report.expected_frames}
                  </dd>
                </>
              )}
              {report.loudness && (
                <>
                  <dt>响度</dt>
                  <dd className="mono">{num(report.loudness.integrated_lufs)} LUFS</dd>
                  <dt>真峰</dt>
                  <dd className="mono">{num(report.loudness.true_peak_dbtp)} dBTP</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="scene-meta">
              {review?.available ? reviewMismatch : current && !review ? '正在读取复查报告…' : '还没有复查。'}
            </p>
          )}
          {current !== silentMaster && report?.ok && !review?.can_approve && (
            <p className="scene-meta">当前视频需要重新通过交付复查，才能确认发布。</p>
          )}
          <div className="scene-actions">
            {current && review?.can_approve && report?.video_sha256 && (
              <button
                className="primary"
                id="final-approve"
                title="确认后会把这次制作里记下的问题整理成经验（调用一次 AI），然后去发布页"
                onClick={() => {
                  const startedFrom = selectedFilm.current;
                  run(
                    '/api/memory/actions/consolidate',
                    { final: true, video: current, video_sha256: report.video_sha256 },
                    () => {
                      if (selectedFilm.current === startedFrom) onTab?.('publish');
                    },
                  );
                }}
              >
                确认可用，去发布
              </button>
            )}
            {current && (
              <button onClick={() => run('/api/review/run', { video: current })}>{report ? '重新复查' : '复查'}</button>
            )}
          </div>
          <div className="final-more">
            <button className="link" onClick={() => run('/api/commands/project.concat')}>
              拼接无声母版
            </button>
            <button className="link" onClick={() => run('/api/render/all')}>
              渲染全部镜头
            </button>
            {canReveal && current && (
              <button className="link" id="reveal-final" onClick={() => revealInFinder(current)}>
                {revealLabel}
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
