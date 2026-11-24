/**
 * 制作路线各站的产物判断定义（宿主自带站、内置插件站、第三方声明式站）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { hasRoster } from '../cast';
import { DialogueRelPath, SRTRelPath, VoiceRelPath } from '../dialogue';
import * as filmstyle from '../filmstyle';
import * as flow from '../flow';
import * as plugin from '../plugin';
import { candidateIsApproved, countFiles, dirMtime, type GateRecord, mtime } from './progress_gates';
import { candidateFilm, latestReviewReport, projectVideoDigest, type ReviewReport } from './reviewreport';
import type { SceneSummary } from './scenes';
import { readStoryboard } from './storyboard';

export interface Ctx {
  root: string;
  scenes: SceneSummary[];
  gates: Record<string, GateRecord>;
  filmReview?: ReviewReport | null;
}

/**
 * 一站做没做的判断。站点的名字、归哪一步、是不是关卡来自流程声明（flow.route）。
 * 与内置插件在 apply 里登记的判断函数是同一种写法（plugin.NodeJudge）。
 */
type Judge = plugin.NodeJudge<Ctx>;

export type Def = flow.RouteNode & Judge & { output: (c: Ctx) => number };

const f = (c: Ctx, rel: string) => mtime(path.join(c.root, rel));
const anyOf = (c: Ctx, ...rels: string[]) => Math.max(0, ...rels.map((rel) => f(c, rel)));

function voiceOutput(c: Ctx): number {
  const voice = f(c, VoiceRelPath);
  if (!voice || !hasRoster(c.root)) return voice;
  return f(c, DialogueRelPath) >= voice && f(c, SRTRelPath) >= voice ? voice : 0;
}

function sceneOutputs(c: Ctx): number[] {
  return c.scenes.filter((sc) => sc.exists && sc.output).map((sc) => mtime(path.join(sc.directory, sc.output!)));
}

function storyboardDetail(c: Ctx): string | undefined {
  try {
    const board = readStoryboard(c.root);
    if (board.scenes.length === 0) return undefined;
    const chapters = new Set(board.scenes.map((sc) => sc.chapter).filter(Boolean));
    return `${board.scenes.length} 个镜头` + (chapters.size > 0 ? ` · ${chapters.size} 章` : '');
  } catch {
    return undefined;
  }
}

/** 默认风格比分镜计划与处理方案都新。 */
function planBehindStyle(c: Ctx, out: number): boolean {
  return filmstyle.changedAfter(c.root, Math.max(out, f(c, 'production/treatment.md')));
}

/**
 * 分镜计划只写锚点，帧号由 scene_cues 按配音算进各镜头的 scene.json。重新配音后（例如修一个读音）
 * 计划本身不用改，重跑过 cues 就跟上了：配音比计划新、而且比最早一个镜头的 scene.json 还新，才是没跟上。
 */
function voiceAhead(c: Ctx, out: number): boolean {
  const voice = f(c, 'production/audio/voice.srt');
  if (voice <= out) return false;
  if (c.scenes.length === 0) return true;
  return voice > Math.min(...c.scenes.map((sc) => mtime(path.join(sc.directory, 'scene.json'))));
}

function filmReviewForProgress(c: Ctx): ReviewReport | null {
  if (c.filmReview === undefined) {
    const candidate = f(c, candidateFilm) ? candidateFilm : undefined;
    c.filmReview = latestReviewReport(c.root, candidate, { exact: true });
  }
  return c.filmReview;
}

