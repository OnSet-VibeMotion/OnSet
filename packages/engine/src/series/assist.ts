/**
 * 专栏（Series）创建与润色的智能体辅助：
 * - draft：一句话描述生成完整专栏草案（名称、定位、默认预设、brief.md 与初始发布模板）
 * - refine：在已有草案或表单基础上按用户补充意见继续微调
 * - polish_brief：单独润色专栏规范（brief.md）
 *
 * 复用 promptopt.callOnce（空临时目录、零命令权限、支持 AbortSignal）与 promptopt.optimizerOf(cfg)，
 * 零新增 API Key。所有目录类字段（画幅、做法、整片风格、音色、品牌包）一律强白名单校验，绝不输出幻觉 ID。
 */
import type { Config } from '../config';
import { normalizeMotionEffectRef } from '../flow';
import { goTrimSpace } from '../gofmt';
import * as promptopt from '../promptopt';
import type { PublishTemplateInput, SeriesDefaults } from './types';

export type SeriesAssistMode = 'draft' | 'refine' | 'polish_brief';

export const ValidSeriesAssistModes = new Set<SeriesAssistMode>(['draft', 'refine', 'polish_brief']);

export interface SeriesAssistCanvasOption {
  id: string;
  label: string;
  orientation?: string;
}

export interface SeriesAssistModeOption {
  id: string;
  label: string;
  hint?: string;
  delivery: string;
  narration: string;
}

export interface SeriesAssistFilmStyleOption {
  key: string;
  cn: string;
  category?: string;
  summary?: string;
}

export interface SeriesAssistVoiceOption {
  name: string;
  instruction?: string;
}

export interface SeriesAssistBrandKitOption {
  id: string;
  name: string;
}

export interface SeriesAssistCatalog {
  canvases: SeriesAssistCanvasOption[];
  modes: SeriesAssistModeOption[];
  film_styles: SeriesAssistFilmStyleOption[];
  voices: SeriesAssistVoiceOption[];
  brand_kits?: SeriesAssistBrandKitOption[];
  motion_effects?: { ref: string; name: string; category?: string }[];
}

export interface SeriesAssistDraft {
  name?: string;
  description?: string;
  naming_pattern?: string;
  defaults?: SeriesDefaults;
  brief?: string;
  publish_template?: PublishTemplateInput;
}

export interface SeriesAssistInput {
  mode: SeriesAssistMode;
  idea?: string;
  instruction?: string;
  current?: SeriesAssistDraft;
  catalog: SeriesAssistCatalog;
}

export interface SeriesAssistResult {
  mode: SeriesAssistMode;
  name?: string;
  description?: string;
  naming_pattern?: string;
  defaults: SeriesDefaults;
  brief: string;
  publish_template?: PublishTemplateInput;
  rationale: string;
  followups: string[];
  warnings: string[];
}

export interface RunSeriesAssistOptions {
  cfg: Pick<Config, 'optimizer' | 'optimizerModel' | 'orchestrator' | 'orchestratorModel'> &
    Partial<Pick<Config, 'optimizerOptions' | 'orchestratorOptions'>>;
  env: Record<string, string>;
  unsafe: boolean;
  signal?: AbortSignal;
  /** 可选自定义单次调用函数（供测试注入）；缺省走 promptopt.callOnce。 */
  call?: (prompt: string) => Promise<string>;
}

export interface RunSeriesAssistResult extends SeriesAssistResult {
  tool: string;
  model?: string;
}

/** 模型回复不合格；message 给用户看，retryNote 写进重试提示词。 */
export class SeriesAssistRejected extends Error {
  constructor(
    message: string,
    readonly retryNote: string,
  ) {
    super(message);
    this.name = 'SeriesAssistRejected';
  }
}

const MaxPromptFilmStyles = 60;
const MaxSummaryRunes = 48;

function cleanStr(v: unknown): string {
  return typeof v === 'string' ? goTrimSpace(v) : '';
}

function cleanStrList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = cleanStr(item);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function trimRunes(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text;
}

function compactCatalog(catalog: SeriesAssistCatalog): Record<string, unknown> {
  return {
    canvases: catalog.canvases.map((c) => ({
      id: c.id,
      label: c.label,
      ...(c.orientation ? { orientation: c.orientation } : {}),
    })),
    modes: catalog.modes.map((m) => ({
      delivery: m.delivery,
      narration: m.narration,
      label: m.label,
      ...(m.hint ? { hint: m.hint } : {}),
    })),
    film_styles: catalog.film_styles.slice(0, MaxPromptFilmStyles).map((s) => ({
      key: s.key,
      cn: s.cn,
      ...(s.category ? { category: s.category } : {}),
      ...(s.summary ? { summary: trimRunes(goTrimSpace(s.summary), MaxSummaryRunes) } : {}),
    })),
    voices: catalog.voices.map((v) => ({
      name: v.name,
      ...(v.instruction ? { instruction: trimRunes(goTrimSpace(v.instruction), MaxSummaryRunes) } : {}),
    })),
    ...(catalog.brand_kits && catalog.brand_kits.length > 0
      ? { brand_kits: catalog.brand_kits.map((k) => ({ id: k.id, name: k.name })) }
      : {}),
    ...(catalog.motion_effects?.length ? { motion_effects: catalog.motion_effects.slice(0, 40) } : {}),
  };
}

