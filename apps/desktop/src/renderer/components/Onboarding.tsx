import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errorText, post } from '../api';
import type { AgentsResponse, SettingRow, SettingsResponse } from '../types';
import { AgentKeys, DirectorVisionNote } from './Settings';
import { rendererState } from './agentReady';
import { SetupGuide, type SetupHandle } from './SetupGuide';
import { Icon } from './Icon';
import '../onboarding.css';

/**
 * 首次使用引导：装好应用后第一次打开、还没有项目时自动出现，之后从首页左栏「新手引导」再打开。
 *
 * 四步，每一步做没做都看真实状态，不靠用户打勾：
 * 1. 摄制组就位：做片必需的工具装好了（/api/setup 的 ready，就是安装页）
 * 2. 请 AI 来编排：全局设置里的编排工具能用（装好了，或导演填了 key），并且全局设置里的渲染工具装在这台电脑上
 *    （镜头由 Claude Code、Codex 这类工具来画，导演只做编排；没装的话要到第一次渲染才报错）
 * 3. 配音方式：全局选过配音，或者说过「用默认的」（可跳过）
 * 4. 开拍：有了第一个项目
 * 全局设置写的是 /api/settings/global，与设置页同一份；key 写的是 /api/agent-keys。
 */

export const OnboardingDoneKey = 'onset.onboarding.done';
const ttsAckKey = 'onset.onboarding.tts';

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // 记不住只是下次还会出现。
  }
}

/** 引导该不该自动出现：没做完过、也还没有项目。 */
export function shouldOnboard(projectCount: number): boolean {
  return projectCount === 0 && !readFlag(OnboardingDoneKey);
}

interface Props {
  setup: SetupHandle;
  projectCount: number;
  /** 关掉引导回到首页（finished 为 true 表示走完了）。 */
  onClose: (finished: boolean) => void;
}

type StepID = 'crew' | 'ai' | 'voice' | 'shoot';

