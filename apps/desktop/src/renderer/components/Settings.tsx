import { useEffect, useState } from 'react';
import { api, errorText, post } from '../api';
import type { AgentKeysResponse, SettingRow, SettingsResponse } from '../types';
import { ModelSelect } from './ModelSelect';
import type { RunAction } from './Preview';
import '../settings.css';

/**
 * 设置页：每一项「什么用什么」都有一个全局值，所有项目默认跟着它；某个项目要不一样，在「这个项目」一栏单独设，
 * 也能一键改回跟随全局。全局值在进程里直接写（用户级文件），项目的值写进项目配置，走写任务。
 */

const sourceNote: Record<SettingRow['source'], string> = {
  env: '现在被环境变量覆盖，这里改了也不生效',
  dotenv: '现在被这个项目的 .env 覆盖',
  project: '',
  global: '',
  default: '',
};

export function Settings({ version, run }: { version: number; run: RunAction }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState('');

  const reload = () =>
    api<SettingsResponse>('/api/settings').then(
      (value) => {
        setData(value);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  useEffect(() => {
    void reload();
  }, [version]);

  if (!data) return <div className="empty">{error || '正在读取设置…'}</div>;

  const label = (row: SettingRow, value: string) => row.options.find((o) => o.value === value)?.label ?? value;
  const setGlobal = async (row: SettingRow, value: string) => {
    try {
      await post('/api/settings/global', { key: row.key, value });
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const overrides = data.rows.filter((r) => r.project !== '');
  // 模型项跟着哪家工具：全局一栏看全局的工具，「这个项目」一栏看这个项目实际用的工具。
  const toolRow = (r: SettingRow) => data.rows.find((t) => t.key === r.model_of);
  const globalTool = (r: SettingRow) => {
    const t = toolRow(r);
    return t ? t.global || t.default : '';
  };
  const projectTool = (r: SettingRow) => {
    const t = toolRow(r);
    return t ? t.project || t.global || t.default : '';
  };

  return (
    <div className="settings">
      <p className="settings-intro">
        全局设置对所有项目生效。某个项目要用不一样的，在「这个项目」一栏单独选；选「跟随全局」就回到全局设置。对话输入框底部还能给单次对话临时换编排、渲染工具和模型。
      </p>
      <div className={data.has_project ? 'settings-grid with-project' : 'settings-grid'}>
        <span />
        <span className="settings-col">全局</span>
        {data.has_project && (
          <span className="settings-col">
            这个项目
            {overrides.length > 0 && (
              <button className="link" onClick={() => run('/api/settings/project', { key: '*', value: '' })}>
                全部跟随全局
              </button>
            )}
          </span>
        )}
        {data.rows.map((row) => {
          const note = sourceNote[row.source];
          return (
            <div className="settings-row" key={row.key} data-key={row.key}>
              <div className="settings-label">
                <strong>{row.label}</strong>
                <span>{row.hint}</span>
                {note && <em>{note}</em>}
              </div>
              {row.model_of ? modelCells(row, data.has_project) : toolCells(row, data.has_project)}
            </div>
          );
        })}
      </div>
      {error && <div className="settings-error">{error}</div>}
      <AgentKeys version={version} />
      <p className="settings-file">全局设置保存在 {data.file}</p>
    </div>
  );

  function modelCells(row: SettingRow, hasProject: boolean) {
    const inherited = projectTool(row) === globalTool(row) ? row.global : '';
    return (
      <>
        <ModelSelect
          ariaLabel={`全局${row.label}`}
          tool={globalTool(row)}
          value={row.global}
          defaultLabel="这家工具自己的默认"
          onChange={(value) => void setGlobal(row, value)}
        />
        {hasProject && (
          <ModelSelect
            ariaLabel={`这个项目的${row.label}`}
            className={row.project !== '' ? 'overridden' : ''}
            tool={projectTool(row)}
            value={row.project}
            defaultLabel={inherited ? `跟随全局（${inherited}）` : '跟随全局（默认模型）'}
            onChange={(value) => run('/api/settings/project', { key: row.key, value })}
          />
        )}
      </>
    );
  }

  function toolCells(row: SettingRow, hasProject: boolean) {
    const globalValue = row.global || row.default;
    return (
      <>
        <select aria-label={`全局${row.label}`} value={row.global} onChange={(e) => void setGlobal(row, e.target.value)}>
          <option value="">默认（{label(row, row.default)}）</option>
          {row.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {hasProject && (
          <select
            aria-label={`这个项目的${row.label}`}
            className={row.project !== '' ? 'overridden' : ''}
            value={row.project}
            onChange={(e) => run('/api/settings/project', { key: row.key, value: e.target.value })}
          >
            <option value="">跟随全局（{label(row, globalValue)}）</option>
            {row.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </>
    );
  }
}

/**
 * 导演用哪家模型服务：每家一行，填了 key 就能在「编排模型」里选它的模型。key 只写进用户目录里一个
 * 只有自己能读的文件，界面上不回显。
 */
export function AgentKeys({ version, onChange }: { version: number; onChange?: (data: AgentKeysResponse) => void }) {
  const [data, setData] = useState<AgentKeysResponse | null>(null);
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<AgentKeysResponse>('/api/agent-keys').then(setData, (err) => setError(errorText(err)));
  }, [version]);

  const save = async (provider: string, key: string) => {
    try {
      const next = await post<AgentKeysResponse>('/api/agent-keys', { provider, key });
      setData(next);
      onChange?.(next);
      setEditing('');
      setDraft('');
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!data) return error ? <div className="settings-error">{error}</div> : null;
  return (
    <section className="agent-keys" aria-label="导演的模型服务">
      <div className="agent-keys-head">
        <strong>导演的模型服务</strong>
        <span>编排选「导演」时用。填一家的 API key 就能开工，没选编排模型时用推荐的那个。</span>
      </div>
      <ul>
        {data.providers.map((p) => (
          <li key={p.id} data-provider={p.id} className={p.configured ? 'configured' : ''}>
            <span className="agent-key-name">
              {p.label}
              {p.default_model && <small>推荐 {p.default_model.slice(p.id.length + 1)}</small>}
            </span>
            {editing === p.id ? (
              <form
                className="agent-key-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim() !== '') void save(p.id, draft);
                }}
              >
                <input type="password" autoFocus aria-label={`${p.label} 的 API key`} placeholder="粘贴 API key" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <button type="submit" disabled={draft.trim() === ''}>
                  保存
                </button>
                <button type="button" className="link" onClick={() => setEditing('')}>
                  取消
                </button>
              </form>
            ) : (
              <span className="agent-key-actions">
                <span className="agent-key-state">{p.configured ? '已填写' : '未填写'}</span>
                <button
                  className="link"
                  onClick={() => {
                    setEditing(p.id);
                    setDraft('');
                  }}
                >
                  {p.configured ? '更换' : '填写'}
                </button>
                {p.configured && (
                  <button className="link" onClick={() => void save(p.id, '')}>
                    删除
                  </button>
                )}
                <a href={p.key_url} target="_blank" rel="noreferrer">
                  去申请
                </a>
              </span>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="settings-error">{error}</div>}
    </section>
  );
}
