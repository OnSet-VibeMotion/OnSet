import { useEffect, useRef, useState } from 'react';
import { api, errorText, post } from '../api';
import '../settings.css';
import type { AgentsResponse, SettingRow, SettingsResponse } from '../types';
import { DirectorServices } from './DirectorServices';
import { Icon, type IconName } from './Icon';
import type { RunAction } from './Preview';
import { SkinPicker } from './Skins';
import { PluginSettings } from './Stations';
import { MachineSettings } from './settings/MachineSettings';
import { SettingRowItem } from './settings/SettingRowControls';
import { UpdatePanel, useUpdateState } from './Updates';

export { MachineSettings } from './settings/MachineSettings';

/**
 * 设置页：左边按用途分块导航（AI 助手、画面渲染、配音与字幕、外观、功能与插件），右边一块一块往下排，滚到哪块左边亮哪块。
 * 每一项「什么用什么」都有一个全局值，所有项目默认跟着它；某个项目要不一样，在「这个项目」一栏单独设，
 * 也能一键改回跟随全局。全局值在进程里直接写（用户级文件），项目的值写进项目配置，走写任务。
 */

/** 设置分几块，左边导航、右边按块排；每块一个图标、一个名字、一句话说清它管什么。 */
interface Group {
  id: string;
  title: string;
  icon: IconName;
  blurb: string;
  keys: string[];
}

const groups: Group[] = [
  {
    id: 'ai',
    title: 'AI 助手',
    icon: 'brain',
    blurb: '和你对话、写稿、定分镜、安排渲染的那位，帮你润色、检查画面描述的那位，以及它能不能不问你直接跑命令。',
    keys: [
      'ORCHESTRATOR',
      'ORCHESTRATOR_MODEL',
      'ORCHESTRATOR_OPTIONS',
      'OPTIMIZER',
      'OPTIMIZER_MODEL',
      'OPTIMIZER_OPTIONS',
      'AUTO_APPROVE',
    ],
  },
  {
    id: 'render',
    title: '画面渲染',
    icon: 'film',
    blurb: '把每个镜头画出来的工具、一次画几个，以及要不要记住画过的问题。',
    keys: ['RENDERER', 'RENDERER_MODEL', 'RENDERER_OPTIONS', 'SCENE_JOBS', 'MEMORY'],
  },
  {
    id: 'voice',
    title: '配音与字幕',
    icon: 'mic',
    blurb: '口播稿用谁来读，字幕怎样和声音逐字对上。',
    keys: ['TTS_PROVIDER', 'ALIGN_PROVIDER'],
  },
  { id: 'look', title: '外观', icon: 'brush', blurb: '整个客户端与桌宠的配色。', keys: [] },
  { id: 'plugins', title: '功能与插件', icon: 'plug', blurb: '片场自带的功能，和你自己装的插件。', keys: [] },
  {
    id: 'network',
    title: '网络与更新',
    icon: 'globe',
    blurb: '取插件中心、下载插件、检查新版本时怎样联网。只对这台电脑生效。',
    keys: [],
  },
];

