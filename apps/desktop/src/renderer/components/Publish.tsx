import { useEffect, useState } from 'react';
import { api, rawURL } from '../api';
import type { RunAction } from './Preview';
import '../publish.css';

/**
 * 发布页。publish.md 的 frontmatter 是给校验器看的合同，正文又把同样的内容排了一遍表；
 * 原样贴出来时，发布要用的标题、简介、话题和封面埋在几十行字段中间。这里按「发布时要做什么」排：
 * 状态 → 要复制的文案 → 封面 → 还剩哪些人工检查，规格与证据收进折叠。不显示 Markdown 原文：
 * Studio 里这一页就是发布助手，文件只是数据来源；聊天、文件树里点到 publish.md 也会切到这一页。
 * 只读：改动经对话由编排工具改 publish.md，合格与否以「发布校验」（onset validate publish）为准。
 */

interface PublishCover {
  path: string;
  width?: number;
  height?: number;
  error?: string;
}

interface PublishResponse {
  available: boolean;
  covers: PublishCover[];
  data?: Record<string, any>;
  platform_name?: string;
  parse_error?: string;
}

const statusText: Record<string, { label: string; tone: string; hint: string }> = {
  draft: { label: '草稿', tone: 'todo', hint: '成片或发布信息还没齐。' },
  pending_manual_checks: { label: '待人工检查', tone: 'todo', hint: '机器检查都过了，还差下面几项要你亲自确认。' },
  blocked: { label: '有问题', tone: 'bad', hint: '成片、规格或证据有异常，先点「发布校验」看原因。' },
  ready: { label: '可以发布', tone: 'ok', hint: '所有检查都完成了。' },
};

const checkNames: Record<string, string> = {
  headphones: '戴耳机完整听一遍',
  phone_speaker: '用手机外放完整听一遍',
  cover_preview: '在平台上传页预览封面',
  rights_confirmed: '确认配乐、配音与素材的版权',
};

const checkStatus: Record<string, { label: string; tone: string }> = {
  pending: { label: '待检查', tone: 'todo' },
  passed: { label: '已通过', tone: 'ok' },
  done: { label: '已完成', tone: 'ok' },
  confirmed: { label: '已确认', tone: 'ok' },
  failed: { label: '未通过', tone: 'bad' },
  not_applicable: { label: '不适用', tone: 'na' },
};

const evidenceNames: Record<string, string> = {
  approval: '审批记录',
  machine_qc: '机器检查',
  visual_checklist: '画面检查清单',
  sound_checklist: '声音检查清单',
  asset_ledger: '素材台账',
  rights: '版权依据',
};

const videoFields: [string, string][] = [
  ['path', '文件'],
  ['duration_seconds', '时长（秒）'],
  ['width_px', '宽'],
  ['height_px', '高'],
  ['fps', '帧率'],
  ['video_codec', '视频编码'],
  ['pixel_format', '像素格式'],
  ['audio_codec', '音频编码'],
  ['audio_sample_rate_hz', '采样率'],
  ['audio_channels', '声道'],
  ['sha256', 'SHA-256'],
];

