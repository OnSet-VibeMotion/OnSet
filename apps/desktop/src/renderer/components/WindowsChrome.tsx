import { Icon } from './Icon';
import '../window-chrome.css';

/** Windows 沿用 Mac 的单层顶栏，窗口动作仍由主进程执行。 */
export function WindowsWindowControls() {
  if (window.onset?.platform !== 'win32' || !window.onset.windowCommand) return null;
  const buttons = [
    ['close', '关闭窗口', <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />],
    ['minimize', '最小化', <path d="M3 6h6" />],
    ['maximize', '最大化或还原', <path d="M3 6h6M6 3v6" />],
  ] as const;
  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      {buttons.map(([command, label, glyph]) => (
        <button key={command} id={`window-${command}`} className={`window-${command}`} aria-label={label} title={label} onClick={() => window.onset?.windowCommand?.(command)}>
          <svg viewBox="0 0 12 12" aria-hidden="true">{glyph}</svg>
        </button>
      ))}
    </div>
  );
}

export function WindowsApplicationMenu() {
  if (window.onset?.platform !== 'win32' || !window.onset.showApplicationMenu) return null;
  return (
    <button className="ghost icon window-application-menu" id="window-app-menu" title="应用菜单：文件、编辑、视图、窗口" aria-label="应用菜单" aria-haspopup="menu" onClick={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      window.onset?.showApplicationMenu?.({ x: rect.left, y: rect.bottom + 6 });
    }}>
      <Icon name="more" size={16} />
    </button>
  );
}
