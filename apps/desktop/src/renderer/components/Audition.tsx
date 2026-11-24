import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import '../audition.css';
import type { Audition, AuditionRecommendation, Scene } from '../types';
import { Compose } from './audition/Compose';
import { when } from './audition/helpers';
import { Stage } from './audition/Stage';
import { Icon } from './Icon';
import { keyLabel } from './Learning';
import type { RunAction } from './Preview';

interface Props {
  scene: Scene | null;
  scenes: Scene[];
  version: number;
  busy: string;
  run: RunAction;
}

/**
 * 试镜页：同一个镜头交给几位选手（渲染工具 + 模型）各渲染一遍，并排同步播放，盲评之后才揭晓是谁，再决定采用哪一份。
 * 选手是谁由后端藏着（评判之前接口里就没有），这一页不需要自己守秘密。
 */
export function AuditionTab({ scene, scenes, version, busy, run }: Props) {
  const [list, setList] = useState<Audition[] | null>(null);
  const [current, setCurrent] = useState('');
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);

  const load = () => {
    if (!scene) return;
    void api<{ auditions: Audition[] | null }>(`/api/auditions?scene=${encodeURIComponent(scene.id)}`).then(
      (r) => {
        setList(r.auditions ?? []);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  };

  const [recommend, setRecommend] = useState<AuditionRecommendation[]>([]);
  useEffect(() => {
    setList(null);
    setCurrent('');
    setComposing(false);
    setRecommend([]);
    if (!scene) return;
    void api<{ recommendations: AuditionRecommendation[] | null }>(
      `/api/auditions/recommend?scene=${encodeURIComponent(scene.id)}`,
    ).then(
      (r) => setRecommend(r.recommendations ?? []),
      () => setRecommend([]),
    );
  }, [scene?.id]);
  useEffect(load, [scene?.id, version]);

  const running = (list ?? []).some((a) => a.contestants.some((c) => c.status !== 'done'));
  // 渲染中每 3 秒看一次进度；刚点开始、试镜记录还没写出来时也看（busy 是项目正忙的说明）。
  useEffect(() => {
    if (!running && !busy) return;
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [running, busy, scene?.id]);

  if (!scene) return <div className="empty">{scenes.length === 0 ? '还没有镜头。' : '先在镜头页选一个镜头。'}</div>;
  if (error) return <div className="empty">{error}</div>;
  if (!list) return <div className="empty">正在读取…</div>;

  const shown = list.find((a) => a.id === current) ?? list[0] ?? null;
  const index = scenes.findIndex((s) => s.id === scene.id);
  const label = `镜头 ${String(index + 1).padStart(2, '0')}`;

  return (
    <div className="audition">
      <header className="audition-head">
        <span className="eyebrow">试镜 · {label}</span>
        <h2>同一个镜头，谁拍得最好</h2>
        <p>所有已有画面同时比较，同步播放、暂停看细节。选完才揭晓是谁，选中的作品可以直接换进镜头。</p>
        {recommend.length > 0 && (
          <p className="audition-recommend">
            按你以往的评判，这类镜头
            {recommend.map((r, i) => (
              <span key={r.key}>
                {i > 0 ? '，其次' : ''} <strong>{keyLabel(r.key)}</strong> 赢了 {r.wins}/{r.appearances} 场
              </span>
            ))}
            。
          </p>
        )}
      </header>

      {(composing || !shown) && (
        <Compose
          busy={busy}
          onCancel={shown ? () => setComposing(false) : undefined}
          onStart={(picks, withMemory) => {
            run('/api/auditions', { scene_id: scene.id, contestants: picks, with_memory: withMemory });
            setComposing(false);
            window.setTimeout(load, 800);
          }}
        />
      )}

      {shown && !composing && (
        <>
          <div className="audition-bar">
            {list.length > 1 && (
              <select value={shown.id} aria-label="哪一场试镜" onChange={(e) => setCurrent(e.currentTarget.value)}>
                {list.map((a, i) => (
                  <option key={a.id} value={a.id}>
                    第 {list.length - i} 场 · {when(a.created_at)}
                  </option>
                ))}
              </select>
            )}
            <span className="audition-sub">
              {shown.contestants.length} 位选手 · {shown.with_memory ? '各自带上记忆' : '都不带记忆'}
            </span>
            <span className="spacer" />
            <button className="ghost" disabled={!!busy} onClick={() => setComposing(true)}>
              <Icon name="plus" size={11} /> 再开一场
            </button>
          </div>
          <Stage key={shown.id} audition={shown} version={version} busy={busy} run={run} onChange={load} />
        </>
      )}
    </div>
  );
}
