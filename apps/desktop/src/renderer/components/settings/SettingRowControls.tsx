import type { AgentsResponse, SettingRow, SettingsResponse } from '../../types';
import { AgentOptionsSelect } from '../AgentOptionsSelect';
import { DirectorVisionNote } from '../DirectorServices';
import { ModelSelect } from '../ModelSelect';
import type { RunAction } from '../Preview';

const sourceNote: Record<SettingRow['source'], string> = {
  env: '这一项被电脑上的环境变量定死了，这里改了不生效',
  dotenv: '这一项被这个项目的 .env 文件定死了，这里改了不生效',
  project: '',
  global: '',
  default: '',
};

// 只有「润色与检查」的默认是空：跟随对话助手。
function labelOf(row: SettingRow, value: string): string {
  return value === '' ? '跟随对话助手' : (row.options.find((o) => o.value === value)?.label ?? value);
}

// 工具跟随对话助手时模型也跟随它的模型，没有可选的。
function followsModel(ariaLabel: string) {
  return (
    <select disabled aria-label={ariaLabel}>
      <option>跟随对话助手的模型</option>
    </select>
  );
}

// 这家工具没有可调的选项（或还没读到工具列表）时照实说，不放一个空着的控件。
function noOptions(ariaLabel: string, text: string) {
  return (
    <select disabled aria-label={ariaLabel}>
      <option>{text}</option>
    </select>
  );
}

export interface SettingRowProps {
  row: SettingRow;
  data: SettingsResponse;
  agents: AgentsResponse | null;
  agentsError: string;
  version: number;
  opened: boolean;
  saving: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSetGlobal: (row: SettingRow, value: string) => void;
  run: RunAction;
}

export function SettingRowItem({
  row,
  data,
  agents,
  agentsError,
  version,
  opened,
  saving,
  onOpen,
  onClose,
  onSetGlobal,
  run,
}: SettingRowProps) {
  // 模型项与选项项跟着哪家工具：全局一栏看全局的工具，「这个项目」一栏看这个项目实际用的工具。
  const toolRow = data.rows.find((t) => t.key === (row.model_of ?? row.options_of));
  const globalTool = toolRow ? toolRow.global || toolRow.default : '';
  const projectTool = toolRow ? toolRow.project || toolRow.global || toolRow.default : '';
  // 选项项的模型那一行（ORCHESTRATOR_OPTIONS → ORCHESTRATOR_MODEL）：codex 按模型收窄推理档位。
  const modelRow = data.rows.find((r) => r.model_of === row.options_of);
  const specsOf = (tool: string) => {
    const specs = agents?.agents.find((a) => a.id === tool)?.option_specs ?? [];
    return specs.filter((spec) => !spec.rendererOnly || row.options_of === 'RENDERER');
  };

  const renderGlobalModel = () => {
    if (globalTool === '') return followsModel(`全局${row.label}`);
    return (
      <ModelSelect
        ariaLabel={`全局${row.label}`}
        tool={globalTool}
        value={row.global}
        defaultLabel="默认（由工具自己决定）"
        onChange={(value) => onSetGlobal(row, value)}
      />
    );
  };

  const renderProjectModel = () => {
    if (projectTool === '') return followsModel(`这个项目的${row.label}`);
    const inherited = projectTool === globalTool ? row.global : '';
    return (
      <ModelSelect
        ariaLabel={`这个项目的${row.label}`}
        className={row.project !== '' ? 'overridden' : ''}
        tool={projectTool}
        value={row.project}
        defaultLabel={`和其他项目一样（${inherited || '默认'}）`}
        onChange={(value) => run('/api/settings/project', { key: row.key, value })}
      />
    );
  };

  const renderGlobalOptions = () => {
    if (globalTool === '') return noOptions(`全局${row.label}`, '跟随对话助手的选项');
    const specs = specsOf(globalTool);
    if (specs.length === 0) {
      return noOptions(
        `全局${row.label}`,
        agents ? '这家工具没有可调的选项' : agentsError ? '工具列表读取失败' : '正在读取…',
      );
    }
    return (
      <div className="settings-options">
        <AgentOptionsSelect
          tool={globalTool}
          specs={specs}
          value={row.global}
          disabled={saving}
          model={modelRow?.global ?? ''}
          ariaPrefix="全局"
          onChange={(value) => onSetGlobal(row, value)}
        />
      </div>
    );
  };

  const renderProjectOptions = () => {
    if (projectTool === '') return noOptions(`这个项目的${row.label}`, '跟随对话助手的选项');
    const specs = specsOf(projectTool);
    if (specs.length === 0) {
      return noOptions(
        `这个项目的${row.label}`,
        agents ? '这家工具没有可调的选项' : agentsError ? '工具列表读取失败' : '正在读取…',
      );
    }
    return (
      <div className={'settings-options' + (row.project !== '' ? ' overridden' : '')}>
        <AgentOptionsSelect
          tool={projectTool}
          specs={specs}
          value={row.project}
          inherited={projectTool === globalTool ? row.global : ''}
          inheritLabel="和其他项目一样"
          model={modelRow ? modelRow.project || (projectTool === globalTool ? modelRow.global : '') : ''}
          ariaPrefix="这个项目的"
          onChange={(value) => run('/api/settings/project', { key: row.key, value })}
        />
      </div>
    );
  };

  // 「默认」那一项已经写明是谁，下面就不再重复列出同一个选项，免得出现「默认（Codex）」和「Codex」两个。
  const renderGlobalTool = () => {
    const value = row.global === row.default ? '' : row.global;
    return (
      <select aria-label={`全局${row.label}`} value={value} onChange={(e) => onSetGlobal(row, e.target.value)}>
        <option value="">{labelOf(row, row.default)}（默认）</option>
        {row.options
          .filter((o) => o.value !== row.default)
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </select>
    );
  };

  const renderProjectTool = () => {
    const globalValue = row.global || row.default;
    return (
      <select
        aria-label={`这个项目的${row.label}`}
        className={row.project !== '' ? 'overridden' : ''}
        value={row.project}
        onChange={(e) => run('/api/settings/project', { key: row.key, value: e.target.value })}
      >
        <option value="">和其他项目一样（{labelOf(row, globalValue)}）</option>
        {row.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  };

  const note = sourceNote[row.source];
  const hasProject = data.has_project;
  const own = row.project !== '';
  const showProject = hasProject && (own || opened);
  return (
    <div className={'settings-row' + (row.model_of || row.options_of ? ' sub' : '')} data-key={row.key}>
      <div className="settings-label">
        <strong>{row.label}</strong>
        <span>{row.hint}</span>
        {note && <em>{note}</em>}
        {row.model_of && globalTool === 'director' && (
          <DirectorVisionNote model={row.global} version={version} compact />
        )}
      </div>
      <div className="settings-controls">
        {row.model_of ? renderGlobalModel() : row.options_of ? renderGlobalOptions() : renderGlobalTool()}
        {hasProject && !showProject && (
          <button className="link settings-own" onClick={onOpen}>
            只给这个项目换
          </button>
        )}
        {showProject && (
          <div className={'settings-project' + (own ? ' own' : '')}>
            <span>
              这个项目单独用
              <button
                className="link"
                onClick={() => {
                  if (own) run('/api/settings/project', { key: row.key, value: '' });
                  onClose();
                }}
              >
                {own ? '改回和其他项目一样' : '算了'}
              </button>
            </span>
            {row.model_of ? renderProjectModel() : row.options_of ? renderProjectOptions() : renderProjectTool()}
          </div>
        )}
      </div>
    </div>
  );
}
