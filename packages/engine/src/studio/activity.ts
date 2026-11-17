/**
 * GET /api/scenes/{id}/activity：渲染器此刻在做什么。
 *
 * 渲染器是另一个 CLI 进程，编排工具调 scene_run 之后只能等，聊天页上只有一个在转的工具调用。
 * 渲染器的完整输出流本来就落在镜头目录的 render-<id>.stream.jsonl（scene.run 写的），
 * 这里用与编排工具同一套解析器（agentrun.Parser）把它译成步骤：读了哪个文件、改了什么、
 * 跑了哪条检查、说了什么、待办清单走到哪。
 *
 * 流日志一次渲染能到几 MB（工具结果全文都在里面），界面每两秒问一次，所以按文件增量解析：
 * 记住读到的偏移，文件被换掉（重渲染前归档、再截断）就从头来。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as agentrun from '../agentrun';
import * as scene from '../scene';
import { detectModel, ValidTools } from '../tools';
import { goMap, goValue } from './http';
import { sceneRendering, type SceneSummary } from './scenes';

/** 一步：一次工具调用（带结果）、一段思考、一段话或一条错误。 */
export interface ActivityStep {
  kind: 'tool' | 'thinking' | 'text' | 'error';
  tool?: string;
  input?: unknown;
  /** running / done / failed，只有工具调用有。 */
  state?: string;
  output?: string;
  text?: string;
  /** 思考的全文字数（按字符，不按 UTF-16 码元；text 只留开头一段）。有的模型一次能想几万字、几分钟，界面据此说清它想了多久。 */
  chars?: number;
  /** 流式思考的分批编号：同一编号的后续文本接在这一步上，不另起一步。 */
  text_id?: string;
}

/** 返回给界面的步骤条数上限：更早的只计数。 */
export const maxActivitySteps = 80;
/** 每个镜头在内存里留的步骤上限。 */
const keptSteps = 400;
/** 工具结果与回复正文的长度上限（字符）。界面只看个大概，全文在流日志里。 */
const maxStepText = 1200;
/** 工具参数里单个字符串的长度上限：Write 的 content 动辄几千行。 */
const maxInputString = 300;

interface StreamState {
  file: string;
  ino: number;
  birth: number;
  offset: number;
  tool: string;
  parser: agentrun.Parser | null;
  steps: ActivityStep[];
  /** call_id → 在 steps 里的那一步，结果到了回填。 */
  calls: Map<string, ActivityStep>;
  total: number;
  plan: agentrun.PlanItem[];
  model: string;
}

const streams = new Map<string, StreamState>();

/** 只用来测试：清掉增量解析的缓存。 */
export function resetActivityCache(): void {
  streams.clear();
}

/**
 * 按流的第一条认得出的事件判断是哪家 CLI 写的。尝试记录要等渲染结束才写，
 * 进行中标记是新版才有，所以兜底靠格式：codex 的事件是 thread.* / turn.* / item.*，
 * mcode 的每条带 schemaVersion 与 runId，opencode 的每条带 sessionID 与 part，其余按 claude 系（claude、qoder、codebuddy 同一种 stream-json）。
 */
export function sniffStreamTool(line: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return '';
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const e = raw as Record<string, unknown>;
  const type = typeof e.type === 'string' ? e.type : '';
  // mcode 也有 turn.* / item.*，但每条带 schemaVersion 与 runId，要先认。
  if ('schemaVersion' in e && 'runId' in e) return 'mcode';
  if (/^(thread|turn|item)\./.test(type)) return 'codex';
  if ('sessionID' in e && 'part' in e) return 'opencode';
  if (type !== '') return 'claude';
  return '';
}

/** 工具参数瘦身：长字符串截短，结构照留，界面拿它挑「最能说明做了什么」的那个字段。 */
function trimInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > maxInputString ? value.slice(0, maxInputString) + '…' : value;
  if (depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => trimInput(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = trimInput(item, depth + 1);
    return out;
  }
  return value;
}

function clipText(text: string): string {
  return text.length > maxStepText ? text.slice(0, maxStepText) + '…' : text;
}

function renderedTool(dir: string, id: string): string {
  const live = scene.readLive(dir, id);
  if (live && ValidTools.has(live.renderer)) return live.renderer;
  try {
    const attempt = scene.parseAttempt(fs.readFileSync(scene.attemptLog({ directory: dir, id })));
    if (ValidTools.has(attempt.renderer)) return attempt.renderer;
  } catch {
    // 还没有尝试记录。
  }
  return '';
}

function freshState(file: string, info: fs.Stats, tool: string): StreamState {
  return { file, ino: info.ino, birth: info.birthtimeMs, offset: 0, tool, parser: tool ? agentrun.newParser(tool) : null, steps: [], calls: new Map(), total: 0, plan: [], model: '' };
}

function push(state: StreamState, step: ActivityStep): void {
  state.steps.push(step);
  state.total++;
  if (state.steps.length > keptSteps) state.steps.splice(0, state.steps.length - keptSteps);
}