export function Settings({
  version,
  run,
  onPluginsChanged,
  onAgentsChanged,
  project,
  onOpenPage,
}: {
  version: number;
  run: RunAction;
  onPluginsChanged?: () => void;
  onAgentsChanged?: () => void;
  project?: boolean;
  onOpenPage?: (tab: string) => void;
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  // 每家工具能调哪些选项（推理强度、快速模式……）在 /api/agents 的 option_specs 里。
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [agentsError, setAgentsError] = useState('');
  const loadAgents = () => {
    setAgentsError('');
    return api<AgentsResponse>('/api/agents').then(setAgents, (err) => setAgentsError(errorText(err)));
  };
  const [error, setError] = useState('');
  const [active, setActive] = useState(groups[0].id);
  // 哪几项点了「只给这个项目换」：没单独改过的项默认只露一个下拉框。
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const body = useRef<HTMLDivElement>(null);
  const update = useUpdateState();

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
    void loadAgents();
  }, [version]);

  if (!data) return <div className="empty">{error || '正在读取设置…'}</div>;

  const setGlobal = async (row: SettingRow, value: string) => {
    setSaving((old) => new Set(old).add(row.key));
    try {
      await post('/api/settings/global', { key: row.key, value });
      await reload();
      onAgentsChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving((old) => {
        const next = new Set(old);
        next.delete(row.key);
        return next;
      });
    }
  };
  const overrides = data.rows.filter((r) => r.project !== '');
  // 不在任何一块里的项（以后新加的）放进最后一块「其他」，不会悄悄不见。
  const grouped = new Set(groups.flatMap((g) => g.keys));
  const others = data.rows.filter((r) => !grouped.has(r.key));
  const shown: Group[] = others.length
    ? [...groups, { id: 'other', title: '其他', icon: 'more', blurb: '', keys: others.map((r) => r.key) }]
    : groups;

  const jump = (id: string) => {
    setActive(id);
    body.current?.querySelector(`[data-group="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // 滚到哪一块，左边就亮哪一块。
  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + 48;
    let current = shown[0].id;
    for (const g of shown) {
      const sec = el.querySelector<HTMLElement>(`[data-group="${g.id}"]`);
      if (sec && sec.getBoundingClientRect().top <= top) current = g.id;
    }
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) current = shown[shown.length - 1].id;
    setActive(current);
  };

  const rowsOf = (g: Group) =>
    g.keys.map((k) => data.rows.find((r) => r.key === k)).filter((r): r is SettingRow => !!r);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="设置分类">
        {shown.map((g) => (
          <button
            key={g.id}
            className={active === g.id ? 'on' : ''}
            aria-current={active === g.id ? 'true' : undefined}
            onClick={() => jump(g.id)}
          >
            <Icon name={g.icon} size={14} />
            <span>{g.title}</span>
          </button>
        ))}
        <p className="settings-file" title={data.file}>
          设置保存在
          <br />
          {data.file}
        </p>
      </nav>
      <div className="settings-body" ref={body} onScroll={onScroll}>
        <div className="settings-scope">
          {agentsError && (
            <p role="alert">
              工具列表读取失败：{agentsError}{' '}
              <button type="button" onClick={() => void loadAgents()}>
                重试读取工具
              </button>
            </p>
          )}
          <span>
            这里的设置对<strong>所有项目</strong>生效。
            {data.has_project && '只想让当前打开的这个项目不一样，点那一项下面的「只给这个项目换」。'}
          </span>
          {data.has_project && overrides.length > 0 && (
            <button
              className="link"
              onClick={() => {
                run('/api/settings/project', { key: '*', value: '' });
                setOpened(new Set());
              }}
            >
              这个项目全部改回和其他项目一样（{overrides.length} 项）
            </button>
          )}
        </div>
        {error && <div className="settings-error">{error}</div>}
        {shown.map((g) => (
          <section className="settings-section" key={g.id} data-group={g.id} aria-label={g.title}>
            <header className="settings-section-head">
              <span className="settings-section-icon">
                <Icon name={g.icon} size={16} />
              </span>
              <div>
                <h3>{g.title}</h3>
                {g.blurb && <p>{g.blurb}</p>}
              </div>
            </header>
            {g.keys.length > 0 && (
              <div className="settings-card">
                {rowsOf(g).map((row) => (
                  <SettingRowItem
                    key={row.key}
                    row={row}
                    data={data}
                    agents={agents}
                    agentsError={agentsError}
                    version={version}
                    opened={opened.has(row.key)}
                    saving={saving.has(row.key)}
                    onOpen={() => setOpened((prev) => new Set(prev).add(row.key))}
                    onClose={() =>
                      setOpened((prev) => {
                        const next = new Set(prev);
                        next.delete(row.key);
                        return next;
                      })
                    }
                    onSetGlobal={(r, value) => void setGlobal(r, value)}
                    run={run}
                  />
                ))}
              </div>
            )}
            {g.id === 'ai' && (
              <DirectorServices
                version={version}
                onChange={() => {
                  void reload();
                  onAgentsChanged?.();
                }}
              />
            )}
            {g.id === 'look' && <SkinPicker version={version} />}
            {g.id === 'network' && <UpdatePanel state={update} />}
            {g.id === 'network' && <MachineSettings rows={data.machine ?? []} onSaved={() => void reload()} />}
            {g.id === 'plugins' && (
              <PluginSettings
                version={version}
                onChanged={onPluginsChanged}
                run={project ? run : undefined}
                onOpenPage={project ? onOpenPage : undefined}
              />
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
