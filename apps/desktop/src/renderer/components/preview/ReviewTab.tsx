import { rawURL } from '../../api';
import type { Attachment, TreeFile } from '../../types';
import { ReviewCommentsPanel } from '../ReviewAnnotations';
import { type FilmReviewProps, FilmVersions, finalLabels, reviewMismatch } from './filmReview';
import { Empty, type RunAction } from './shared';

export function ReviewTab({
  video,
  variants,
  onVideo,
  review,
  tree,
  version,
  run,
  onScene,
  onQuick,
}: FilmReviewProps & {
  tree: TreeFile[];
  version: number;
  run: RunAction;
  onScene: (id: string) => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
}) {
  const legacy = review?.available && review.unbound === true;
  const report = review?.available && (legacy || review.path === video) ? review.report : undefined;
  const images = new Set(
    [report?.sheets, report?.seams]
      .flatMap((items) => (Array.isArray(items) ? items : []))
      .filter((item) => typeof item?.image === 'string')
      .map(({ image }) => review?.report_dir + '/' + image.split(/[/\\]/).pop()),
  );
  const sheets = tree.filter((file) => images.has(file.path) && file.path.endsWith('.png'));
  const list = (title: string, items?: unknown[]) =>
    items && items.length > 0 ? (
      <section>
        <h4>{title}</h4>
        <ul className="issues">
          {items.map((item, index) => (
            <li key={index}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <div className="review-tab">
      <div className="toolbar">
        {video && variants.length === 1 && (
          <span className="small muted" title={video}>
            {finalLabels[video]}
          </span>
        )}
        <FilmVersions video={video} variants={variants} onVideo={onVideo} />
        <span className="spacer" />
        <button className="primary" disabled={!video} onClick={() => run('/api/review/run', { video })}>
          运行复查
        </button>
      </div>
      {!report ? (
        <Empty>
          {review?.available ? reviewMismatch : video && !review ? '正在读取复查报告…' : '还没有复查报告。'}
        </Empty>
      ) : (
        <>
          {legacy && <p className="scene-meta">这份旧报告未绑定影片，仅供查看。</p>}
          {list('问题', report.problems ?? report.issues)}
          {list('提示', report.hints)}
          {report.raw && <pre>{report.raw}</pre>}
          {!report.raw && !(report.problems ?? report.issues)?.length && !report.hints?.length && (
            <p className="ok-line">没有发现问题。</p>
          )}
        </>
      )}
      <div className="gallery wide">
        {sheets.map((sheet) => (
          <figure key={sheet.path}>
            <img src={rawURL(sheet.path, version)} alt="" loading="lazy" />
            <figcaption>{sheet.path.split('/').pop()}</figcaption>
          </figure>
        ))}
      </div>
      <ReviewCommentsPanel
        version={version}
        target={video}
        onScene={onScene}
        onBatchSend={(prompt) => onQuick(prompt, [])}
      />
    </div>
  );
}
