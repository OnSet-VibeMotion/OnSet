/**
 * 在 Finder 中显示：经 preload 的 `onset.reveal` 交给主进程，主进程只认项目里的路径（后端 `revealPath`）。
 * 浏览器里没有这个接口，`canReveal` 为 false，入口都不显示。
 */

let onError: (message: string) => void = () => {};

/** app 注册怎么显示失败（顶栏的提示条）。 */
export function setRevealErrorHandler(handler: (message: string) => void): void {
  onError = handler;
}

export const canReveal = typeof window !== 'undefined' && typeof window.onset?.reveal === 'function';

/** path：项目内的相对路径或绝对路径，空是项目文件夹；project：项目 id，空是当前项目。 */
export function revealInFinder(path: string, project?: string): void {
  const reveal = window.onset?.reveal;
  if (!reveal) return;
  reveal(path, project).then(
    (error) => {
      if (error) onError('没能在 Finder 中显示：' + error);
    },
    (err: unknown) => onError('没能在 Finder 中显示：' + (err instanceof Error ? err.message : String(err))),
  );
}

/** 菜单里统一的叫法。 */
export const revealLabel = '在 Finder 中显示';
