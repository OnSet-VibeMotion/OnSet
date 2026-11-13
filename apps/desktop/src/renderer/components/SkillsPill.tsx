import { forUser } from '../api';
/** HyperFrames 官方技能的安装状态：没装时给「安装」，安装中显示进度条，失败给原因和重试。 */
export interface SkillsStatus {
  installed: boolean;
  installing: boolean;
  error?: string;
  progress?: { stage: string; percent: number; indeterminate?: boolean };
}

export function SkillsPill({ status, onInstall }: { status: SkillsStatus; onInstall: () => void }) {
  if (status.installing) {
    const progress = status.progress ?? { stage: '准备', percent: 0 };
    const percent = Math.round(progress.percent);
    return (
      <div
        className="skills-progress"
        id="install-skills"
        role="progressbar"
        aria-label="安装 HyperFrames 技能"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.indeterminate ? undefined : percent}
        title="正在把固定版本的 HyperFrames 官方技能装进这个项目"
      >
        <span className="skills-progress-text">
          安装 HyperFrames 技能 · {progress.stage}
          {!progress.indeterminate && <span className="mono"> {percent}%</span>}
        </span>
        <span className={'skills-track' + (progress.indeterminate ? ' indeterminate' : '')}>
          <span className="skills-fill" style={{ width: `${Math.max(percent, 2)}%` }} />
        </span>
      </div>
    );
  }
  return (
    <button
      className={'skills-pill' + (status.error ? ' bad' : '')}
      id="install-skills"
      onClick={onInstall}
      title={(status.error && forUser(status.error)) || '渲染要用 HyperFrames 官方技能（hyperframes 入口技能等），这个项目还没装'}
    >
      {status.error ? '技能安装失败，点此重试' : '缺少 HyperFrames 技能 · 安装'}
    </button>
  );
}