export function Onboarding(props: Props) {
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState('');
  const [ttsAck, setTtsAck] = useState(() => readFlag(ttsAckKey));

  const reload = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([api<AgentsResponse>('/api/agents'), api<SettingsResponse>('/api/settings')]);
      setAgents(a);
      setSettings(s);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const row = (key: string): SettingRow | undefined => settings?.rows.find((r) => r.key === key);
  const effective = (r: SettingRow | undefined) => (r ? r.effective || r.global || r.default : '');
  // 选中的是全局设置里的那一家（引导页写的就是它）；没设过时看实际在用的。
  const orchRow = row('ORCHESTRATOR');
  const orchestrator = orchRow ? orchRow.global || effective(orchRow) : '';
  const orchestratorInfo = agents?.agents.find((a) => a.id === orchestrator);
  const tts = row('TTS_PROVIDER');
  const rendererRow = row('RENDERER');
  const renderer = rendererRow ? rendererRow.global || effective(rendererRow) : '';
  const drawing = rendererState(agents, renderer);
  const [installKey, setInstallKey] = useState(0);

  const done: Record<StepID, boolean> = {
    crew: props.setup.status?.ready ?? false,
    ai: !!orchestratorInfo?.installed && !!agents && drawing.ok,
    voice: ttsAck || (tts?.global ?? '') !== '',
    shoot: props.projectCount > 0,
  };
  const order: StepID[] = ['crew', 'ai', 'voice', 'shoot'];
  const firstOpen = order.find((id) => !done[id]) ?? 'shoot';
  const [active, setActive] = useState<StepID | ''>('');
  const current: StepID = active || firstOpen;
  const doneCount = order.filter((id) => done[id]).length;

  const setGlobal = async (key: string, value: string) => {
    try {
      await post('/api/settings/global', { key, value });
      setError('');
      await reload();
      // 换了配音工具，安装页要装的那一项跟着变。
      if (key === 'TTS_PROVIDER') void props.setup.recheck();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const steps: { id: StepID; title: string; sub: string; body: ReactNode }[] = [
    {
      id: 'crew',
      title: '摄制组就位',
      sub: '把画面、剪辑、配音、字幕要用的工具装好',
      body: (
        <>
          <p className="ob-lead">做片要用到几样工具：画出镜头、把镜头剪成片、配音、对齐字幕。点一次安装就行，断了可以接着装。</p>
          <SetupGuide setup={props.setup} compact />
        </>
      ),
    },
    {
      id: 'ai',
      title: '请 AI 来编排',
      sub: '和你商量、写稿、定分镜、安排渲染的那一位',
      body: (
        <>
          <p className="ob-lead">选一位来编排整片。电脑上装过 Claude Code、Codex 这类工具就直接用；没装的话选「导演」，填一个模型服务的 API key 就能编排。镜头还要一家装在这台电脑上的工具来画，下面一并确认。</p>
          <div className="ob-agents" role="radiogroup" aria-label="编排工具">
            {agents?.agents.map((a) => {
              const chosen = a.id === orchestrator;
              const state = a.installed ? (chosen ? '在用' : '可用') : a.hint ? '要填 key' : '没装';
              return (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={chosen}
                  data-agent={a.id}
                  className={'ob-agent' + (chosen ? ' on' : '') + (a.installed ? '' : ' missing')}
                  // 导演还没填 key 也能选：选了下面就出现填 key 的地方。
                  disabled={!a.installed && !a.hint}
                  onClick={() => void setGlobal('ORCHESTRATOR', a.id)}
                >
                  <strong>{a.label}</strong>
                  <span>{a.id === 'director' ? '自带，不用另装' : a.installed ? '已经装在这台电脑上' : `没有找到 ${a.command}`}</span>
                  <em>{state}</em>
                </button>
              );
            })}
          </div>
          {orchestrator === 'director' && (
            <div className="ob-keys settings">
              <AgentKeys version={0} onChange={() => {
                setInstallKey((k) => k + 1);
                void reload();
              }} />
              <DirectorVisionNote model={row('ORCHESTRATOR_MODEL')?.global ?? ''} version={installKey} />
            </div>
          )}
          {orchestrator !== '' && agents && (
            <section className="ob-renderer" aria-label="画镜头的工具" id="ob-renderer">
              <h3>
                <span className={'ob-renderer-icon' + (drawing.ok ? ' ok' : '')}>
                  <Icon name="brush" size={14} />
                </span>
                谁来画镜头
              </h3>
              {drawing.ok ? (
                <p className="ob-lead">
                  每个镜头交给 <strong>{drawing.info?.label ?? renderer}</strong> 来画{orchestrator === 'director' ? '：导演只管编排，画面要靠它' : ''}。想换一家，点下面已经装好的。
                </p>
              ) : (
                <p className="ob-renderer-alert" role="alert">
                  <Icon name="alert" size={13} />
                  {drawing.installed.length > 0 ? drawing.reason + '。' : '画面要靠 Claude Code、Codex 这类工具来画，这台电脑上还需要装一个。装好后点「装好了，再查一次」。'}
                </p>
              )}
              {drawing.installed.length > 0 ? (
                <div className="ob-agents" role="radiogroup" aria-label="渲染工具">
                  {drawing.installed.map((a) => {
                    const chosen = a.id === renderer;
                    return (
                      <button key={a.id} role="radio" aria-checked={chosen} data-renderer={a.id} className={'ob-agent' + (chosen ? ' on' : '')} onClick={() => void setGlobal('RENDERER', a.id)}>
                        <strong>{a.label}</strong>
                        <span>已经装在这台电脑上</span>
                        <em>{chosen ? '在用' : '用它来画'}</em>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <>
                  <div className="ob-agents">
                    {agents.agents
                      .filter((a) => a.renderer && a.install_url)
                      .map((a) => (
                        <a key={a.id} className="ob-agent ob-install" data-install={a.id} href={a.install_url} target="_blank" rel="noreferrer">
                          <strong>{a.label}</strong>
                          <span>照官方说明装好，再回到这里</span>
                          <em>去安装 ↗</em>
                        </a>
                      ))}
                  </div>
                  <button className="link ob-skip" onClick={() => void reload()}>
                    装好了，再查一次
                  </button>
                </>
              )}
            </section>
          )}
        </>
      ),
    },
    {
      id: 'voice',
      title: '配音方式',
      sub: '口播用谁的声音来念，可以以后再改',
      body: (
        <>
          <p className="ob-lead">选口播稿用什么来配音。先用免费的预览也行，正式出片前在设置里随时换；想用自己的声音，建好项目后在「音色」页录一段。</p>
          {tts && (
            <div className="ob-options" role="radiogroup" aria-label="配音">
              {tts.options.map((o) => (
                <button key={o.value} role="radio" aria-checked={effective(tts) === o.value} className={'ob-option' + (effective(tts) === o.value ? ' on' : '')} onClick={() => void setGlobal('TTS_PROVIDER', o.value)}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {!done.voice && (
            <button
              className="link ob-skip"
              onClick={() => {
                writeFlag(ttsAckKey);
                setTtsAck(true);
                setActive('');
              }}
            >
              先用默认的，以后再说
            </button>
          )}
        </>
      ),
    },
    {
      id: 'shoot',
      title: '开拍',
      sub: '说一句想做什么，或者把文章拖进来',
      body: (
        <>
          <p className="ob-lead">回到首页，在大输入框里说说想做什么视频，或者直接把文章拖进去，按回车。AI 会建好项目、开始制作；每到要你拍板的地方（稿子、配音、分镜、成片）都会停下来，对话顶上会告诉你接下来该做什么。</p>
          <button
            className="primary ob-go"
            disabled={!done.crew || !done.ai}
            title={!done.crew || !done.ai ? '先把前两步做完' : ''}
            onClick={() => {
              writeFlag(OnboardingDoneKey);
              props.onClose(true);
            }}
          >
            去开拍
          </button>
        </>
      ),
    },
  ];
  const step = steps.find((s) => s.id === current)!;
  const index = order.indexOf(current);

  return (
    <div className="onboarding" id="onboarding">
      <aside className="ob-rail">
        <p className="ob-kicker">开拍前</p>
        <h1>四步准备好</h1>
        <p className="ob-count">
          已完成 {doneCount} / {order.length}
        </p>
        <ol>
          {steps.map((s, i) => (
            <li key={s.id}>
              <button className={'ob-step' + (s.id === current ? ' on' : '') + (done[s.id] ? ' done' : '')} data-step={s.id} onClick={() => setActive(s.id)}>
                <span className="ob-num">{done[s.id] ? <Icon name="check" size={11} /> : i + 1}</span>
                <span className="ob-step-text">
                  <strong>{s.title}</strong>
                  <span>{s.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <button
          className="link ob-later"
          onClick={() => {
            writeFlag(OnboardingDoneKey);
            props.onClose(false);
          }}
        >
          跳过，直接去首页
        </button>
      </aside>
      <main className="ob-main">
        <header>
          <span className="ob-index">第 {index + 1} 步</span>
          <h2>{step.title}</h2>
          {done[current] && <span className="ob-done">已完成</span>}
        </header>
        <div className="ob-body">{step.body}</div>
        {error && <p className="ob-error">{error}</p>}
        <footer>
          {index > 0 && (
            <button onClick={() => setActive(order[index - 1]!)}>
              <Icon name="prev" size={12} />
              上一步
            </button>
          )}
          <span className="spacer" />
          {index < order.length - 1 && (
            <button className={done[current] ? 'primary' : ''} onClick={() => setActive(order[index + 1]!)}>
              {done[current] ? '下一步' : '先跳过这一步'}
              <Icon name="next" size={12} />
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}
