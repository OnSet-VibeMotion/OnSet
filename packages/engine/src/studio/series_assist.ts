/**
 * 专栏创建与润色的智能体辅助接口：
 *
 *   POST   /api/series/assist   {mode, idea?, instruction?, current?}
 *   DELETE /api/series/assist   取消进行中的请求
 *
 * 在空临时目录读全局配置（复用 OPTIMIZER / ORCHESTRATOR，零新增 API Key），实时采集当前可用
 * 画幅、做法、整片风格、音色库与品牌包目录交给模型，强白名单防幻觉后返回草案。
 * 全局维护单实例 AbortController：重复请求自动中止前一次。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as brandkit from '../brandkit';
import * as config from '../config';
import { envMap, parsePassthrough } from '../envutil';
import * as filmstyle from '../filmstyle';
// 导入 plugin 与 flow 以确保内置及第三方插件登记的风格库与做法完整加载。
import '../plugin';
import * as flow from '../flow';
import { goTrimSpace } from '../gofmt';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import * as series from '../series';
import * as voice from '../voice';
import { DecodeError, decodeJSON, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import type { Server } from './studio';

type AssistRunner = (prompt: string, signal?: AbortSignal) => Promise<string>;

let activeController: AbortController | null = null;
let testRunner: AssistRunner | null = null;

/** 供测试替换单次模型调用，避免在单测里启动真实外部 CLI。 */
export function setSeriesAssistRunnerForTest(runner: AssistRunner | null): void {
  testRunner = runner;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function parsePublishTemplateField(raw: unknown): series.PublishTemplateInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: series.PublishTemplateInput = {
    title_pattern: asString(r.title_pattern) || undefined,
    default_hashtags: asStringArray(r.default_hashtags),
    description_footer: asString(r.description_footer) || undefined,
    cover_guidelines: asString(r.cover_guidelines) || undefined,
    credits_lines: asStringArray(r.credits_lines),
  };
  return out;
}

function parseCurrentDraft(raw: unknown): series.SeriesAssistDraft | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const defaultsRaw =
    c.defaults && typeof c.defaults === 'object' && !Array.isArray(c.defaults)
      ? (c.defaults as Record<string, unknown>)
      : undefined;
  const defaults: series.SeriesDefaults | undefined = defaultsRaw
    ? {
        canvas: asString(defaultsRaw.canvas) || undefined,
        delivery: asString(defaultsRaw.delivery) || undefined,
        narration: asString(defaultsRaw.narration) || undefined,
        film_style: asString(defaultsRaw.film_style) || undefined,
        motion_effects: asStringArray(defaultsRaw.motion_effects),
        tts_voice: asString(defaultsRaw.tts_voice) || undefined,
        brand_kit_id: asString(defaultsRaw.brand_kit_id) || undefined,
      }
    : undefined;
  return {
    name: asString(c.name) || undefined,
    description: asString(c.description) || undefined,
    naming_pattern: asString(c.naming_pattern) || undefined,
    defaults,
    brief: asString(c.brief) || undefined,
    publish_template: parsePublishTemplateField(c.publish_template),
  };
}

/** 采集当前工作台真实可用的画幅、做法、整片风格、音色库与品牌包目录。 */
export function collectSeriesAssistCatalog(env: Record<string, string> = envMap()): series.SeriesAssistCatalog {
  const canvases: series.SeriesAssistCanvasOption[] = preset.all().map((p) => ({
    id: p.id,
    label: p.label,
    orientation: p.canvas.orientation,
  }));
  const modes: series.SeriesAssistModeOption[] = projectinit.presets().map((m) => ({
    id: m.id,
    label: m.label,
    hint: m.hint,
    delivery: m.delivery,
    narration: m.narration,
  }));
  const film_styles: series.SeriesAssistFilmStyleOption[] = filmstyle.catalog().map((st) => ({
    key: filmstyle.styleKey(st),
    cn: st.cn,
    category: st.category_cn,
    summary: st.summary,
  }));
  let voices: series.SeriesAssistVoiceOption[] = [];
  try {
    const voiceDir = voice.defaultDir(env);
    if (voiceDir) {
      voices = voice.list(voiceDir).map((v) => ({
        name: v.name,
        ...(v.instruction ? { instruction: v.instruction } : {}),
      }));
    }
  } catch {
    voices = [];
  }
  let brand_kits: series.SeriesAssistBrandKitOption[] = [];
  try {
    const kitsDir = brandkit.defaultBrandKitsDir(env);
    if (kitsDir) {
      brand_kits = brandkit.listBrandKits(kitsDir).map((k) => ({ id: k.id, name: k.name }));
    }
  } catch {
    brand_kits = [];
  }
  let motion_effects: { ref: string; name: string; category?: string }[] = [];
  try {
    motion_effects = flow
      .listMotionSources(env)
      .flatMap((src) => src.effects.map((e) => ({ ref: `${src.id}:${e.id}`, name: e.name, category: e.category })));
  } catch {
    motion_effects = [];
  }
  return { canvases, modes, film_styles, voices, brand_kits, motion_effects };
}

