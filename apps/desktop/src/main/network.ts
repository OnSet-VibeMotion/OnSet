/**
 * 主进程替引擎联网：插件中心的目录与图片（flow.market.useHttpFetch）、客户端更新（updater.ts）。
 * 用 Chromium 的网络栈，缺省跟系统代理（含 PAC）走；设置页「网络」里填了代理（NETWORK_PROXY）时改用一个只在内存里的
 * 会话、把代理设在它上面，不动 defaultSession（界面、插件的网页照旧按系统代理）。
 */
import { session, type Session } from 'electron';
import * as config from '@onset/engine/config';
import { market } from '@onset/engine/flow';

let proxied: Session | null = null;
let applied = '';

/** 设置里写的代理换成 Chromium 的 proxyRules：它不认 socks5h，同义的写法是 socks5（由代理解析域名）。 */
export function proxyRules(proxy: string): string {
  return proxy.replace(/^socks5h:\/\//, 'socks5://').replace(/\/$/, '');
}

/** 现在联网该用的会话：每次现读设置，改了代理不用重启。 */
export async function networkSession(): Promise<Session> {
  const proxy = config.machineSetting(process.env, 'NETWORK_PROXY', config.parseConfFile);
  if (proxy === '') return session.defaultSession;
  proxied ??= session.fromPartition('onset-network');
  if (proxy !== applied) {
    await proxied.setProxy({ proxyRules: proxyRules(proxy) });
    applied = proxy;
  }
  return proxied;
}

export function installNetworkFetch(): void {
  market.useHttpFetch(async (url, { signal, maxBytes }) => {
    const s = await networkSession();
    const r = await s.fetch(url, { signal, redirect: 'follow' });
    return market.readHttpResponse(r, maxBytes);
  });
}
