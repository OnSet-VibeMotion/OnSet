/** 本机操作转发。只传操作与输出，模型服务密钥仍由客户端经执行进程 stdin 交接。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const OpBrokerEnv = 'ONSET_STUDIO_OP_PIPE';
export const OpBrokerRelayedEnv = 'ONSET_STUDIO_OP_RELAYED';

export interface BrokerOperation {
  name: string;
  params: Record<string, unknown>;
  cwd: string;
  renderer: string;
  rendererModel: string;
  /** 渲染工具的调用选项（RENDERER_OPTIONS，见 tools/options.ts）。 */
  rendererOptions?: string;
  orchestrator: string;
}

/** 创建随机本机管道。连接结束即取消尚未完成的操作；关闭客户端时一并停止。 */
export function operationBroker(handle: (request: BrokerOperation, signal: AbortSignal, write: (text: string) => void) => Promise<number>): { address: string; close: () => void } {
  const id = 'onset-ops-' + crypto.randomUUID();
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\' + id : path.join(os.tmpdir(), 'onset-' + crypto.randomBytes(8).toString('hex') + '.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    sockets.add(socket);
    const controller = new AbortController();
    let buffer = '';
    let received = false;
    const send = (data: object) => { if (!socket.destroyed) socket.write(JSON.stringify(data) + '\n'); };
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); controller.abort(); });
    socket.on('data', chunk => {
      if (received) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      received = true;
      void (async () => {
        try {
          const raw = JSON.parse(buffer.slice(0, end)) as BrokerOperation;
          if (!raw || typeof raw.name !== 'string' || typeof raw.cwd !== 'string' || !raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) throw new Error('无效的本机操作请求');
          const code = await handle(raw, controller.signal, text => send({ text }));
          send({ code });
        } catch (error) {
          send({ error: (error as Error).message });
        } finally {
          socket.end();
        }
      })();
    });
  });
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  server.listen(address, () => { if (process.platform !== 'win32') fs.chmodSync(address, 0o600); });
  return { address, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

/** 外部编排工具的执行进程经本机管道交给客户端运行，不在 MCP 配置或文件里存密钥。 */
export function relayOperation(address: string, request: BrokerOperation, write: (text: string) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.setEncoding('utf8');
    let buffer = '';
    let finished = false;
    const abort = () => socket.destroy(new Error('操作已取消'));
    const finish = (error?: Error, code = 1) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(code);
    };
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line) as { text?: string; code?: number; error?: string };
          if (typeof reply.text === 'string') write(reply.text);
          if (typeof reply.code === 'number') finish(undefined, reply.code);
          if (reply.error) finish(new Error(reply.error));
        } catch (error) { finish(error as Error); }
      }
    });
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error('客户端操作连接已断开')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