function consume(state: StreamState, line: string): void {
  if (line.trim() === '') return;
  if (!state.parser) {
    const tool = sniffStreamTool(line);
    if (!tool) return;
    state.tool = tool;
    state.parser = agentrun.newParser(tool);
  }
  const model = agentrunModel(state.tool, line);
  if (model) state.model = model;
  for (const event of state.parser.parse(line)) {
    switch (event.kind) {
      case agentrun.KindToolCall: {
        const step: ActivityStep = { kind: 'tool', tool: event.tool ?? '', input: trimInput(event.input), state: 'running' };
        push(state, step);
        if (event.call_id) state.calls.set(event.call_id, step);
        break;
      }
      case agentrun.KindToolResult: {
        const step = event.call_id ? state.calls.get(event.call_id) : undefined;
        if (step) {
          step.state = event.is_error ? 'failed' : 'done';
          if (event.text) step.output = clipText(event.text);
          state.calls.delete(event.call_id!);
        } else {
          // 只有结果、没见过调用（codex 的 item.completed 一条里两样都有）。
          push(state, { kind: 'tool', tool: event.tool ?? '', input: trimInput(event.input), state: event.is_error ? 'failed' : 'done', output: event.text ? clipText(event.text) : undefined });
        }
        break;
      }
      case agentrun.KindThinking: {
        const step = addThinking(state.steps.at(-1), event.text ?? '', event.text_id);
        if (step) push(state, step);
        break;
      }
      case agentrun.KindText:
        if (event.text?.trim()) push(state, { kind: 'text', text: clipText(event.text.trim()) });
        break;
      case agentrun.KindError:
        if (event.text?.trim()) push(state, { kind: 'error', text: clipText(event.text.trim()) });
        break;
      case agentrun.KindPlan:
        state.plan = event.plan ?? [];
        break;
    }
  }
}

/**
 * 一段思考：同一 text_id 的分批接到上一步上、字数累加（返回 undefined），否则返回新的一步（空白返回 undefined）。
 * 分批的文本按原样拼接，不 trim：「Checking 」后面接「Code」要得到「Checking Code」。整段到达的（没有 text_id）去掉首尾空白。
 */
export function addThinking(last: ActivityStep | undefined, text: string, textID?: string): ActivityStep | undefined {
  if (textID && last?.kind === 'thinking' && last.text_id === textID) {
    last.chars = (last.chars ?? 0) + [...text].length;
    if ((last.text ?? '').length < maxStepText) last.text = clipText((last.text ?? '') + text);
    return undefined;
  }
  if (text.trim() === '') return undefined;
  const kept = textID ? text : text.trim();
  return { kind: 'thinking', text: clipText(kept), chars: [...kept].length, ...(textID ? { text_id: textID } : {}) };
}

function agentrunModel(tool: string, line: string): string {
  // detectModel 只认 system/init，大多数行一眼就能排除，不必每行都解析。
  if (!line.includes('"init"')) return '';
  return detectModel(tool, line);
}

/** 把流日志读到最新，返回这个镜头的解析状态；还没有流日志时返回 null。 */
function readStream(dir: string, id: string, prefix = 'render'): { state: StreamState; info: fs.Stats } | null {
  const file = path.join(dir, prefix + '-' + id + '.stream.jsonl');
  let info: fs.Stats;
  try {
    info = fs.statSync(file);
  } catch {
    streams.delete(file);
    return null;
  }
  let state = streams.get(file);
  // 重渲染时旧日志挪进 attempts/、新日志以 'w' 打开：inode 或创建时间变了，或者文件变短了，都从头读。
  if (!state || state.ino !== info.ino || state.birth !== info.birthtimeMs || info.size < state.offset) {
    state = freshState(file, info, renderedTool(dir, id));
    streams.set(file, state);
  }
  if (info.size > state.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const length = info.size - state.offset;
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, state.offset);
      // 只吃到最后一个换行为止：渲染器还在写的半行（可能卡在多字节字符中间）留到下次连同后续字节重读。
      const cut = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (cut >= 0) {
        state.offset += cut + 1;
        for (const raw of buffer.subarray(0, cut).toString('utf8').split('\n')) consume(state, raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { state, info };
}

function lastOutcome(dir: string, id: string): { outcome?: string; error?: string; ended_at?: string } {
  try {
    const attempt = scene.parseAttempt(fs.readFileSync(scene.attemptLog({ directory: dir, id })));
    return { outcome: attempt.outcome || undefined, error: attempt.error || undefined, ended_at: attempt.ended_at || undefined };
  } catch {
    return {};
  }
}

/** 镜头的渲染过程：进行中的，或者最近一次的。 */
export function sceneActivity(sc: Pick<SceneSummary, 'directory' | 'id'> & Partial<SceneSummary>, prefix: 'render' | 'design' = 'render'): Record<string, unknown> {
  const rendering = sceneRendering(sc.directory, sc.id);
  const live = scene.readLive(sc.directory, sc.id);
  const read = readStream(sc.directory, sc.id, prefix);
  const state = read?.state;
  const steps = state ? state.steps.slice(-maxActivitySteps) : [];
  const ended = rendering || prefix === 'design' ? {} : lastOutcome(sc.directory, sc.id);
  return goMap({
    scene_id: sc.id,
    rendering,
    tool_lifecycle: 'codex-mcp-v1',
    renderer: live?.renderer || state?.tool || undefined,
    model: state?.model || undefined,
    started_at: live?.started_at || (read ? new Date(read.info.birthtimeMs).toISOString() : undefined),
    updated_at: read ? new Date(read.info.mtimeMs).toISOString() : undefined,
    step_count: state?.total ?? 0,
    steps: steps.map((step) => goMap({ ...step, input: step.input === undefined ? undefined : goValue(step.input) })),
    plan: state && state.plan.length > 0 ? state.plan.map((item) => goMap({ text: item.text, status: item.status })) : undefined,
    outcome: ended.outcome,
    error: ended.error,
    ended_at: ended.ended_at,
  });
}
