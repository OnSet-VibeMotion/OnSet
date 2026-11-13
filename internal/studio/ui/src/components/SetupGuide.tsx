import { useCallback, useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import type { SetupStatus } from '../types';
import '../setup.css';

/**
 * 前置资源引导。要联网的东西（HyperFrames 技能与 CLI、整片风格来源）只由用户在终端里
 * 运行 am setup 准备，Studio 不下载：这里列出缺哪几项、给出要复制的命令，跑完回来
 * 自动或手动重新检查。首页的引导卡片与顶栏的弹窗共用这一个组件。
 */

/** 读前置资源状态；有缺项时每 10 秒再看一次（用户可能正在终端里跑 am setup）。 */
export function useSetup(): { status: SetupStatus | null; recheck: () => Promise<void>; checking: boolean } {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api<SetupStatus>('/api/setup'));
    } catch {
      // 读不到就保持上一次的状态。
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void recheck();
  }, [recheck]);
  const missing = status?.items.some((item) => !item.ready) ?? false;
  useEffect(() => {
    if (!missing) return;
    const timer = window.setInterval(() => void recheck(), 10000);
    return () => window.clearInterval(timer);
  }, [missing, recheck]);
  return { status, recheck, checking };
}

/** 路径里的家目录换成 ~（只为显示短一些）。 */
function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

function CopyLine(props: { command: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 浏览器不让写剪贴板时，命令本身仍可手动选中复制。
    }
  };
  return (
    <div class="setup-command">
      <code>{props.command}</code>
      <button class="setup-copy" onClick={() => void copy()} title="复制命令">
        {copied ? '已复制' : '复制'}
      </button>
      {props.note && <span class="setup-command-note">{props.note}</span>}
    </div>
  );
}

export function SetupGuide(props: { status: SetupStatus; onRecheck: () => void; checking: boolean; compact?: boolean }) {
  const missing = props.status.items.filter((item) => !item.ready);
  const requiredMissing = missing.filter((item) => item.required);
  if (missing.length === 0) {
    return (
      <div class={'setup-guide ok' + (props.compact ? ' compact' : '')}>
        <p class="setup-title">前置资源都已就绪</p>
      </div>
    );
  }
  return (
    <div class={'setup-guide' + (requiredMissing.length ? ' blocking' : '') + (props.compact ? ' compact' : '')} id="setup-guide">
      <div class="setup-head">
        <p class="setup-title">{requiredMissing.length ? '开始之前，先准备前置资源' : '整片风格还没准备好'}</p>
        <p class="setup-lead">
          {requiredMissing.length
            ? '做片要用的 HyperFrames 技能与 CLI 需要先下载一次，之后所有项目共用、不再联网。Studio 不替你下载：在终端里运行下面的命令，可以看着进度、断了重跑接着下。'
            : '不影响做片，只是选不了这个来源的整片风格。需要时在终端里运行下面的命令。'}
        </p>
      </div>
      <ul class="setup-items">
        {props.status.items.map((item) => (
          <li key={item.id} class={item.ready ? 'ready' : 'missing'}>
            <span class="setup-icon" aria-hidden="true">
              {item.ready ? '✓' : '✗'}
            </span>
            <span class="setup-name">
              {item.name}
              {item.version && <span class="setup-version"> {item.version}</span>}
              {!item.required && <span class="setup-optional">可选</span>}
            </span>
            <span class="setup-location mono" title={item.location}>
              {item.ready ? shortPath(item.location) : '缺'}
            </span>
          </li>
        ))}
      </ul>
      <CopyLine command={props.status.command} note="在终端里运行" />
      <CopyLine command={`${props.status.command} --proxy http://127.0.0.1:7890`} note="GitHub 慢时让 git 走代理（换成你的代理端口）" />
      <div class="setup-actions">
        <button onClick={props.onRecheck} disabled={props.checking}>
          {props.checking ? '检查中…' : '已经跑完了，重新检查'}
        </button>
        <span class="setup-auto">每 10 秒会自动检查一次</span>
      </div>
    </div>
  );
}
