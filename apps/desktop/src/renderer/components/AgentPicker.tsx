import type { AgentChoice, AgentsResponse } from '../types';
import { ModelSelect } from './ModelSelect';

interface Props {
  agents: AgentsResponse | null;
  value: AgentChoice;
  disabled: boolean;
  onChange: (choice: AgentChoice) => void;
}

/**
 * 编排工具与渲染工具的选择（各带一个模型），放在输入框底部。没装的工具可见但不可选，免得选了才在运行时报找不到命令。
 * 换工具时模型回到「默认」：模型名只对那一家有意义。
 */
export function AgentPicker({ agents, value, disabled, onChange }: Props) {
  if (!agents) return null;
  // 渲染一栏只列能当渲染工具的；已经选着的照样显示，免得下拉框空着。
  const options = (current: string, fallback: string, seat: 'orchestrator' | 'renderer') =>
    agents.agents
      .filter((agent) => seat === 'orchestrator' || agent.renderer || agent.id === current)
      .map((agent) => (
        <option key={agent.id} value={agent.id} disabled={!agent.installed && agent.id !== current} title={agent.hint ?? agent.path ?? (agent.installed ? agent.label : `找不到 ${agent.command}`)}>
          {agent.label}
          {agent.installed ? '' : agent.hint ? '（未设置）' : '（未安装）'}
          {agent.id === fallback ? ' · 默认' : ''}
        </option>
      ));
  // 「默认」一项：工具与设置里的相同时跟随设置里的模型，不同时是那家工具自己的默认。
  const defaultLabel = (tool: string, configured: string, configuredModel: string) =>
    tool === configured && configuredModel ? `跟随设置（${configuredModel}）` : '默认模型';
  return (
    <>
      <label className="agent-select" title="在项目目录里对话、改文件的工具">
        <span>编排</span>
        <select id="agent-tool" value={value.tool} disabled={disabled} onChange={(e) => onChange({ ...value, tool: e.currentTarget.value, model: '' })}>
          {options(value.tool, agents.orchestrator, 'orchestrator')}
        </select>
        {value.tool && (
          <ModelSelect
            id="agent-model"
            ariaLabel="编排模型"
            tool={value.tool}
            value={value.model ?? ''}
            defaultLabel={defaultLabel(value.tool, agents.orchestrator, agents.orchestrator_model)}
            disabled={disabled}
            onChange={(model) => onChange({ ...value, model })}
          />
        )}
      </label>
      <label className="agent-select" title="渲染单个镜头用的工具">
        <span>渲染</span>
        <select
          id="agent-renderer"
          value={value.renderer}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, renderer: e.currentTarget.value, renderer_model: '' })}
        >
          {options(value.renderer, agents.renderer, 'renderer')}
        </select>
        {value.renderer && (
          <ModelSelect
            id="agent-renderer-model"
            ariaLabel="渲染模型"
            tool={value.renderer}
            value={value.renderer_model ?? ''}
            defaultLabel={defaultLabel(value.renderer, agents.renderer, agents.renderer_model)}
            disabled={disabled}
            onChange={(renderer_model) => onChange({ ...value, renderer_model })}
          />
        )}
      </label>
      {agents.config_error && <span className="error-line agent-error">{agents.config_error}</span>}
    </>
  );
}
