import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

export const finalCandidates = [
  'final.mp4',
  'production/final.mp4',
  'production/audio/candidate.mp4',
  'production/silent-master.mp4',
];

export const finalLabels: Record<string, string> = {
  'final.mp4': '成片',
  'production/final.mp4': '成片',
  'production/audio/candidate.mp4': '配音合成版',
  'production/silent-master.mp4': '无声母版',
};

export const reviewMismatch = '该报告不是针对当前文件。';
export const silentMaster = 'production/silent-master.mp4';

/** production/review/review.json（review.Report）。 */
export interface ReviewResponse {
  available: boolean;
  path?: string | null;
  unbound?: boolean;
  can_approve?: boolean;
  report_dir?: string;
  report?: {
    ok?: boolean;
    video_sha256?: string;
    raw?: string;
    issues?: unknown[];
    problems?: string[];
    hints?: unknown[];
    expected_frames?: number;
    counted_frames?: number;
    media?: { duration_seconds?: number };
    loudness?: { integrated_lufs?: number; true_peak_dbtp?: number };
    sheets?: { image: string }[];
    seams?: { image: string }[];
  } & Record<string, unknown>;
}

export const reviewProblems = (r?: ReviewResponse['report']) => r?.problems ?? [];

export interface FilmReviewProps {
  video: string | undefined;
  variants: string[];
  onVideo: (path: string) => void;
  review: ReviewResponse | undefined;
}

export function FilmVersions({ video, variants, onVideo }: Pick<FilmReviewProps, 'video' | 'variants' | 'onVideo'>) {
  if (variants.length < 2) return null;
  return (
    <div className="final-versions" role="group" aria-label="版本">
      {variants.map((path) => (
        <button
          key={path}
          className={path === video ? 'on' : ''}
          aria-pressed={path === video}
          title={path}
          onClick={() => onVideo(path)}
        >
          {variants.some((other) => other !== path && finalLabels[other] === finalLabels[path])
            ? `${finalLabels[path]} · ${path}`
            : finalLabels[path]}
        </button>
      ))}
    </div>
  );
}

export function useFilmReview(
  enabled: boolean,
  video: string | undefined,
  version: number,
  project?: string,
): ReviewResponse | undefined {
  const request = useMemo(() => ({ enabled, video, version, project }), [enabled, video, version, project]);
  const [result, setResult] = useState<{ request: typeof request; review: ReviewResponse }>();
  useEffect(() => {
    if (!request.enabled) return;
    const controller = new AbortController();
    const update = (review: ReviewResponse) => {
      if (!controller.signal.aborted) setResult({ request, review });
    };
    const url = request.video ? '/api/review?video=' + encodeURIComponent(request.video) : '/api/review';
    api<ReviewResponse>(url, { signal: controller.signal }).then(update, () => update({ available: false }));
    return () => controller.abort();
  }, [request]);
  return result?.request === request ? result.review : undefined;
}
