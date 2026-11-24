import { useState } from 'react';
import { errorText, forUser, post } from '../../api';
import type { RenderCheckResult } from '../../types';

const browserWords: Record<RenderCheckResult['browser'], string> = {
  lent: '借用客户端自带的浏览器',
  own: '你自己指定的浏览器',
  downloaded: '另外下载的渲染用浏览器',
};

/**
 * 试渲染一个镜头：在临时目录里用 HyperFrames 渲染 1 秒的小画面，看这台电脑能不能出片（/api/setup/render-check）。
 * 走的是与真正渲染同一个入口；Windows 上借用客户端浏览器那条路只有真机验证得了，这个按钮就是给它用的。
 */
export function RenderCheck() {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [result, setResult] = useState<RenderCheckResult | null>(null);
  const [error, setError] = useState('');
  const start = async () => {
    setState('running');
    setError('');
    setResult(null);
    try {
      setResult(await post<RenderCheckResult>('/api/setup/render-check'));
    } catch (err) {
      setError(errorText(err));
    }
    setState('done');
  };
  return (
    <span className="render-check">
      <button className="setup-link" onClick={() => void start()} disabled={state === 'running'}>
        {state === 'running' ? '正在试渲染…' : state === 'done' ? '再试一次' : '试渲染一个镜头'}
      </button>
      {state === 'running' && <span className="render-check-note">在后台渲染一段 1 秒的小画面，十几秒就好。</span>}
      {error && <span className="render-check-fail">{forUser(error)}</span>}
      {result && (
        <span className={'render-check-result' + (result.ok ? ' ok' : ' fail')}>
          {result.frame && <img src={result.frame} alt="试渲染的画面" />}
          <span className="render-check-text">
            <strong>{result.ok ? `能出片，用了 ${result.seconds} 秒` : '没能出片'}</strong>
            <span>
              用的是{browserWords[result.browser]}
              {result.hooked ? '（Windows 的借用方式）' : ''}
            </span>
            {result.error && <span className="render-check-fail">{forUser(result.error)}</span>}
            {!result.ok && result.log_tail && result.log_tail.length > 0 && (
              <pre className="setup-log">{result.log_tail.join('\n')}</pre>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