export function PublishTab({ version, run }: { version: number; run: RunAction }) {
  const [publish, setPublish] = useState<PublishResponse | null>(null);
  useEffect(() => {
    api<PublishResponse>('/api/publish').then(setPublish, () => setPublish(null));
  }, [version]);
  if (!publish) return <div className="empty">正在读取…</div>;

  const check = (
    <button disabled={!publish.available} onClick={() => run('/api/commands/publish.check')}>
      发布校验
    </button>
  );
  if (!publish.available) {
    return (
      <div className="publish-tab">
        <div className="empty">还没有发布信息。成片完成后，标题、简介、话题和封面会整理在这里。</div>
      </div>
    );
  }
  const d = publish.data;
  if (!d) {
    return (
      <div className="publish-tab">
        <div className="toolbar">
          <span className="spacer" />
          {check}
        </div>
        <p className="error-line">发布信息的格式有误，页面排不出来：{publish.parse_error}</p>
        <p className="small muted">在对话里让 AI 修好发布信息（例如「发布信息格式坏了，修一下」），修好后这里会自动刷新。</p>
      </div>
    );
  }

  const status = statusText[d.publish_status] ?? { label: String(d.publish_status ?? '未知'), tone: 'todo', hint: '' };
  const video = (d.video ?? {}) as Record<string, any>;
  const copy = (d.copy ?? {}) as Record<string, any>;
  const cover = (d.cover ?? {}) as Record<string, any>;
  const checks = Object.entries((d.manual_checks ?? {}) as Record<string, { status?: string; note?: string }>);
  const open = checks.filter(([, c]) => c?.status !== 'not_applicable');
  const remaining = open.filter(([, c]) => !['passed', 'done', 'confirmed'].includes(c?.status ?? ''));
  const hashtags: string[] = Array.isArray(copy.hashtags) ? copy.hashtags : [];
  const platformTitles = Object.entries((copy.platform_titles ?? {}) as Record<string, string>);
  const credits = (d.credits ?? {}) as Record<string, any>;

  // 登记过的封面带平台与比例；covers/ 下其余图片（如源文件）不在这里列。
  const registered: { platform?: string; ratio?: string; path: string; width_px?: number; height_px?: number }[] = Array.isArray(cover.images)
    ? [...cover.images]
    : [];
  const measured = new Map(publish.covers.map((c) => [c.path, c]));
  // 竖版封面排在最前、画得最大：发布页的主角是封面，竖版又是短视频平台的主封面。
  const tall = (r: { ratio?: string }) => {
    const [w, h] = (r.ratio ?? '').split(':').map(Number);
    return w && h ? h / w : 0;
  };
  registered.sort((a, b) => tall(b) - tall(a));
  const unregistered = publish.covers.filter((c) => !registered.some((r) => r.path === c.path) && !c.path.includes('/src/'));

  const spec = [
    video.duration_seconds && `${video.duration_seconds} 秒`,
    video.width_px && `${video.width_px}×${video.height_px}`,
    video.fps && `${video.fps} fps`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="publish-tab">
      <div className="publish-layout">
        <section className="publish-section publish-cover-col">
          <span className="eyebrow">封面{cover.title_lines?.length ? ` · ${cover.title_lines.join(' / ')}` : ''}</span>
          {registered.length === 0 && unregistered.length === 0 ? (
            <p className="small muted">还没有封面。</p>
          ) : (
            <div className="publish-covers">
              {[...registered.map((r) => ({ ...r, measured: measured.get(r.path) })), ...unregistered.map((c) => ({ path: c.path, measured: c }))].map(
                (c: any) => (
                  <figure key={c.path}>
                    <a href={rawURL(c.path, version)} target="_blank" rel="noreferrer">
                      <img src={rawURL(c.path, version)} alt="" loading="lazy" />
                    </a>
                    <figcaption>
                      <span>{c.ratio ? `${c.ratio} ${Number(c.ratio.split(':')[0]) > Number(c.ratio.split(':')[1]) ? '横版' : Number(c.ratio.split(':')[0]) < Number(c.ratio.split(':')[1]) ? '竖版' : '方形'}` : '未登记'}</span>
                      <span className="small muted">
                        {c.measured?.width ? `${c.measured.width}×${c.measured.height}` : c.measured?.error ?? ''}
                      </span>
                    </figcaption>
                  </figure>
                ),
              )}
            </div>
          )}
        </section>
        <div className="publish-main">
        <header className="publish-head">
          <span className="eyebrow">
            {publish.platform_name || d.platform}
            {spec ? ` · ${spec}` : ''}
          </span>
          <div className="publish-status-row">
            <span className={'publish-status ' + status.tone}>{status.label}</span>
            {status.hint && <span className="small muted">{status.hint}</span>}
            <span className="spacer" />
            {check}
          </div>
        </header>
        <section className="publish-section" data-ctx-source="publish.md" data-ctx-label="发布文案">
          <CopyField label="标题" value={copy.primary_title} count display />
          {platformTitles.map(([platform, title]) => (
            <CopyField key={platform} label={`${platform} 标题`} value={title} count />
          ))}
          <CopyField label="简介" value={copy.introduction} multiline />
          <CopyField label="话题" value={hashtags.join(' ')} />
          {credits.required && <CopyField label="署名" value={credits.text} multiline />}
        </section>

        {open.length > 0 && (
          <section className="publish-section">
            <h4>发布前你要确认{remaining.length ? ` · 还剩 ${remaining.length} 项` : ' · 都完成了'}</h4>
            <ul className="publish-checks">
              {open.map(([key, c]) => {
                const s = checkStatus[c?.status ?? ''] ?? { label: c?.status ?? '', tone: 'todo' };
                return (
                  <li key={key} className={s.tone} title={c?.note || undefined}>
                    <span className="publish-check-mark" />
                    <span className="publish-check-name">{checkNames[key] ?? key}</span>
                    <span className="publish-check-state">{s.label}</span>
                  </li>
                );
              })}
            </ul>
            <p className="small muted">做完后在对话里告诉 AI，例如「耳机和外放都听过了，没问题」，它会更新状态。</p>
          </section>
        )}

        <details className="publish-section publish-more">
          <summary>成片规格与证据</summary>
          <table className="publish-table">
            <tbody>
              {videoFields
                .filter(([k]) => video[k] !== undefined && video[k] !== null && video[k] !== '')
                .map(([k, name]) => (
                  <tr key={k}>
                    <th>{name}</th>
                    <td className="mono">{String(video[k])}</td>
                  </tr>
                ))}
              {Object.entries((d.evidence ?? {}) as Record<string, unknown>)
                .filter(([, v]) => (Array.isArray(v) ? v.length : v))
                .map(([k, v]) => (
                  <tr key={k}>
                    <th>{evidenceNames[k] ?? k}</th>
                    <td className="mono">{Array.isArray(v) ? v.join('、') : String(v)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
        </div>
      </div>
    </div>
  );
}

function CopyField({ label, value, multiline, count, display }: { label: string; value?: string; multiline?: boolean; count?: boolean; display?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = (value ?? '').trim();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时什么也不做，文字本身可以手动选中 */
    }
  };
  return (
    <div className="publish-field">
      <div className="publish-field-label">
        <span>{label}</span>
        {count && text && <span className="small muted">{[...text].length} 字</span>}
      </div>
      <div className={'publish-field-value' + (multiline ? ' multiline' : '') + (display ? ' display' : '')}>{text || <span className="muted">（空）</span>}</div>
      <button disabled={!text} onClick={copy}>
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}
