import type { ModeOption, SeriesAssistDraft, SeriesAssistResponse, SeriesItem, StylesResponse } from '../../types';
import { type PublishTemplateFormState, publishTemplateFormToPayload, publishTemplateToForm } from './seriesAssistApi';

export interface SeriesFormState {
  name: string;
  description: string;
  parentDir: string;
  namingPattern: string;
  nextEpisode: string;
  canvas: string;
  modeId: string;
  filmStyle: string;
  motionEffects: string[];
  ttsVoice: string;
  brief: string;
  publishForm: PublishTemplateFormState;
  publishTouched: boolean;
}

export function initSeriesForm(
  initial: SeriesItem | null,
  styles: StylesResponse | null,
  modes: ModeOption[],
  defaultParent: string,
): SeriesFormState {
  const modeId = (() => {
    if (!initial) return modes[0]?.id ?? 'speech';
    const d = initial.defaults;
    const hit = modes.find((m) => m.delivery === (d.delivery || 'speech') && m.narration === (d.narration || 'solo'));
    return hit?.id ?? modes[0]?.id ?? 'speech';
  })();
  return {
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    parentDir: initial?.parent_dir ?? defaultParent,
    namingPattern: initial?.naming_pattern ?? 'EP{nn}-{title}',
    nextEpisode: String(initial?.next_episode ?? 1),
    canvas: initial?.defaults.canvas ?? styles?.default_canvas ?? '',
    modeId,
    filmStyle: initial?.defaults.film_style ?? '',
    motionEffects: initial?.defaults.motion_effects ?? [],
    ttsVoice: initial?.defaults.tts_voice ?? '',
    brief: initial?.brief ?? '',
    publishForm: publishTemplateToForm(initial?.publish_template),
    publishTouched: false,
  };
}

export function buildAssistCurrent(form: SeriesFormState, modes: ModeOption[]): SeriesAssistDraft {
  const currentMode = modes.find((m) => m.id === form.modeId) ?? modes[0];
  return {
    name: form.name.trim() || undefined,
    description: form.description.trim() || undefined,
    naming_pattern: form.namingPattern.trim() || undefined,
    defaults: {
      canvas: form.canvas || undefined,
      delivery: currentMode?.delivery || undefined,
      narration: currentMode?.narration || undefined,
      film_style: form.filmStyle || undefined,
      motion_effects: form.motionEffects.length > 0 ? form.motionEffects : undefined,
      tts_voice: form.ttsVoice.trim() || undefined,
    },
    brief: form.brief.trim() ? form.brief : undefined,
    publish_template: publishTemplateFormToPayload(form.publishForm),
  };
}

export function applyDraftToForm(
  form: SeriesFormState,
  draft: SeriesAssistResponse,
  modes: ModeOption[],
): SeriesFormState {
  let nextModeId = form.modeId;
  if (draft.defaults.delivery) {
    const hit = modes.find(
      (m) => m.delivery === draft.defaults.delivery && m.narration === (draft.defaults.narration || 'solo'),
    );
    if (hit) nextModeId = hit.id;
  }
  const tpl = draft.publish_template;
  const nextPublishForm = tpl
    ? {
        titlePattern: tpl.title_pattern !== undefined ? tpl.title_pattern : form.publishForm.titlePattern,
        hashtags: tpl.default_hashtags !== undefined ? tpl.default_hashtags.join(' ') : form.publishForm.hashtags,
        coverGuide: tpl.cover_guidelines !== undefined ? tpl.cover_guidelines : form.publishForm.coverGuide,
        footer: tpl.description_footer !== undefined ? tpl.description_footer : form.publishForm.footer,
        credits: tpl.credits_lines !== undefined ? tpl.credits_lines.join('\n') : form.publishForm.credits,
      }
    : form.publishForm;
  return {
    ...form,
    name: draft.name || form.name,
    description: draft.description || form.description,
    namingPattern: draft.naming_pattern || form.namingPattern,
    canvas: draft.defaults.canvas || form.canvas,
    modeId: nextModeId,
    filmStyle: draft.defaults.film_style || form.filmStyle,
    motionEffects: draft.defaults.motion_effects?.length ? draft.defaults.motion_effects : form.motionEffects,
    ttsVoice: draft.defaults.tts_voice || form.ttsVoice,
    brief: draft.brief || form.brief,
    publishForm: nextPublishForm,
    publishTouched: tpl ? true : form.publishTouched,
  };
}

export function buildSeriesSavePayload(
  form: SeriesFormState,
  modes: ModeOption[],
  editing: boolean,
): { payload?: Record<string, unknown>; error?: string } {
  const cleanName = form.name.trim();
  if (!cleanName) return { error: '请填写专栏名称' };
  const rawEp = form.nextEpisode.trim();
  const parsedEp = /^[1-9]\d*$/.test(rawEp) ? Number(rawEp) : Number.NaN;
  if (!Number.isSafeInteger(parsedEp) || parsedEp < 1) {
    return { error: '下一期期号必须是正整数' };
  }
  const mode = modes.find((m) => m.id === form.modeId) ?? modes[0];
  const publishPayload = publishTemplateFormToPayload(form.publishForm);
  const payload: Record<string, unknown> = {
    name: cleanName,
    description: form.description.trim(),
    parent_dir: form.parentDir.trim(),
    naming_pattern: form.namingPattern.trim() || 'EP{nn}-{title}',
    next_episode: parsedEp,
    defaults: {
      canvas: form.canvas || undefined,
      delivery: mode?.delivery || undefined,
      narration: mode?.narration || undefined,
      film_style: form.filmStyle || undefined,
      motion_effects: form.motionEffects.length > 0 ? form.motionEffects : undefined,
      tts_voice: form.ttsVoice.trim() || undefined,
    },
    brief: form.brief,
  };
  if (!editing && publishPayload) {
    payload.publish_template = publishPayload;
  } else if (editing && form.publishTouched) {
    payload.publish_template = publishPayload ?? {};
  }
  return { payload };
}
