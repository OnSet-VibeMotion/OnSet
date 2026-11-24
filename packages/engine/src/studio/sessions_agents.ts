/**
 * 会话的编排/渲染工具配置覆盖、审批启动参数，以及事件流的重放过滤与任务清单提取。
 */
import * as agentrun from '../agentrun';
import * as config from '../config';
import { onsetCommand } from '../envutil';
import { PermissionServerName } from '../studioview';
import * as tools from '../tools';
import type { AgentChoice, SessionMeta } from './sessions_types';

/** 读项目配置，再用会话选定的工具覆盖（agents.go 的 sessionConfig，放在这里免得循环导入）。 */
export function sessionConfig(projectPath: string, meta: SessionMeta): config.Config {
  const cfg = config.load(projectPath, null);
  return overrideAgents(cfg, {
    tool: meta.tool,
    renderer: meta.renderer ?? '',
    model: meta.model ?? '',
    rendererModel: meta.renderer_model ?? '',
    options: meta.options ?? '',
    rendererOptions: meta.renderer_options ?? '',
  });
}

export function validateChoice(choice: AgentChoice): void {
  if (choice.tool !== '' && !tools.ValidTools.has(choice.tool)) throw new Error(`未知的编排工具：${choice.tool}`);
  if (choice.renderer !== '' && !tools.ValidRenderers.has(choice.renderer))
    throw new Error(`未知的渲染工具：${choice.renderer}`);
  for (const value of [choice.model, choice.rendererModel]) {
    if (value && !config.validModel(value))
      throw new Error(`不认识的模型名 ${value}：只能用字母、数字与 . _ - : / @ # [ ] +`);
  }
  for (const [tool, value] of [
    [choice.tool, choice.options],
    [choice.renderer, choice.rendererOptions],
  ]) {
    if (!value) continue;
    let error = '';
    if (tool) error = tools.validateAgentOptions(tool, value);
    else if (!tools.validOptionsText(value)) error = `选项写法不对：${value}`;
    if (error) throw new Error(error);
  }
}

export function overrideAgents(cfg: config.Config, choice: AgentChoice): config.Config {
  validateChoice({ ...choice, tool: choice.tool || cfg.orchestrator, renderer: choice.renderer || cfg.renderer });
  const out = { ...cfg };
  // 换了工具、又没选模型时，设置里的模型是给原来那家的，不能带过去。
  // 选项同理。
  if (choice.tool !== '' && choice.tool !== cfg.orchestrator) {
    out.orchestratorModel = '';
    out.orchestratorOptions = '';
  }
  if (choice.renderer !== '' && choice.renderer !== cfg.renderer) {
    out.rendererModel = '';
    out.rendererOptions = '';
  }
  if (choice.tool !== '') out.orchestrator = choice.tool;
  if (choice.renderer !== '') out.renderer = choice.renderer;
  if (choice.model) out.orchestratorModel = choice.model;
  if (choice.rendererModel) out.rendererModel = choice.rendererModel;
  // 会话选的选项逐项盖在设置上（同一家工具时设置里的还在，换了工具上面已经清空）。
  if (choice.options) out.orchestratorOptions = tools.mergeAgentOptions(out.orchestratorOptions, choice.options);
  if (choice.rendererOptions)
    out.rendererOptions = tools.mergeAgentOptions(out.rendererOptions, choice.rendererOptions);
  return out;
}

/**
 * 认出续接时重放的上一轮结尾：这一轮开头、还没有任何新东西之前，与上一轮里某段思考或回复一字不差的，算重放、丢掉；
 * 一出现新的东西（工具调用、不一样的话）就不再拦。qoder 续接时若先压缩了长对话，会把上一轮最后的思考与回复
 * 原样再吐一遍（2026-11 实测：用户的新问题前面先出现一遍上一轮的总结），界面上看像是又回答了一次。
 */
export function replayGuard(
  events: readonly { kind?: string; text?: string; turn_id?: string }[],
  turnID: string,
): (event: { kind: string; text?: string; text_id?: string }) => boolean {
  let previousTurn = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const id = events[i].turn_id ?? '';
    if (id !== '' && id !== turnID) {
      previousTurn = id;
      break;
    }
  }
  const said = new Set<string>();
  for (const e of events) {
    if (
      e.turn_id === previousTurn &&
      (e.kind === agentrun.KindText || e.kind === agentrun.KindThinking) &&
      (e.text ?? '').trim() !== ''
    )
      said.add(e.kind + '\u0000' + (e.text ?? '').trim());
  }
  let guarding = said.size > 0;
  return (event) => {
    if (!guarding) return false;
    // ACP 已在 session/load 时过滤历史；流式短片段相同不代表重放（例如两轮都以 Let me 开头）。
    if (event.text_id) {
      guarding = false;
      return false;
    }
    if (event.kind === agentrun.KindText || event.kind === agentrun.KindThinking) {
      if (said.has(event.kind + '\u0000' + (event.text ?? '').trim())) return true;
      guarding = false;
      return false;
    }
    if (
      event.kind === agentrun.KindToolCall ||
      event.kind === agentrun.KindToolResult ||
      event.kind === agentrun.KindPlan
    )
      guarding = false;
    return false;
  };
}

/** 最后一份任务清单。解析器续接要求编号；交接提示词不要求，兼容旧事件文件只保存 text/status。 */
export function lastTaskPlan(
  events: readonly { kind?: string; plan?: agentrun.PlanItem[] }[],
  requireIDs = true,
): agentrun.PlanItem[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const plan = events[i].kind === agentrun.KindPlan ? events[i].plan : undefined;
    if (plan && plan.length > 0) return !requireIDs || plan.some((item) => item.id) ? plan : undefined;
  }
  return undefined;
}

/** 审批服务（onset studio permission-mcp）的启动方式；Windows 上用 Electron / Node 跑 onset.cjs（envutil.onsetCommand）。 */
export function permissionPrompt(executable: string): tools.PermissionPrompt {
  const onset = onsetCommand(executable);
  return {
    command: onset.command,
    args: [...onset.args, 'studio', 'permission-mcp'],
    server: PermissionServerName,
    env: onset.env,
  };
}
