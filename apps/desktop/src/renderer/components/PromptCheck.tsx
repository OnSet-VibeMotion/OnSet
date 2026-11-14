import { useMemo, useState } from 'react';
import { api, errorText, post } from '../api';
import { lineDiff } from '../diff';
import type { Attachment, PromptCheck, PromptCheckDimension, StoryboardScene, Task } from '../types';
import { Icon } from './Icon';
import '../prompt-check.css';

/** 五个评估维度，顺序与后端 promptopt.Dimensions 相同。 */
const dimensions: [PromptCheckDimension, string, string][] = [
  ['intent', '文意对应', '画面是不是在讲这一镜的口播'],
  ['concreteness', '画面具体度', '主体、构图、关键动作、上屏文字写清了没有'],
  ['pacing', '时长匹配', '这么多动作在这一镜的秒数里做不做得完'],
  ['continuity', '交接与连贯', '开头结尾和前后镜头对不对得上'],
  ['ambiguity', '歧义控制', '会不会被理解成两种画面'],
];

const decisionText: Record<PromptCheck['decision'], string> = {
  skip: '不用改',
  minor: '建议小改',
  rewrite: '建议重写',
};

/** 等一个后台任务结束；失败时抛出它的原因。 */
async function waitTask(id: string): Promise<Task> {
  for (;;) {
    const task = await api<Task>('/api/tasks/' + encodeURIComponent(id));
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed' || task.status === 'cancelled') throw new Error(task.error || task.message);
    await new Promise((resolve) => window.setTimeout(resolve, 800));
  }
}

/** 发起检查（一个镜头或全部），等它跑完。 */
export async function runPromptCheck(target: { scene: string } | { all: true }): Promise<void> {
  const { task_id } = await post<{ task_id: string }>('/api/prompt-checks', target);
  await waitTask(task_id);
}

/** 分镜页顶上的「检查全部画面描述」：说清要调几次模型。 */
export function CheckAllButton({ scenes, onChanged }: { scenes: StoryboardScene[]; onChanged: () => void }) {
  const [state, setState] = useState<'' | 'working' | string>('');
  const count = scenes.filter((s) => s.prompt).length;
  if (count === 0) return null;
  return (
    <>
      <button
        id="prompt-check-all"
        disabled={state === 'working'}
        title={`逐个检查 ${count} 个镜头的画面描述：每个镜头调一次模型，结果显示在各自的卡片上，不会改动任何文件`}
        onClick={async () => {
          setState('working');
          try {
            await runPromptCheck({ all: true });
            setState('');
          } catch (err) {
            setState(errorText(err));
          }
          onChanged();
        }}
      >
        <Icon name="spark" size={12} />
        {state === 'working' ? `正在检查 ${count} 个镜头…` : '检查全部画面描述'}
      </button>
      {state !== '' && state !== 'working' && <p className="sb-note bad">{state}</p>}
    </>
  );
}

/**
 * 一个镜头的画面描述检查：没检查过时是一个按钮；检查过后列出评分、问题与改写稿的差异，
 * 「采用」写进 prompt.md（写任务），「让 AI 按这几条改」把问题填进输入框交给编排工具。
 */
