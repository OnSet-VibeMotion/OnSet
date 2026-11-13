import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * 过渡期的后端：在后台跑 Go 版 `am studio`，客户端把 /api 与 /preview 请求转给它。
 *
 * 引擎移植到 TypeScript 期间，客户端第一天就要能完整使用，所以先借 Go 版的全部接口；
 * TS 版每移植好一组接口，就在 main.ts 的路由里把它从「转发」换成「本地实现」。
 * 全部换完后删掉这个文件（计划第 6、7 阶段）。
 */
export interface GoBackend {
  origin: string;
  stop: () => void;
}

/** 找 am 可执行文件：AM_GO_BINARY 优先，其次 ~/.local/bin/am，再交给 PATH。 */
function amBinary(): string {
  const explicit = process.env.AM_GO_BINARY;
  if (explicit) return explicit;
  const local = path.join(os.homedir(), '.local/bin/am');
  return fs.existsSync(local) ? local : 'am';
}

/** 让系统分配一个空闲端口。Go 版只会照抄 --listen 的地址，不会报出实际端口，所以端口由这边先定。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('拿不到空闲端口'))));
    });
  });
}

async function waitHealthy(origin: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`am studio 启动后立即退出（退出码 ${child.exitCode}）`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // 还没起来，接着等。
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('等 am studio 启动超时');
}

export async function startGoBackend(env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<GoBackend> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(amBinary(), ['studio', '--listen', `127.0.0.1:${port}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 自成一个进程组：退出时连同它启动的编排工具一起结束，不留孤儿进程。
    detached: true,
  });
  child.stdout?.on('data', (chunk) => log(String(chunk)));
  child.stderr?.on('data', (chunk) => log(String(chunk)));
  const stop = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };
  try {
    await waitHealthy(origin, child, 20_000);
  } catch (err) {
    stop();
    throw err;
  }
  return { origin, stop };
}
