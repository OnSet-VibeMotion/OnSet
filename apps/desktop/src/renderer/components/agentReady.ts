import type { AgentInfo, AgentsResponse } from '../types';

/**
 * 渲染工具能不能用：镜头由 Claude Code、Codex 这类工具来画，导演只做编排。设置里的渲染工具没装在这台电脑上时，
 * 整片制作会一路做到第一次渲染才报错，所以首次引导、首页与「开始制作」都先看这里。
 */
export interface RendererState {
  /** 能用（或者还不知道：工具列表还没取到、没有选）。 */
  ok: boolean;
  /** 选的那一家。 */
  info?: AgentInfo;
  /** 这台电脑上装好了、能渲染的几家。 */
  installed: AgentInfo[];
  /** 不能用时给用户看的一句话。 */
  reason: string;
}

export function rendererState(agents: AgentsResponse | null, renderer: string): RendererState {
  if (!agents || renderer === '') return { ok: true, installed: [], reason: '' };
  const installed = agents.agents.filter((a) => a.renderer && a.installed);
  const info = agents.agents.find((a) => a.id === renderer);
  if (info?.renderer && info.installed) return { ok: true, info, installed, reason: '' };
  const name = info?.label ?? renderer;
  const reason =
    installed.length > 0
      ? `画面要靠 ${name} 来画，这台电脑上没有它；换成已经装好的 ${installed.map((a) => a.label).join('、')} 就能开工`
      : '画面要靠 Claude Code、Codex 这类工具来画，这台电脑上一个都还没装';
  return { ok: false, info, installed, reason };
}
