import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { api, errorText, post } from '../api';
import type { SettingRow, SettingsResponse } from '../types';
import { DirectorServices, DirectorVisionNote } from './DirectorServices';
import { SkinPicker } from './Skins';
import { ModelSelect } from './ModelSelect';
import type { RunAction } from './Preview';
import '../settings.css';
import { PluginSettings } from './Stations';

/**
 * 设置页：左边按用途分块导航（AI 助手、画面渲染、配音与字幕、外观、功能与插件），右边一块一块往下排，滚到哪块左边亮哪块。
 * 每一项「什么用什么」都有一个全局值，所有项目默认跟着它；某个项目要不一样，在「这个项目」一栏单独设，
 * 也能一键改回跟随全局。全局值在进程里直接写（用户级文件），项目的值写进项目配置，走写任务。
 */

const sourceNote: Record<SettingRow['source'], string> = {
  env: '这一项被电脑上的环境变量定死了，这里改了不生效',
  dotenv: '这一项被这个项目的 .env 文件定死了，这里改了不生效',
  project: '',
  global: '',
  default: '',
};

/** 设置分几块，左边导航、右边按块排；每块一个图标、一个名字、一句话说清它管什么。 */
interface Group {
  id: string;
  title: string;
  icon: IconName;
  blurb: string;
  keys: string[];
}

const groups: Group[] = [
  { id: 'ai', title: 'AI 助手', icon: 'brain', blurb: '和你对话、写稿、定分镜、安排渲染的那位，以及它能不能不问你直接跑命令。', keys: ['ORCHESTRATOR', 'ORCHESTRATOR_MODEL', 'AUTO_APPROVE'] },
  { id: 'render', title: '画面渲染', icon: 'film', blurb: '把每个镜头画出来的工具、一次画几个，以及要不要记住画过的问题。', keys: ['RENDERER', 'RENDERER_MODEL', 'SCENE_JOBS', 'MEMORY'] },
  { id: 'voice', title: '配音与字幕', icon: 'mic', blurb: '口播稿用谁来读，字幕怎样和声音逐字对上。', keys: ['TTS_PROVIDER', 'ALIGN_PROVIDER'] },
  { id: 'look', title: '外观', icon: 'brush', blurb: '整个客户端与桌宠的配色。', keys: [] },
  { id: 'plugins', title: '功能与插件', icon: 'plug', blurb: '片场自带的功能，和你自己装的插件。', keys: [] },
];

export function Settings({ version, run, onPluginsChanged }: { version: number; run: RunAction; onPluginsChanged?: () => void }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(groups[0].id);
  // 哪几项点了「只给这个项目换」：没单独改过的项默认只露一个下拉框。
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const body = useRef<HTMLDivElement>(null);

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

  const rowsOf = (g: Group) => g.keys.map((k) => data.rows.find((r) => r.key === k)).filter((r): r is SettingRow => !!r);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="设置分类">
        {shown.map((g) => (
          <button key={g.id} className={active === g.id ? 'on' : ''} aria-current={active === g.id ? 'true' : undefined} onClick={() => jump(g.id)}>
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
            {g.keys.length > 0 && <div className="settings-card">{rowsOf(g).map(renderRow)}</div>}
            {g.id === 'ai' && <DirectorServices version={version} onChange={() => void reload()} />}
            {g.id === 'look' && <SkinPicker version={version} />}
            {g.id === 'plugins' && <PluginSettings version={version} onChanged={onPluginsChanged} />}
          </section>
        ))}
      </div>
    </div>
  );

  function renderRow(row: SettingRow) {
    const note = sourceNote[row.source];
    const hasProject = data!.has_project;
    const own = row.project !== '';
    const showProject = hasProject && (own || opened.has(row.key));
    const close = () =>
      setOpened((prev) => {
        const next = new Set(prev);
        next.delete(row.key);
        return next;
      });
    return (
      <div className={'settings-row' + (row.model_of ? ' sub' : '')} key={row.key} data-key={row.key}>
        <div className="settings-label">
          <strong>{row.label}</strong>
          <span>{row.hint}</span>
          {note && <em>{note}</em>}
          {row.model_of && globalTool(row) === 'director' && <DirectorVisionNote model={row.global} version={version} compact />}
        </div>
        <div className="settings-controls">
          {row.model_of ? globalModel(row) : globalTool_(row)}
          {hasProject && !showProject && (
            <button className="link settings-own" onClick={() => setOpened((prev) => new Set(prev).add(row.key))}>
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
                    close();
                  }}
                >
                  {own ? '改回和其他项目一样' : '算了'}
                </button>
              </span>
              {row.model_of ? projectModel(row) : projectTool_(row)}
            </div>
          )}
        </div>
      </div>
    );
  }

  function globalModel(row: SettingRow) {
    return (
      <ModelSelect
        ariaLabel={`全局${row.label}`}
        tool={globalTool(row)}
        value={row.global}
        defaultLabel="默认（由工具自己决定）"
        onChange={(value) => void setGlobal(row, value)}
      />
    );
  }

  function projectModel(row: SettingRow) {
    const inherited = projectTool(row) === globalTool(row) ? row.global : '';
    return (
      <ModelSelect
        ariaLabel={`这个项目的${row.label}`}
        className={row.project !== '' ? 'overridden' : ''}
        tool={projectTool(row)}
        value={row.project}
        defaultLabel={`和其他项目一样（${inherited || '默认'}）`}
        onChange={(value) => run('/api/settings/project', { key: row.key, value })}
      />
    );
  }

  // 「默认」那一项已经写明是谁，下面就不再重复列出同一个选项，免得出现「默认（Codex）」和「Codex」两个。
  function globalTool_(row: SettingRow) {
    const value = row.global === row.default ? '' : row.global;
    return (
      <select aria-label={`全局${row.label}`} value={value} onChange={(e) => void setGlobal(row, e.target.value)}>
        <option value="">{label(row, row.default)}（默认）</option>
        {row.options
          .filter((o) => o.value !== row.default)
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </select>
    );
  }

  function projectTool_(row: SettingRow) {
    const globalValue = row.global || row.default;
    return (
      <select
        aria-label={`这个项目的${row.label}`}
        className={row.project !== '' ? 'overridden' : ''}
        value={row.project}
        onChange={(e) => run('/api/settings/project', { key: row.key, value: e.target.value })}
      >
        <option value="">和其他项目一样（{label(row, globalValue)}）</option>
        {row.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
}
