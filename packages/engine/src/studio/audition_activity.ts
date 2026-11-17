/** 试镜共用镜头日志解析器，但盲评时只返回固定动作标签，绝不透传日志、路径、模型或耗时。 */
import fs from 'node:fs';
import path from 'node:path';
import type { Audition, Contestant } from '../audition';
import { Dir, hasRunOwner, isRunning } from '../audition';
import { marshal } from '../gojson';
import { parseAttempt, processAlive, readLive, rendererFailureAdvice } from '../scene';
import { sceneActivity, type ActivityStep } from './activity';
import { containedPath } from './sessions';

function label(step: ActivityStep, design: boolean): string {
  if (step.kind === 'thinking') return '思考画面与实现';
  if (step.kind === 'text') return '汇报制作进展';
  if (step.kind === 'error') return '处理执行错误';
  const name = (step.tool ?? '').toLowerCase().replace(/^mcp__onset__/, '').replace(/^onset[._]/, '');
  const input = step.input && typeof step.input === 'object' ? step.input as Record<string, unknown> : {};
  if (name === 'hyperframes') {
    if (input.subcommand === 'render') return '取帧与编码';
    if (['check', 'lint', 'inspect', 'snapshot', 'validate'].includes(String(input.subcommand))) return '检查画面与规格';
  }
  if (['read', 'glob', 'grep', 'find', 'ls', 'skill', 'config_get', 'tool_help'].includes(name)) return '读取素材与制作说明';
  if (['write', 'edit', 'multiedit', 'file_change', 'apply_patch'].includes(name)) return design ? '编写设计稿' : '编写画面与动画';
  if (['scene_lint', 'scene_frames', 'validate_video', 'validate_reads'].includes(name)) return '检查画面与规格';
  if (name === 'job_wait') return '等待制作任务';
  if (['bash', 'shell', 'execute', 'exec_command'].includes(name)) {
    const command = String(input.command ?? input.cmd ?? '');
    if (/\bhyperframes\s+render\b/.test(command)) return '取帧与编码';
    if (/\bhyperframes\s+(check|lint|inspect|snapshot|validate)\b/.test(command)) return '检查画面与规格';
  }
  return '运行制作工具';
}

function contestantActivity(root: string, a: Audition, c: Contestant, running: boolean, owned: boolean): Record<string, unknown> {
  if (!/^[A-FR]$/.test(c.slot)) throw new Error('invalid slot');
  const expected = path.join(Dir, a.id, c.slot);
  const dir = containedPath(root, expected);
  if (containedPath(root, c.workdir) !== dir) throw new Error('invalid workdir');
  // 日志与状态文件也校验真实路径，不能经日志软链接读到项目之外。
  for (const name of [`render-${a.scene_id}.stream.jsonl`, `design-${a.scene_id}.stream.jsonl`, `render-${a.scene_id}.live.json`, `render-${a.scene_id}.attempt.json`]) {
    try {
      fs.lstatSync(path.join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    containedPath(root, path.join(expected, name));
  }
  const modified = (prefix: string) => {
    try { return fs.statSync(path.join(dir, `${prefix}-${a.scene_id}.stream.jsonl`)).mtimeMs; } catch { return 0; }
  };
  const renderModified = modified('render');
  const design = !!c.designer && (renderModified === 0 || modified('design') > renderModified);
  const activity = sceneActivity({ directory: dir, id: a.scene_id }, design ? 'design' : 'render');
  const steps = activity.steps as ActivityStep[];
  const live = readLive(dir, a.scene_id);
  const interrupted = c.status !== 'done' && (!running || (!owned && c.status === 'running' && !!live && !processAlive(live.pid)));
  const active = [...steps].reverse().find(step => step.kind === 'tool' && step.state === 'running');
  const serviceError = [...steps].reverse().find(step => step.kind === 'error')?.text ?? '';
  const advice = rendererFailureAdvice(c.error) ?? (/^$|^渲染器退出码|^渲染结束但产物不存在/.test(c.error) ? rendererFailureAdvice(serviceError) : null);
  let warning = '';
  try { warning = parseAttempt(fs.readFileSync(path.join(dir, `render-${a.scene_id}.attempt.json`))).warning ?? ''; } catch { /* 旧记录没有告警字段。 */ }
  let state: string;
  let current: string;
  let hint: string | undefined;
  if (c.status === 'done') {
    state = c.outcome === 'succeeded' ? 'done' : c.outcome === 'interrupted' ? 'interrupted' : 'failed';
    current = state === 'done' ? '已完成' : state === 'interrupted' ? '试镜已中断'
      : c.outcome === 'verification_failed' ? '画面验收未通过' : advice?.label ?? (c.output ? '视频已生成，任务未完成' : '制作失败，尚未生成视频');
    hint = state === 'done' ? (warning ? '模型异常结束，但已有视频已通过本机验收。' : undefined)
      : c.outcome === 'verification_failed' ? '视频未通过规格或源码检查，需要修改后重试。'
      : advice?.hint;
    if (state !== 'done' && c.output && c.outcome !== 'verification_failed') hint = `${hint ?? ''} 已有视频已保留，重试时先做本机验收。`.trim();
  } else if (interrupted) {
    state = 'interrupted';
    current = '试镜已中断';
  } else if (c.status === 'pending') {
    state = 'pending';
    current = '等待上场';
  } else if (!activity.rendering || steps.length === 0) {
    state = 'starting';
    current = design ? '准备设计稿' : '准备渲染';
  } else {
    state = active ? 'running' : 'waiting';
    current = active ? label(active, design) : '等待模型响应';
  }
  const reveal = a.verdict !== null || c.role === 'reference';
  const ended = ['done', 'failed', 'interrupted'].includes(state);
  return {
    slot: c.slot, state, current, hint, phase: design ? 'design' : 'render', step_count: activity.step_count,
    steps: steps.map(step => ({
      label: label(step, design),
      state: step.state === 'running' && ended ? 'interrupted' : step.state ?? (step.kind === 'error' ? 'failed' : 'done'),
      ...(reveal ? { detail: step.text || step.output || (step.input ? marshal(step.input) : '') } : {}),
    })),
  };
}

export function auditionActivity(root: string, a: Audition, projectBusy = false): Record<string, unknown> {
  let running = projectBusy;
  let owned = false;
  try { owned = hasRunOwner(root, a); running ||= isRunning(root, a); } catch { running = true; }
  return { contestants: a.contestants.map(c => {
    try {
      return contestantActivity(root, a, c, running, owned);
    } catch {
      return { slot: c.slot, state: 'unavailable', current: '暂时无法读取过程', step_count: 0, steps: [] };
    }
  }) };
}
