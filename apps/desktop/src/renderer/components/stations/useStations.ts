import { useEffect, useState } from 'react';
import { api, errorText, post } from '../../api';
import type { StationsResponse, Task } from '../../types';
import { setStationPages } from './registry';

export function useStations(version: number): [StationsResponse | null, string, () => void] {
  const [data, setData] = useState<StationsResponse | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    void api<StationsResponse>('/api/stations').then(
      (value) => {
        setData(value);
        setError('');
        // 设置改过、站加减过：全局的插件表（顶栏、嵌入位、斜杠命令）跟着换，不等下一次读项目。
        setStationPages(value.stations);
      },
      (err) => setError(errorText(err)),
    );
  }, [version, nonce]);
  return [data, error, () => setNonce((n) => n + 1)];
}

/**
 * 装、去掉、更新插件：起一个后台任务（不要打开项目），在这里等它跑完、报结果。
 * 跑完后重读插件列表，onChanged 让外面（顶栏的插件页面、首页的做法）跟着换。
 */
export type StartTask = (
  path: string,
  label: string,
  payload?: Record<string, unknown>,
  onResult?: (result: unknown) => void,
) => void;

export function usePluginTask(onDone: () => void): { busy: string; message: string; start: StartTask } {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const start: StartTask = (path, label, payload = {}, onResult) => {
    setBusy(label);
    setMessage('');
    void (async () => {
      try {
        const { task_id } = await post<{ task_id: string }>(path, payload);
        for (;;) {
          await new Promise((r) => window.setTimeout(r, 500));
          const t = await api<Task>(`/api/tasks/${encodeURIComponent(task_id)}`);
          if (t.status === 'succeeded') {
            // 取回给你看的任务没有「好了」可说：结果交给 onResult（弹出确认）。
            if (onResult) onResult(t.result);
            else setMessage(`${label}：好了`);
            break;
          }
          if (t.status === 'failed' || t.status === 'cancelled') {
            setMessage(`${label}没有成功：${t.error || t.message}`);
            break;
          }
        }
      } catch (err) {
        setMessage(`${label}没有成功：${errorText(err)}`);
      }
      setBusy('');
      onDone();
    })();
  };
  return { busy, message, start };
}
