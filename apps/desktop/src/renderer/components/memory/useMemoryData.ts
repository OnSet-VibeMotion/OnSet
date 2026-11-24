import { useEffect, useState } from 'react';
import { api, errorText } from '../../api';
import type { MemoryState, RecallResponse, Scene } from '../../types';

export function useMemoryData(scene: Scene | null, version: number) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setRefresh((n) => n + 1), 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let current = true;
    api<MemoryState>('/api/memory').then(
      (result) => {
        if (!current) return;
        setState(result);
        setError('');
      },
      (err) => {
        if (current) setError(errorText(err));
      },
    );
    return () => {
      current = false;
    };
  }, [version, refresh]);

  // 当前镜头渲染时会带上哪几条：页头的第三步与「会带上」一节共用。
  const [recallState, setRecallState] = useState<{
    scene: string;
    data: RecallResponse | null;
    stale: boolean;
  } | null>(null);

  useEffect(() => {
    if (!scene) return;
    let current = true;
    let timer: number | undefined;
    const id = scene.id;
    const update = async () => {
      try {
        const data = await api<RecallResponse>(`/api/memory/recall?scene=${encodeURIComponent(id)}`);
        if (current) setRecallState({ scene: id, data, stale: false });
      } catch {
        if (current)
          setRecallState((old) =>
            old?.scene === id ? { ...old, stale: true } : { scene: id, data: null, stale: true },
          );
      } finally {
        if (current) timer = window.setTimeout(() => void update(), 2000);
      }
    };
    void update();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [scene?.id, version]);

  const recall = scene && recallState?.scene === scene.id ? recallState.data : null;
  const recallFailed = Boolean(scene && recallState?.scene === scene.id && recallState.stale && !recallState.data);
  const recallStale = Boolean(recallState?.stale);
  const triggerRefresh = () => setRefresh((n) => n + 1);

  return { state, error, recall, recallFailed, recallStale, triggerRefresh };
}
