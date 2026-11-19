/*
 * 开发时（`npm run desktop`）给 agent-browser 这类调试工具开一个 CDP 端口，连上就能看、能点片场的界面与插件网页：
 *
 *   agent-browser --cdp 9333 tab list
 *
 * 只在没打包的开发版里开：打包给用户的客户端不开（插件网页里是用户登录着的账号，本机任何程序连上端口都能操作它们）；
 * e2e 的后台运行也不开（Playwright 自己连，固定端口还会在并行的用例之间打架）。Chromium 的调试端口只听 127.0.0.1。
 * 默认 9333 而不是 9222：9222 常被开着远程调试的 Chrome 占着。ONSET_DESKTOP_DEBUG_PORT 换端口，填 off 关掉。
 */
export const DefaultDebugPort = 9333;

export function debugPort(options: { packaged: boolean; background: boolean; env: Record<string, string | undefined> }): number | null {
  if (options.packaged || options.background) return null;
  const raw = options.env.ONSET_DESKTOP_DEBUG_PORT?.trim() ?? '';
  if (raw === '') return DefaultDebugPort;
  if (/^(0|off|false|no)$/i.test(raw)) return null;
  const port = Number(raw);
  // Electron 只接受小于 65535 的调试端口：填 65535 会静默换成随机端口，日志里的端口连不上。
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error(`ONSET_DESKTOP_DEBUG_PORT 要是 1024–65534 的端口号，或 off：${raw}`);
  return port;
}