/** 宿主自带的站的判断，键是「站:站点」。内置插件的判断随它登记（pluginJudges，例如卡点的 beat-plan:plan）。 */
const judges: Record<string, Judge> = {
  'intake:intake': { output: (c) => anyOf(c, 'production/input-inventory.md', 'production/production-config.json') },
  'script:script': {
    output: (c) => f(c, 'production/script-final.md'),
    detail: (c) => {
      try {
        // 以 # 开头的行是标题，不进配音，不算字数。
        const text = fs
          .readFileSync(path.join(c.root, 'production', 'script-final.md'), 'utf8')
          .split('\n')
          .filter((line) => !line.startsWith('#'))
          .join('\n');
        const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
        return han > 0 ? `约 ${han} 字` : undefined;
      } catch {
        return undefined;
      }
    },
  },
  // 不按稿子比配音新判过期：编排常在配好音后再改稿里的读法、短语标记，朗读的字没变。
  'voice:voice': { output: voiceOutput },
  'timeline:timeline': {
    output: (c) => (hasRoster(c.root) && !voiceOutput(c) ? 0 : f(c, 'production/audio/voice.srt')),
    stale: (c, out) => f(c, 'production/audio/voice.wav') > out,
    detail: (c) => {
      try {
        const subtitles = hasRoster(c.root) ? SRTRelPath : 'production/audio/voice.srt';
        const n = fs.readFileSync(path.join(c.root, subtitles), 'utf8').split('-->').length - 1;
        return n > 0 ? `${n} 条字幕` : undefined;
      } catch {
        return undefined;
      }
    },
  },
  'style:style': {
    output: (c) => f(c, '.agents/skills/onset-film-style/onset-film-style.json'),
    detail: (c) => {
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(c.root, '.agents/skills/onset-film-style/onset-film-style.json'), 'utf8'),
        ) as Record<string, unknown>;
        return typeof raw.cn === 'string' && raw.cn ? raw.cn : undefined;
      } catch {
        return undefined;
      }
    },
  },
  'plan:plan': {
    output: (c) => f(c, 'production/scene-plan.json'),
    // 配音改过而 cues 没跟上要重做；分镜写好之后才定风格（或换了默认风格）也要重做：分镜与处理方案是照旧的视觉写的。处理方案改过就算跟上了。
    stale: (c, out) => planBehindStyle(c, out) || voiceAhead(c, out),
    staleNote: (c, out) => (planBehindStyle(c, out) ? filmstyle.PlanBehindStyleNote : undefined),
    detail: storyboardDetail,
  },
  // 渲染：全部镜头出片才算做完，结果写几个出了片。
  'render:render': {
    output: (c) => {
      if (c.scenes.length === 0 || !c.scenes.every((sc) => sc.exists)) return 0;
      return Math.max(0, ...sceneOutputs(c));
    },
    stale: (c) => c.scenes.some((sc) => sc.stale),
    detail: (c) => {
      if (c.scenes.length === 0) return undefined;
      const done = c.scenes.filter((sc) => sc.exists && !sc.stale).length;
      const stale = c.scenes.filter((sc) => sc.exists && sc.stale).length;
      return `${done} / ${c.scenes.length} 个镜头出片` + (stale ? `，${stale} 个要重渲染` : '');
    },
  },
  'visual-qc:visual-qc': {
    output: (c) => dirMtime(path.join(c.root, 'production', 'visual-qc')),
    detail: (c) => {
      const n = countFiles(path.join(c.root, 'production', 'visual-qc'));
      return n > 0 ? `${n} 份截图与检查记录` : undefined;
    },
  },
  'assemble:assemble': {
    output: (c) => f(c, 'production/silent-master.mp4'),
    stale: (c, out) => sceneOutputs(c).some((t) => t > out),
  },
  'sound:sound': {
    output: (c) => f(c, 'production/audio/candidate.mp4'),
    stale: (c, out) => f(c, 'production/silent-master.mp4') > out,
  },
  'review:review': {
    output: (c) => filmReviewForProgress(c)?.mtime ?? 0,
    stale: (c, out) => {
      if (!f(c, candidateFilm)) return false;
      const report = filmReviewForProgress(c);
      const sha = report?.data?.video_sha256;
      return typeof sha === 'string' && sha !== ''
        ? projectVideoDigest(c.root, candidateFilm) !== sha
        : f(c, candidateFilm) > out;
    },
    detail: (c) => {
      const data = filmReviewForProgress(c)?.data;
      if (!data) return undefined;
      const problems = Array.isArray(data.problems) ? data.problems.length : 0;
      return problems === 0 ? '机器检查没有问题' : `${problems} 个问题`;
    },
  },
  'review:gate-final': {
    gateState: (c) => {
      const file = path.join(c.root, 'production', 'approval.json');
      const approved = mtime(file);
      if (approved === 0) return { status: 'todo' };
      let at: number | string = approved;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (typeof raw.approved_at === 'string' && !Number.isNaN(Date.parse(raw.approved_at))) {
          at = Date.parse(raw.approved_at);
        }
      } catch {
        // 写坏的批准记录照样算有，时间取文件的。
      }
      // 候选比批准记录新，但内容就是批准的那一份（重跑混音得到同样的字节）时不算改过。
      const changed = f(c, 'production/audio/candidate.mp4') > approved && !candidateIsApproved(c.root, file);
      return { status: changed ? 'changed' : 'confirmed', at };
    },
  },
};

