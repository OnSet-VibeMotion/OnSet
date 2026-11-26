import { api, del } from '../../api';
import type {
  SeriesAssistDraft,
  SeriesAssistMode,
  SeriesAssistResponse,
  SeriesPublishTemplate,
  SeriesPublishTemplateDraft,
} from '../../types';

export interface PublishTemplateFormState {
  titlePattern: string;
  hashtags: string;
  coverGuide: string;
  footer: string;
  credits: string;
}

export function emptyPublishTemplateForm(): PublishTemplateFormState {
  return { titlePattern: '', hashtags: '', coverGuide: '', footer: '', credits: '' };
}

export function publishTemplateToForm(
  tpl?: SeriesPublishTemplate | SeriesPublishTemplateDraft | null,
): PublishTemplateFormState {
  if (!tpl) return emptyPublishTemplateForm();
  return {
    titlePattern: tpl.title_pattern ?? '',
    hashtags: (tpl.default_hashtags ?? []).join(' '),
    coverGuide: tpl.cover_guidelines ?? '',
    footer: tpl.description_footer ?? '',
    credits: (tpl.credits_lines ?? []).join('\n'),
  };
}

export function publishTemplateFormToPayload(form: PublishTemplateFormState): SeriesPublishTemplateDraft | undefined {
  const title_pattern = form.titlePattern.trim() || undefined;
  const default_hashtags = form.hashtags
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const cover_guidelines = form.coverGuide.trim() || undefined;
  const description_footer = form.footer.trim() || undefined;
  const credits_lines = form.credits
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !title_pattern &&
    default_hashtags.length === 0 &&
    !cover_guidelines &&
    !description_footer &&
    credits_lines.length === 0
  ) {
    return undefined;
  }
  return {
    ...(title_pattern ? { title_pattern } : {}),
    ...(default_hashtags.length > 0 ? { default_hashtags } : {}),
    ...(cover_guidelines ? { cover_guidelines } : {}),
    ...(description_footer ? { description_footer } : {}),
    ...(credits_lines.length > 0 ? { credits_lines } : {}),
  };
}

export function hasPublishTemplateContent(form: PublishTemplateFormState): boolean {
  return publishTemplateFormToPayload(form) !== undefined;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message === '已取消');
}

function makeAbortError(): Error {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

let assistSeq = 0;

/** 生成本次辅助请求的唯一标识，用于取消时精准匹配对应后端控制器。 */
export function nextSeriesAssistRequestId(): string {
  assistSeq += 1;
  return `sa-${Date.now()}-${assistSeq}`;
}

/** 请求 /api/series/_assist，支持前端 AbortSignal 与后端进程联动取消。 */
export function requestSeriesAssist(
  payload: {
    mode: SeriesAssistMode;
    idea?: string;
    instruction?: string;
    current?: SeriesAssistDraft;
    request_id?: string;
  },
  signal: AbortSignal,
): Promise<SeriesAssistResponse> {
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise<SeriesAssistResponse>((resolve, reject) => {
    const onAbort = () => reject(makeAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    api<SeriesAssistResponse>('/api/series/_assist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    }).then(
      (res) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(makeAbortError());
        else resolve(res);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? makeAbortError() : err);
      },
    );
  });
}

/** 通知后端中止指定标识对应的专栏辅助模型调用（避免迟到的 DELETE 误杀后续新请求）。 */
export function cancelSeriesAssist(requestId?: string): void {
  const qs = requestId ? `?request_id=${encodeURIComponent(requestId)}` : '';
  void del(`/api/series/_assist${qs}`).catch(() => {});
}