/** 构造发给优化器的提示词：所有用户输入与目录都作为 JSON 写入 {{EVIDENCE}}。 */
export function buildSeriesAssistPrompt(input: SeriesAssistInput, retryNote = ''): string {
  const evidence: Record<string, unknown> = {
    mode: input.mode,
    catalog: compactCatalog(input.catalog),
  };
  const idea = cleanStr(input.idea);
  if (idea) evidence.idea = idea;
  const instruction = cleanStr(input.instruction);
  if (instruction) evidence.instruction = instruction;
  if (input.current) evidence.current = input.current;
  let prompt = promptopt.fillTemplate(promptopt.readTemplate('series-assist.md'), evidence);
  if (retryNote !== '') prompt += `\n## 上一次的问题\n\n${retryNote}\n`;
  return prompt;
}

function parsePublishTemplate(raw: unknown): PublishTemplateInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const title_pattern = cleanStr(r.title_pattern) || undefined;
  const default_hashtags = cleanStrList(r.default_hashtags, 10);
  const description_footer = cleanStr(r.description_footer) || undefined;
  const cover_guidelines = cleanStr(r.cover_guidelines) || undefined;
  const credits_lines = cleanStrList(r.credits_lines, 10);
  if (
    !title_pattern &&
    default_hashtags.length === 0 &&
    !description_footer &&
    !cover_guidelines &&
    credits_lines.length === 0
  ) {
    return undefined;
  }
  return {
    ...(title_pattern ? { title_pattern } : {}),
    ...(default_hashtags.length > 0 ? { default_hashtags } : {}),
    ...(description_footer ? { description_footer } : {}),
    ...(cover_guidelines ? { cover_guidelines } : {}),
    ...(credits_lines.length > 0 ? { credits_lines } : {}),
  };
}

/** 强白名单校验：只保留命中真实目录的预设 ID，其余清为空并记录中文提醒。 */
function filterDefaultsByCatalog(
  raw: unknown,
  catalog: SeriesAssistCatalog,
): { defaults: SeriesDefaults; warnings: string[] } {
  const defaults: SeriesDefaults = {};
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { defaults, warnings };
  const d = raw as Record<string, unknown>;

  const canvasIds = new Set(catalog.canvases.map((c) => c.id));
  const rawCanvas = cleanStr(d.canvas);
  if (rawCanvas) {
    if (canvasIds.has(rawCanvas)) defaults.canvas = rawCanvas;
    else warnings.push(`推荐的画幅「${rawCanvas}」不在当前可用画幅中，已自动忽略。`);
  }

  const rawDelivery = cleanStr(d.delivery);
  const rawNarration = cleanStr(d.narration);
  if (rawDelivery || rawNarration) {
    let matched: SeriesAssistModeOption | undefined;
    if (rawDelivery && rawNarration) {
      matched = catalog.modes.find((m) => m.delivery === rawDelivery && m.narration === rawNarration);
    } else if (rawDelivery) {
      matched =
        catalog.modes.find((m) => m.delivery === rawDelivery && m.narration === 'solo') ??
        catalog.modes.find((m) => m.delivery === rawDelivery);
    }
    if (matched) {
      defaults.delivery = matched.delivery;
      defaults.narration = matched.narration;
    } else {
      const label = [rawDelivery, rawNarration].filter(Boolean).join('/');
      warnings.push(`推荐的做法「${label}」不在当前可用做法中，已自动忽略。`);
    }
  }

  const styleKeys = new Set(catalog.film_styles.map((s) => s.key));
  const rawStyle = cleanStr(d.film_style);
  if (rawStyle) {
    if (styleKeys.has(rawStyle)) defaults.film_style = rawStyle;
    else warnings.push(`推荐的整片风格「${rawStyle}」不在当前风格目录中，已自动忽略。`);
  }

  const voiceNames = new Set(catalog.voices.map((v) => v.name));
  const rawVoice = cleanStr(d.tts_voice);
  if (rawVoice) {
    if (voiceNames.has(rawVoice)) defaults.tts_voice = rawVoice;
    else warnings.push(`推荐的音色「${rawVoice}」不在当前音色库中，已自动忽略。`);
  }

  const brandKitIds = new Set((catalog.brand_kits ?? []).map((k) => k.id));
  const rawBrand = cleanStr(d.brand_kit_id);
  if (rawBrand) {
    if (brandKitIds.has(rawBrand)) defaults.brand_kit_id = rawBrand;
    else warnings.push(`推荐的品牌包「${rawBrand}」不在当前品牌包列表中，已自动忽略。`);
  }

  if (Array.isArray(d.motion_effects) && catalog.motion_effects?.length) {
    const valid = new Set(catalog.motion_effects.map((m) => m.ref));
    const kept: string[] = [];
    for (const rawRef of cleanStrList(d.motion_effects, 8)) {
      let ref = '';
      try {
        ref = normalizeMotionEffectRef(rawRef);
      } catch {
        /* ignore */
      }
      if (ref && valid.has(ref) && !kept.includes(ref)) kept.push(ref);
      else if (!ref || !valid.has(ref)) warnings.push(`推荐的常用动效「${rawRef}」不在当前动效目录中，已自动忽略。`);
    }
    if (kept.length > 0) defaults.motion_effects = kept;
  }

  return { defaults, warnings };
}

