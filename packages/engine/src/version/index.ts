/**
 * onset 的版本号。不依赖任何功能包，谁都能引用（scene 的渲染指纹、flow 的插件兼容检查）。
 *
 * - 工具版本（toolVersion）：由 onset 在启动时设为 cli 的版本号，写进渲染记录供追溯。
 *   复用按实际提示词、技能、输入文件和渲染契约判断。
 * - 宿主版本（hostVersion）：只给兼容检查（插件清单的 requires.onset）用。客户端主进程用 app.getVersion() 设它；
 *   客户端**不**设工具版本，否则进程内算的渲染指纹会变。
 */

let toolVersion = 'dev';
let hostVersion = '';

export function setToolVersion(version: string): void {
  toolVersion = version;
}

export function getToolVersion(): string {
  return toolVersion;
}

/** 设宿主（客户端）的版本号，只用于兼容检查，不进渲染指纹。空串表示没有宿主。 */
export function setHostVersion(version: string): void {
  hostVersion = version;
}

/** 宿主的版本号；没设为空。 */
export function getHostVersion(): string {
  return hostVersion;
}

/** 兼容检查用的 onset 版本：有宿主版本用它，否则用工具版本。 */
export function compatVersion(): string {
  return hostVersion !== '' ? hostVersion : toolVersion;
}