/** 内置插件在 apply 里登记的判断，键同 judges。 */
function pluginJudges(): Record<string, Judge> {
  const out: Record<string, Judge> = {};
  for (const { value: s } of plugin.pluginStations()) {
    for (const [node, judge] of Object.entries(s.judges ?? {})) out[`${s.id}:${node}`] = judge;
  }
  return out;
}

/**
 * 第三方站点的声明式判断：outputs 里最新的修改时间；stale_after 里的站点产物比它新就要重做。
 * 写了 state 时：outputs 有产物就算做完（产物是最硬的证据，不再看 state）；没有时按文件里的字段定状态
 * （flow.readDeclaredState），做完的产物时间取状态文件的修改时间，说明、在等谁与「接下来」也从落到的那一项来。
 */
function declaredJudge(node: flow.RouteNode, byID: Map<string, Def>): Judge {
  const declared = node.declared!;
  const outputsTime = (c: Ctx) =>
    Math.max(
      0,
      ...declared.outputs.map((rel) => {
        const full = path.join(c.root, rel);
        try {
          return fs.statSync(full).isDirectory() ? dirMtime(full) : mtime(full);
        } catch {
          return 0;
        }
      }),
    );
  if (node.gate) return {};
  const stale: Judge['stale'] =
    declared.stale_after.length === 0
      ? undefined
      : (c, out) => declared.stale_after.some((id) => (byID.get(id)?.output(c) ?? 0) > out);
  const state = declared.state;
  const guide = declared.guide ? toPluginGuide(declared.guide) : undefined;
  if (!state) return { output: outputsTime, stale, guide };
  // 一次计算里各项判断读同一份结果。
  const memo = new WeakMap<Ctx, { time: number; outcome?: flow.DeclaredOutcome }>();
  const read = (c: Ctx): { time: number; outcome?: flow.DeclaredOutcome } => {
    let got = memo.get(c);
    if (!got) {
      const done = outputsTime(c);
      if (done > 0) got = { time: done };
      else {
        const r = flow.readDeclaredState(c.root, state);
        got = { time: r.outcome.status === 'done' ? r.mtime : 0, outcome: r.outcome };
      }
      memo.set(c, got);
    }
    return got;
  };
  return {
    output: (c) => read(c).time,
    stale,
    detail: (c) => read(c).outcome?.detail,
    waiting: (c) => read(c).outcome?.waiting,
    inProgress: (c) => read(c).outcome?.status === 'doing',
    guide,
    guideFor: (c) => {
      const own = read(c).outcome?.guide;
      return own ? toPluginGuide(own) : guide;
    },
  };
}

function toPluginGuide(g: flow.DeclaredGuide): plugin.PluginGuide {
  const out: plugin.PluginGuide = {};
  if (g.ai !== undefined) out.ai = g.ai;
  if (g.user !== undefined) out.user = g.user;
  if (g.actions) out.actions = g.actions.map((a) => ({ ...a }));
  return out;
}

/** 流程的站点连同判断。内置的普通站必须有判断函数，漏了直接报错，不让一站永远显示「没做」。 */
export function stationDefs(id: flow.FlowID, extras: readonly flow.ExtraStation[] = []): Def[] {
  const byID = new Map<string, Def>();
  const registered = pluginJudges();
  return flow.route(id, extras).map(({ station, node }) => {
    const key = `${station}:${node.id}`;
    const judge = node.declared ? declaredJudge(node, byID) : (judges[key] ?? registered[key] ?? {});
    if (!node.gate && !judge.output) throw new Error(`站点 ${station}:${node.id} 没有判断函数`);
    const def: Def = { ...node, ...judge, output: judge.output ?? (() => 0) };
    byID.set(node.id, def);
    return def;
  });
}