/** 解析并校验模型返回的 JSON。不合格时抛 SeriesAssistRejected。 */
export function parseSeriesAssist(raw: string, input: SeriesAssistInput): SeriesAssistResult {
  const obj =
    input.mode === 'polish_brief'
      ? promptopt.extractJSONObject(raw, 'brief')
      : (promptopt.extractJSONObject(raw, 'name') ??
        promptopt.extractJSONObject(raw, 'brief') ??
        promptopt.extractJSONObject(raw, 'defaults'));
  if (!obj) {
    throw new SeriesAssistRejected(
      '模型回复里没有合法的 JSON 结果',
      '请只输出一个合法 JSON 对象，包含要求的字段，前后不要加解释或代码块。',
    );
  }

  const brief = cleanStr(obj.brief);
  const rationale = cleanStr(obj.rationale);
  const followups = cleanStrList(obj.followups, 3);

  if (input.mode === 'polish_brief') {
    if (!brief) {
      throw new SeriesAssistRejected(
        '润色后的专栏规范是空的',
        '`brief` 不能为空，请输出整理后的完整 Markdown 专栏规范。',
      );
    }
    return {
      mode: 'polish_brief',
      defaults: {},
      brief,
      rationale,
      followups,
      warnings: [],
    };
  }

  const name = cleanStr(obj.name) || undefined;
  const description = cleanStr(obj.description) || undefined;
  const naming_pattern = cleanStr(obj.naming_pattern) || undefined;
  const publish_template = parsePublishTemplate(obj.publish_template);
  const { defaults, warnings } = filterDefaultsByCatalog(obj.defaults, input.catalog);

  if (!name && !brief && !description && Object.keys(defaults).length === 0 && !publish_template) {
    throw new SeriesAssistRejected(
      '模型返回了空的专栏草案',
      '请至少生成专栏名称（name）、定位（description）与专栏规范（brief）。',
    );
  }

  return {
    mode: input.mode,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(naming_pattern ? { naming_pattern } : {}),
    defaults,
    brief,
    ...(publish_template ? { publish_template } : {}),
    rationale,
    followups,
    warnings,
  };
}

/** 调用一次专栏辅助：格式不合格时带着原因重试一次，仍不合格则抛错。 */
export async function assistSeries(
  input: SeriesAssistInput,
  call: (prompt: string) => Promise<string>,
): Promise<SeriesAssistResult> {
  let note = '';
  for (let attempt = 0; ; attempt++) {
    const raw = await call(buildSeriesAssistPrompt(input, note));
    try {
      return parseSeriesAssist(raw, input);
    } catch (err) {
      if (!(err instanceof SeriesAssistRejected) || attempt >= 1) throw err;
      note = err.retryNote;
    }
  }
}

/** 结合全局配置与 promptopt.callOnce 执行一次专栏智能体辅助（ledgerFile 留空，与 studio/naming.ts 一致）。 */
export async function runSeriesAssist(
  input: SeriesAssistInput,
  opts: RunSeriesAssistOptions,
): Promise<RunSeriesAssistResult> {
  const { tool, model, options } = promptopt.optimizerOf(opts.cfg);
  if (!tool) {
    throw new Error('还没有配置可用的 AI 工具，请先在设置里配置编排工具或润色工具');
  }
  const runner =
    opts.call ??
    ((prompt: string) =>
      promptopt.callOnce({
        tool,
        model,
        options,
        prompt,
        env: opts.env,
        unsafe: opts.unsafe,
        signal: opts.signal,
        ledgerFile: '',
        source: 'series-assist',
      }));
  const result = await assistSeries(input, runner);
  return {
    ...result,
    tool,
    ...(model ? { model } : {}),
  };
}
