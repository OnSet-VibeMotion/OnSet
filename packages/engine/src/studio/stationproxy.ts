import { parseSource } from '../flow/fetch';

/** Chromium resolveProxy 的结果，转换成 Git/libcurl 认的代理地址；DIRECT 必须保留直连语义。 */
export function gitProxy(route: string): string {
  const first = route.split(';')[0].trim();
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5) ([^\t\n\f\r ]+)$/.exec(first);
  if (!match) return '';
  const schemes: Record<string, string> = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5h' };
  try {
    const proxy = new URL(`${schemes[match[1]]}://${match[2]}`);
    if (!proxy.hostname || !/:\d+$/.test(match[2]) || proxy.username || proxy.password || (proxy.pathname !== '' && proxy.pathname !== '/') || proxy.search || proxy.hash) return '';
    return `${schemes[match[1]]}://${match[2]}`;
  } catch {
    return '';
  }
}

/** 只给取回/更新插件的那一个执行进程用系统代理，不改全局环境，不让 npm 等其他下载一起改路。 */
export async function stationDownloadEnv(
  source: string,
  env: Record<string, string | undefined>,
  resolve?: (url: string) => Promise<string>,
): Promise<Record<string, string>> {
  if (!resolve || source === '' || Object.entries(env).some(([key, value]) => value && /^(https?|all)_proxy$/i.test(key))) return {};
  const parsed = parseSource(source);
  if (parsed.kind !== 'git' || !parsed.url.startsWith('https://')) return {};
  const proxy = gitProxy(await resolve(parsed.url));
  // Git 自己配置的 http.proxy 仍然优先于环境变量。
  return proxy === '' ? {} : { https_proxy: proxy };
}
