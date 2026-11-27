import type { ActivityStep } from '../types';
import { describeTool } from './chat/model';

export const renderPhases = ['准备素材', '制作画面', '检查画面', '生成视频'];

function stepPhase(step: ActivityStep): number | undefined {
  const name = (step.tool ?? '')
    .toLowerCase()
    .replace(/^mcp__onset__/, '')
    .replace(/^onset[._]/, '');
  const input = step.input && typeof step.input === 'object' ? (step.input as Record<string, unknown>) : {};
  if (name === 'hyperframes') {
    if (input.subcommand === 'render') return 3;
    if (['check', 'lint', 'inspect', 'snapshot', 'validate'].includes(String(input.subcommand))) return 2;
  }
  if (['scene_lint', 'scene_frames', 'scene_preview_check', 'validate_video', 'validate_reads'].includes(name))
    return 2;
  if (['file_change', 'write', 'edit', 'multiedit', 'notebookedit'].includes(name)) return 1;
  if (['read', 'glob', 'grep', 'find', 'ls', 'config_get', 'tool_help', 'tool_search'].includes(name)) return 0;
  return undefined;
}

export interface RenderPresentation {
  phase: number | undefined;
  state: 'busy' | 'waiting' | 'warning' | 'starting';
  label: string;
  detail: string;
}

/** 阶段来自实际动作，等待是独立状态；不能把日志静默换算成进度百分比。 */
export function renderPresentation(steps: ActivityStep[], completeToolEvents = true): RenderPresentation {
  const progress = windowsRenderProgress(steps, completeToolEvents);
  const current = completeToolEvents ? currentActivityStep(steps) : steps.at(-1);
  let phase = current ? stepPhase(current) : undefined;
  if (phase === undefined)
    for (let i = steps.length - 1; i >= 0; i--) {
      phase = stepPhase(steps[i]);
      if (phase !== undefined) break;
    }
  if (!current) return { phase, state: 'starting', label: '启动中', detail: '正在启动制作工具' };
  if (progress.title === '连接重试中')
    return { phase, state: 'warning', label: '正在重连', detail: '模型连接中断，正在重试' };
  if (current.kind === 'error' || current.state === 'failed')
    return { phase, state: 'warning', label: '处理问题', detail: '这一步出现问题，正在等待后续处理' };
  if (current.kind === 'tool') {
    const info = describeTool(current.tool ?? '', current.input);
    const running = current.state === 'running';
    const verb = info.verb === '改文件' ? '更新制作文件' : info.verb;
    const detail = info.command
      ? running
        ? '正在运行制作命令'
        : '制作命令已完成'
      : `${running ? '正在' : '最近已'}${verb}`;
    return {
      phase,
      state: running ? 'busy' : 'waiting',
      label: running ? '进行中' : completeToolEvents ? '等模型回复' : '等待更新',
      detail,
    };
  }
  if (current.kind === 'thinking')
    return { phase, state: 'waiting', label: '等模型回复', detail: '刚想完一段，等模型给出下一步' };
  const message = (current.text ?? '').replaceAll('[[USER_MESSAGE]]', '').trim().split('\n')[0];
  return {
    phase,
    state: 'waiting',
    label: progress.title === '收尾中' ? '收尾中' : '等后续进展',
    detail: message || '等待下一条制作日志',
  };
}

/** 并行调用中，后来的文本或已结束工具不能盖掉仍在执行的调用。 */
export function currentActivityStep(steps: ActivityStep[]): ActivityStep | undefined {
  for (let index = steps.length - 1; index >= 0; index--) {
    if (steps[index].kind === 'tool' && steps[index].state === 'running') return steps[index];
  }
  return steps.at(-1);
}

/** Use actual provider/tool events. A completed command is not a currently running render. */
export function windowsRenderProgress(
  steps: ActivityStep[],
  completeToolEvents = true,
): { title: string; line?: string; quiet: string } {
  const latest = steps.at(-1);
  const last = completeToolEvents ? currentActivityStep(steps) : latest;
  if (!last) return { title: '启动中', quiet: '等待制作进程的第一条日志' };
  if (latest?.kind === 'error' && /reconnect|stream disconnected|tls handshake|连接.*重试/i.test(latest.text ?? ''))
    return { title: '连接重试中', line: latest.text, quiet: '模型连接中断，正在重连；已有文件保持保留' };
  if (last.kind === 'tool' && last.state === 'running') {
    const tool = (last.tool ?? '').replace(/^mcp__onset__/, '');
    const input = last.input && typeof last.input === 'object' ? (last.input as Record<string, unknown>) : {};
    if (tool === 'hyperframes' && input.subcommand === 'render')
      return { title: '取帧与编码中', quiet: '渲染工具尚未返回结果' };
    return { title: '工具运行中', quiet: '正在等待当前工具返回结果' };
  }
  if (last.kind === 'text' && (last.text ?? '').includes('视频已渲染完成'))
    return { title: '收尾中', quiet: '视频已报告生成，等待制作进程完成收尾' };
  if (last.kind === 'text' || last.kind === 'thinking') return { title: '制作中', quiet: '正在等待下一条制作日志' };
  if (last.kind === 'error')
    return { title: '处理错误中', line: last.text, quiet: '当前步骤发生错误，等待制作进程处理' };
  return completeToolEvents
    ? { title: '等待模型响应', line: '上一项已结束，等待模型继续', quiet: '当前没有工具在执行，正在等待模型继续回复' }
    : { title: '等待状态更新', line: '上一项已结束，等待后续日志', quiet: '上一项已结束，等待后续日志' };
}
