import type { CanvasOption } from '../../types';
import type { HomeMaterial } from '../homeAttachments';

export interface CreationJob {
  parent: string;
  /** 按第一句话或文件名起的名字（不含日期）：AI 起名失败或用户不等时用它。 */
  name: string;
  canvas: string;
  canvasInfo?: CanvasOption;
  /** 选定的整片风格（风格库目录名），空表示不用。 */
  filmStyle: string;
  delivery: string;
  narration: string;
  modeLabel: string;
  tool: string;
  toolLabel: string;
  message: string;
  materials: HomeMaterial[];
  /** 可选：新建为某个专栏的下一期。 */
  seriesId?: string;
  seriesName?: string;
  episode?: number;
  namingPattern?: string;
}

export type StepID = 'name' | 'create' | 'upload' | 'skills' | 'style' | 'start';
export type StepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

export interface Step {
  id: StepID;
  label: string;
  weight: number;
}

export const steps: Step[] = [
  { id: 'name', label: '起片名', weight: 8 },
  { id: 'create', label: '建立项目', weight: 6 },
  { id: 'upload', label: '放入素材', weight: 8 },
  { id: 'skills', label: '装备技能', weight: 54 },
  { id: 'style', label: '整片风格', weight: 12 },
  { id: 'start', label: '召集编排', weight: 12 },
];

export interface SkillsStatus {
  installed: boolean;
  installing: boolean;
  error?: string;
  progress?: { stage: string; percent: number; indeterminate?: boolean };
}

const FPS = 30;

/** 读得出文字的素材：取开头一段交给起名。 */
const textFile = /\.(md|markdown|txt|text|srt|vtt|csv|json|html?|ya?ml)$/i;

/** 逐字写出的一行字（拟片名那一幕的监视器与场记板共用）：每个字晚 INK_STEP 毫秒出现。 */
export const INK_STEP = 55;

/** 项目名后面带上日期（月日），同一主题隔天再做也不撞名。 */
export function datedName(base: string, at = new Date()): string {
  return `${base}-${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
}

/** 专栏期数命名：按命名模板（如 EP{nn}-{title}）拼出文件夹名，未指定期号回退到带日期名。 */
export function episodeProjectName(job: CreationJob, base: string, at = new Date()): string {
  if (!job.seriesId || !job.episode || job.episode < 1) return datedName(base, at);
  const tpl = (job.namingPattern ?? '').trim() || 'EP{nn}-{title}';
  const nn = String(job.episode).padStart(2, '0');
  const n = String(job.episode);
  const replaced = tpl.replaceAll('{nn}', nn).replaceAll('{n}', n);
  const out = replaced.includes('{title}') ? replaced.replaceAll('{title}', base) : `${replaced}-${base}`;
  return out
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
}

export async function excerpts(files: File[]): Promise<{ name: string; text: string }[]> {
  return Promise.all(
    files.map(async (file) => {
      if (!textFile.test(file.name) && !file.type.startsWith('text/')) return { name: file.name, text: '' };
      try {
        return {
          name: file.name,
          text: Array.from(await file.slice(0, 32 * 1024).text())
            .slice(0, 3000)
            .join(''),
        };
      } catch {
        return { name: file.name, text: '' };
      }
    }),
  );
}

export function inkDuration(text: string): number {
  return Array.from(text).length * INK_STEP + 420;
}

export function reducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function timecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total % 1) * FPS);
  return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':');
}

export function firstLine(text: string): string {
  const line = text.split('\n')[0];
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}
