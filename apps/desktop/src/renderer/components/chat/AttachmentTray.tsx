import { rawURL } from '../../api';
import type { Attachment } from '../../types';
import { Icon } from '../Icon';

export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}) {
  return (
    <ul className="tray" id="attachments">
      {attachments.map((a, index) => {
        const image = a.path && (!a.upload || /\.(png|jpe?g|webp|gif)$/i.test(a.path));
        if (a.quote || a.ref) {
          const title = a.quote ? a.label || '引用' : a.scene_id ? `镜头 ${a.scene_id}` : (a.source ?? '');
          const meta = a.quote ? a.quote.replace(/\s+/g, ' ') : a.scene_id ? '镜头' : '文件';
          return (
            <li key={index} className="doc-card quote-card" title={a.quote ? `${title}\n${a.quote}` : title}>
              <span className="quote-mark" aria-hidden="true">
                {a.quote ? '❝' : a.scene_id ? <Icon name="film" size={14} /> : <Icon name="file" size={14} />}
              </span>
              <span className="doc-text">
                <span className="doc-name">{title}</span>
                <span className="doc-meta">{meta}</span>
              </span>
              <button className="remove" onClick={() => onRemove(index)} aria-label="移除引用">
                <Icon name="close" size={9} />
              </button>
            </li>
          );
        }
        const title = a.upload ? (a.name ?? '文件') : (a.scene_id ?? '画面');
        const meta = a.upload
          ? formatSize(a.size ?? 0)
          : [
              a.seconds !== undefined && a.path ? `帧 ${Math.round(a.seconds * 30)}` : '',
              a.region ? '圈选区域' : '',
              a.selector ?? '',
            ]
              .filter(Boolean)
              .join(' · ');
        return (
          <li key={index} className={image ? 'image-card' : 'doc-card'} title={`${title}${meta ? ' · ' + meta : ''}`}>
            {image ? (
              <>
                <img src={rawURL(a.path!)} alt="" />
                {!a.upload && <span className="image-label">{[title, meta].filter(Boolean).join(' · ')}</span>}
              </>
            ) : (
              <>
                <Icon name="file" size={15} />
                <span className="doc-text">
                  <span className="doc-name">{title}</span>
                  <span className="doc-meta">{meta}</span>
                </span>
              </>
            )}
            <button className="remove" onClick={() => onRemove(index)} aria-label="移除附件">
              <Icon name="close" size={9} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}