function loadGlobalConfig(): config.Config {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-series-assist-cfg-'));
  try {
    return config.load(emptyDir, null);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

export async function seriesAssistAPI(s: Server, request: Request): Promise<Response> {
  if (request.method === 'DELETE') {
    activeController?.abort();
    activeController = null;
    return writeJSON(200, goMap({ ok: true }));
  }
  if (request.method !== 'POST') return methodNotAllowed('POST, DELETE');

  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
  } catch (err) {
    return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : '请求不是合法 JSON');
  }

  const rawMode = goTrimSpace(asString(body.mode)) || 'draft';
  if (!series.ValidSeriesAssistModes.has(rawMode as series.SeriesAssistMode)) {
    return writeError(400, 'invalid_request', `不支持的辅助模式：${rawMode}`);
  }
  const mode = rawMode as series.SeriesAssistMode;
  const idea = goTrimSpace(asString(body.idea));
  const instruction = goTrimSpace(asString(body.instruction));
  const current = parseCurrentDraft(body.current);

  if (mode === 'draft' && !idea && !goTrimSpace(current?.name ?? '') && !goTrimSpace(current?.description ?? '')) {
    return writeError(400, 'invalid_request', '请先用一句话描述你想做的专栏');
  }
  if (mode === 'refine' && !instruction && !idea) {
    return writeError(400, 'invalid_request', '请填写想调整的方向或补充意见');
  }
  if (mode === 'polish_brief' && !goTrimSpace(current?.brief ?? '') && !idea) {
    return writeError(400, 'invalid_request', '请先写几句专栏规范再进行润色');
  }

  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const onReqAbort = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener('abort', onReqAbort, { once: true });

  const hostEnv = envMap();
  const cfg = loadGlobalConfig();
  const childEnv = config.childEnvironment(
    cfg,
    hostEnv,
    s.config.unsafe,
    parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''),
  );
  const catalog = collectSeriesAssistCatalog(hostEnv);

  try {
    const result = await series.runSeriesAssist(
      {
        mode,
        ...(idea ? { idea } : {}),
        ...(instruction ? { instruction } : {}),
        ...(current ? { current } : {}),
        catalog,
      },
      {
        cfg,
        env: childEnv,
        unsafe: s.config.unsafe,
        signal: controller.signal,
        call: testRunner ? (prompt) => testRunner!(prompt, controller.signal) : undefined,
      },
    );
    return writeJSON(
      200,
      goMap({
        mode: result.mode,
        name: result.name,
        description: result.description,
        naming_pattern: result.naming_pattern,
        defaults: result.defaults,
        brief: result.brief,
        publish_template: result.publish_template,
        rationale: result.rationale,
        followups: result.followups,
        warnings: result.warnings,
        tool: result.tool,
        model: result.model,
      }),
    );
  } catch (err) {
    if (controller.signal.aborted || (err as Error).name === 'AbortError') {
      return writeError(409, 'cancelled', '已取消');
    }
    return writeError(502, 'series_assist_failed', `智能体润色没有成功：${(err as Error).message}`);
  } finally {
    request.signal.removeEventListener('abort', onReqAbort);
    if (activeController === controller) activeController = null;
  }
}
