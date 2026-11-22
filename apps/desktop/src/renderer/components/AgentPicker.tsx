import { useRef, useState } from 'react';
import type { AgentChoice, AgentsResponse } from '../types';
import { ModelPicker } from './ModelPicker';

interface Props {
  agents: AgentsResponse | null;
  value: AgentChoice;
  disabled: boolean;
  onChange: (choice: AgentChoice) => void | Promise<void>;
}

/**
 * 编排工具与渲染工具的选择，放在输入框底部。工具后面是一个按钮，点开是模型与那家能调的选项（推理强度、快速模式、
 * 上下文长度……）的弹出框（ModelPicker）。
 * 没装的工具可见但不可选，免得选了才在运行时报找不到命令。换工具时模型与选项回到「默认」：它们只对那一家有意义。
 */
export function AgentPicker({ agents, value, disabled, onChange }: Props) {
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const change = async (next: AgentChoice) => {
    if (disabled || pending.current) return;
    pending.current = true;
    try {
      const result = onChange(next);
      if (result) { setSaving(true); await result; }
    }
    finally { pending.current = false; setSaving(false); }
  };
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
  const specsOf = (tool: string) => agents.agents.find((a) => a.id === tool)?.option_specs ?? [];
  return (
    <>
      <label className="agent-select" title="在项目目录里对话、改文件的工具">
        <span>编排</span>
        <select id="agent-tool" value={value.tool} disabled={disabled || saving} onChange={(e) => void change({ ...value, tool: e.currentTarget.value, model: '', options: '' })}>
          {options(value.tool, agents.orchestrator, 'orchestrator')}
        </select>
        {value.tool && (
          <ModelPicker
            id="agent-model"
            ariaLabel="编排模型"
            tool={value.tool}
            model={value.model ?? ''}
            defaultLabel={defaultLabel(value.tool, agents.orchestrator, agents.orchestrator_model)}
            fallbackModel={value.tool === agents.orchestrator ? agents.orchestrator_model : ''}
            specs={specsOf(value.tool).filter((spec) => !spec.rendererOnly)}
            options={value.options ?? ''}
            inheritedOptions={value.tool === agents.orchestrator ? (agents.orchestrator_options ?? '') : ''}
            disabled={disabled || saving}
            onModel={(model) => void change({ ...value, model })}
            onOptions={(options) => void change({ ...value, options })}
          />
        )}
      </label>
      <label className="agent-select" title="渲染单个镜头用的工具">
        <span>渲染</span>
        <select
          id="agent-renderer"
          value={value.renderer}
          disabled={disabled || saving}
          onChange={(e) => void change({ ...value, renderer: e.currentTarget.value, renderer_model: '', renderer_options: '' })}
        >
          {options(value.renderer, agents.renderer, 'renderer')}
        </select>
        {value.renderer && (
          <ModelPicker
            id="agent-renderer-model"
            ariaLabel="渲染模型"
            tool={value.renderer}
            model={value.renderer_model ?? ''}
            defaultLabel={defaultLabel(value.renderer, agents.renderer, agents.renderer_model)}
            fallbackModel={value.renderer === agents.renderer ? agents.renderer_model : ''}
            specs={specsOf(value.renderer)}
            options={value.renderer_options ?? ''}
            inheritedOptions={value.renderer === agents.renderer ? (agents.renderer_options ?? '') : ''}
            disabled={disabled || saving}
            onModel={(renderer_model) => void change({ ...value, renderer_model })}
            onOptions={(renderer_options) => void change({ ...value, renderer_options })}
          />
        )}
      </label>
      {agents.config_error && <span className="error-line agent-error">{agents.config_error}</span>}
    </>
  );
}