export function PromptCheckPanel(props: {
  scene: StoryboardScene;
  label: string;
  busy: string;
  onChanged: () => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
}) {
  const { scene, label, busy, onChanged, onQuick } = props;
  const check = scene.prompt_check;
  const [working, setWorking] = useState<'' | 'check' | 'apply'>('');
  const [error, setError] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const diff = useMemo(() => (check?.prompt && scene.prompt ? lineDiff(scene.prompt.content, check.prompt) : []), [check?.prompt, scene.prompt]);

  if (!scene.prompt) return null;

  const act = async (kind: 'check' | 'apply' | 'dismiss') => {
    setError('');
    try {
      if (kind === 'dismiss') {
        await api('/api/prompt-checks/' + encodeURIComponent(scene.id), { method: 'DELETE' });
      } else {
        setWorking(kind);
        if (kind === 'check') await runPromptCheck({ scene: scene.dir });
        else {
          const { task_id } = await post<{ task_id: string }>(`/api/prompt-checks/${encodeURIComponent(scene.id)}/apply`);
          await waitTask(task_id);
        }
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking('');
      onChanged();
    }
  };

  if (!check || working === 'check') {
    return (
      <div className="pc-panel idle">
        <button className="link pc-start" data-check={scene.id} disabled={working !== ''} onClick={() => void act('check')} title="评估这份画面描述，需要的话给出改写稿；采用之前不改文件">
          <Icon name="spark" size={12} />
          {working === 'check' ? <span className="shimmer">正在检查画面描述…</span> : '检查画面描述'}
        </button>
        {error && <p className="pc-error">{error}</p>}
      </div>
    );
  }

  const ask = () => {
    const lines = check.issues.map((i, n) => `${n + 1}. ${i}`).join('\n');
    onQuick(`${label}的画面描述按这几条改，改完先让我看一眼再渲染：\n${lines}`, [{ ref: true, scene_id: scene.id }], true);
  };

  return (
    <div className="pc-panel" data-check-result={scene.id}>
      <header className="pc-head">
        <span className="pc-badge">
          <Icon name="spark" size={12} />
          画面描述检查
        </span>
        <strong className={'pc-decision ' + check.decision}>{decisionText[check.decision]}</strong>
        <span className="spacer" />
        <button className="link" disabled={working !== ''} onClick={() => void act('check')}>
          重新检查
        </button>
        <button className="icon-button" aria-label="收起检查结果" title="不用了" onClick={() => void act('dismiss')}>
          <Icon name="close" size={11} />
        </button>
      </header>
      {check.outdated && <p className="pc-warn">画面描述在检查之后改过了，下面的结果是对着旧稿说的，请重新检查。</p>}
      <ul className="pc-scores">
        {dimensions.map(([key, name, hint]) => {
          const value = check.scores[key];
          return (
            <li key={key} title={hint} className={value < 60 ? 'low' : value < 80 ? 'mid' : ''}>
              <span className="pc-score-name">{name}</span>
              <span className="pc-bar">
                <i style={{ width: `${value}%` }} />
              </span>
              <span className="pc-score-value">{value}</span>
            </li>
          );
        })}
      </ul>
      {check.issues.length > 0 && (
        <ol className="pc-issues">
          {check.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ol>
      )}
      {check.rejected && (
        <p className="pc-warn">
          改写稿没有采用：{check.rejected.join('；')}。可以让 AI 按上面几条在对话里改。
        </p>
      )}
      {check.prompt && !check.outdated && (
        <>
          <button className="link pc-diff-toggle" onClick={() => setShowDiff(!showDiff)} aria-expanded={showDiff}>
            {showDiff ? '收起改写稿' : '看改写稿'}
          </button>
          {showDiff && (
            <pre className="diff pc-diff" aria-label="改写稿与现稿的差异">
              {diff.map((line, index) => (
                <div key={index} className={line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}>
                  {line.kind} {line.text}
                </div>
              ))}
            </pre>
          )}
        </>
      )}
      <div className="pc-actions">
        {check.prompt && !check.outdated && (
          <button
            className="primary pill"
            data-apply={scene.id}
            disabled={working !== '' || !!busy}
            title={busy ? `项目正忙：${busy}` : '把改写稿写进这个镜头的 prompt.md'}
            onClick={() => void act('apply')}
          >
            {working === 'apply' ? '正在写入…' : '采用改写稿'}
          </button>
        )}
        {check.issues.length > 0 && (
          <button className="pill" onClick={ask} title="把这几条问题填进输入框，交给 AI 改（会连带改分镜或处理方案时用这个）">
            让 AI 按这几条改
          </button>
        )}
      </div>
      {check.prompt && !check.outdated && scene.rendered && <p className="pc-note">这个镜头已经渲染过，采用后要重新渲染。</p>}
      {error && <p className="pc-error">{error}</p>}
    </div>
  );
}
