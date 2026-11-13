import { useEffect, useRef, useState } from 'react';
import type { PermissionAsk, Scene } from '../../types';
import { describeTool, type TurnBlock } from './model';

/**
 * 桌宠（场记小人）此刻在做什么。只由会话事件推出来（`buildBlocks` 整理好的最后一轮），
 * 不另装 hooks、不读 transcript：五家编排工具的流早已统一成同一套事件。
 *
 * 事件里没有「思考中」这一项：没有进行中的工具调用、也没有新的思考片段时，按「在想下一步」处理。
 */
export type CrewMood =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'running'
  | 'filming'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'stopped';

export interface CrewState {
  mood: CrewMood;
  /** 气泡里的一句话。 */
  line: string;
}

/** 发给桌宠窗口的一份：状态加上是哪个项目。没有进行中的一轮时发 null，桌宠回到待命。 */
export interface CrewSignal extends CrewState {
  project: string;
}

/** 一轮结束后小人还留多久（毫秒）显示收工，再回到待命。 */
export const crewLinger = 6000;

/** 读、写、跑命令之外，这些 am 工具是在「拍」：渲染、拼接、复查、等渲染任务，以及 HyperFrames 的 render 子命令。 */
const filmingTools = /^(mcp__am__|am[._])?(scene_run|scene_run_all|concat|review|job_wait)$/;

function filming(name: string, input: unknown): boolean {
  if (filmingTools.test(name)) return true;
  if (!/^(mcp__am__|am[._])?hyperframes$/.test(name)) return false;
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return record.subcommand === 'render';
}

/** 同时在拍好几个镜头时只点名前两个。 */
function listScenes(ids: string[]): string {
  return ids.length > 2 ? `${ids.slice(0, 2).join('、')} 等 ${ids.length} 个镜头` : ids.join('、');
}

export function crewState(turn: TurnBlock | undefined, asks: PermissionAsk[], scenes: Scene[], now: number): CrewState | null {
  if (!turn || turn.reverted) return null;
  if (turn.end) {
    const ended = Date.parse(turn.end.time);
    if (!Number.isFinite(ended) || now - ended > crewLinger) return null;
    if (turn.state === 'failed') return { mood: 'failed', line: '这一轮没做成' };
    if (turn.state === 'stopped' || turn.state === 'interrupted') return { mood: 'stopped', line: '先停在这里' };
    return { mood: 'done', line: '收工' };
  }
  if (asks.length > 0) return { mood: 'waiting', line: asks.length > 1 ? `有 ${asks.length} 件事等你批准` : '等你批准' };

  const last = [...turn.process].reverse().find((item) => item.type !== 'step');
  if (last?.type === 'tool' && !last.result) {
    const tool = last.call.tool ?? '';
    const { verb, target } = describeTool(tool, last.call.input);
    const what = shorten(target);
    const line = what ? `${verb} ${what}` : verb;
    const name = tool.toLowerCase();
    if (filming(name, last.call.input)) {
      const rendering = scenes.filter((scene) => scene.rendering).map((scene) => scene.id);
      return { mood: 'filming', line: rendering.length > 0 ? `在拍 ${listScenes(rendering)}` : line };
    }
    if (/^(read|grep|glob|ls|webfetch|websearch|web_search)$/.test(name)) return { mood: 'reading', line };
    if (/^(write|edit|multiedit|notebookedit|file_change)$/.test(name)) return { mood: 'writing', line };
    return { mood: 'running', line };
  }
  const step = turn.plan?.find((item) => item.status === 'in_progress');
  return { mood: 'thinking', line: step ? `在想：${trimVerb(step.text)}` : '在想下一步' };
}

/** 路径只留文件名，命令只留开头：气泡只有一行。 */
function shorten(target: string): string {
  const oneLine = target.split('\n')[0].trim();
  const base = /[\\/]/.test(oneLine) && !/\s/.test(oneLine) ? oneLine.split(/[\\/]/).filter(Boolean).pop() ?? oneLine : oneLine;
  return base.length > 24 ? base.slice(0, 23) + '…' : base;
}

function trimVerb(text: string): string {
  const short = text.replace(/^(正在|开始)/, '');
  return short.length > 16 ? short.slice(0, 15) + '…' : short;
}

/**
 * 主窗口把小人的状态报给主进程，主进程转给桌宠窗口（main/pet.ts）。只在内容变了时发；
 * 一轮结束后的收工要按时退场，所以那段时间里到点再算一次。离开对话（换项目、回首页）时发 null。
 */
export function useCrewBroadcast(turn: TurnBlock | undefined, asks: PermissionAsk[], scenes: Scene[], project: string): void {
  const [, setTick] = useState(0);
  const sent = useRef<string | null>(null);
  const state = crewState(turn, asks, scenes, Date.now());
  const signal: CrewSignal | null = state ? { ...state, project } : null;
  const key = JSON.stringify(signal);
  const ending = turn?.end && state ? turn.end.time : '';
  useEffect(() => {
    if (!ending) return;
    const left = Date.parse(ending) + crewLinger - Date.now();
    const timer = window.setTimeout(() => setTick((t) => t + 1), Math.max(0, left) + 100);
    return () => window.clearTimeout(timer);
  }, [ending]);
  useEffect(() => {
    if (key === sent.current) return;
    sent.current = key;
    window.am?.setCrew?.(JSON.parse(key));
  }, [key]);
  useEffect(() => () => window.am?.setCrew?.(null), []);
}
