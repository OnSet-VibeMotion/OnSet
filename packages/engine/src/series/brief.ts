import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goTrimSpace } from '../gofmt';
import { listSeriesAssets } from './assets';
import { readBinding } from './binding';
import { readPublishTemplate } from './publish_template';
import { getSeries, readBrief, seriesDir } from './store';
import { DirectionsFile } from './types';

/** 读取专栏的默认配音语气指导（directions.md），没有时返回空串。 */
export function readDirections(rootDir: string, id: string): string {
  const file = path.join(seriesDir(rootDir, id), DirectionsFile);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** 写入专栏的默认配音语气指导（directions.md）；纯空白时删除。 */
export function writeDirections(rootDir: string, id: string, content: string): void {
  const file = path.join(seriesDir(rootDir, id), DirectionsFile);
  if (goTrimSpace(content) === '') {
    fs.rmSync(file, { force: true });
    return;
  }
  atomicWrite(file, content.endsWith('\n') ? content : content + '\n', 0o644);
}

export interface SeriesPromptBrief {
  seriesId: string;
  seriesName: string;
  text: string;
  digest: string;
}

/**
 * 组合交给编排工具的「专栏规范」段及摘要。
 * 独立项目（没有 onset.series.json）一律返回空串，保证既有提示词与金样逐字节不变。
 */
export function seriesPromptBrief(seriesRoot: string, projectRoot: string): SeriesPromptBrief {
  let binding;
  try {
    binding = readBinding(projectRoot);
  } catch {
    return { seriesId: '', seriesName: '', text: '', digest: '' };
  }
  if (!binding) return { seriesId: '', seriesName: '', text: '', digest: '' };

  const cfg = seriesRoot ? getSeries(seriesRoot, binding.series_id) : null;
  const brief = cfg ? goTrimSpace(readBrief(seriesRoot, cfg.id)) : '';
  const name = cfg?.name ?? binding.series_name;
  const epLabel = binding.episode ? `第 ${binding.episode} 期（EP${String(binding.episode).padStart(2, '0')}）` : '番外/未编号';

  const lines: string[] = [];
  lines.push(`专栏规范（本片属于专栏「${name}」，标识 ${binding.series_id}，${epLabel}）：`);
  if (cfg?.description) lines.push(`- 专栏定位：${cfg.description}`);
  if (cfg?.defaults.tts_voice) lines.push(`- 专栏默认音色：${cfg.defaults.tts_voice}`);
  if (cfg?.defaults.film_style) lines.push(`- 专栏默认整片风格：${cfg.defaults.film_style}`);
  if (brief !== '') {
    lines.push('');
    lines.push('本专栏视觉与口播固定约定（写口播稿、视觉处理方案与分镜任务书时必须遵守；与本轮用户明确要求冲突时以用户本次要求为准）：');
    lines.push(brief);
  }

  // 列出本专栏可复用的跨期资产（已随新建项目拷入，或可通过 series_sync_asset() 拉取）。
  if (cfg) {
    let assets: ReturnType<typeof listSeriesAssets> = [];
    try {
      assets = listSeriesAssets(seriesRoot, cfg.id);
    } catch {
      assets = [];
    }
    const reusable = assets.filter((a) => a.kind !== 'publish_template');
    if (reusable.length > 0) {
      lines.push('');
      lines.push('本专栏跨期复用资产（直接优先复用，不要重复造轮子；缺少或有更新可用 series_sync_asset() 拉取）：');
      for (const a of reusable) {
        const modeNote =
          a.kind === 'bumper'
            ? a.bumper_mode === 'template'
              ? '（HTML 模板镜头，按本期标题/期号微调渲染）'
              : '（固定成片视频，可直接复用拼入）'
            : '';
        lines.push(`- [${a.kind}] ${a.name} → ${a.target_path}${modeNote}`);
      }
    }

    let tpl = null;
    try {
      tpl = readPublishTemplate(seriesRoot, cfg.id);
    } catch {
      tpl = null;
    }
    if (tpl) {
      lines.push('');
      lines.push('本专栏发布与封面模板（生成 publish.md 与系列封面时按此套用）：');
      if (tpl.title_pattern) lines.push(`- 标题规则：${tpl.title_pattern}`);
      if (tpl.default_hashtags?.length) lines.push(`- 固定话题：${tpl.default_hashtags.join(' ')}`);
      if (tpl.cover_guidelines) lines.push(`- 封面规范：${tpl.cover_guidelines}`);
      if (tpl.description_footer) lines.push(`- 简介固定尾注：${tpl.description_footer}`);
      if (tpl.credits_lines?.length) lines.push(`- 固定素材署名：${tpl.credits_lines.join('；')}`);
    }
  }

  lines.push('');
  lines.push(
    '如果用户表达了「这个专栏以后都…」的系列取向，请用 memory_remember({"text": "...", "scope": "series"}) 记为本专栏偏好，以免污染其他专栏；本期做出的通用组件/角色/片头片尾验收后，可用 series_promote_asset() 沉淀回本专栏供后续期数复用。',
  );

  const text = lines.join('\n') + '\n';
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  return { seriesId: binding.series_id, seriesName: name, text, digest };
}
