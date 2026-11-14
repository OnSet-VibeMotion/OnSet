import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandPrefix, listPermissionRequests, permissionToolResult, servePermissionMCP, writePermissionResponse } from './permissions';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onset-perm-'));
}

/** 一行一行喂给 MCP 服务的输入；close 之后迭代结束。 */
function lineFeed(): { lines: AsyncIterable<string>; push: (line: string) => void; close: () => void } {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push: (line) => {
      queue.push(line);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
    lines: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      },
    },
  };
}

describe('permissions', () => {
  // 「以后都允许」的前缀：第一个词，git、npm 这类带上子命令；带 shell 控制符的整条复合命令不给前缀。
  it('derives a safe command prefix', () => {
    expect(commandPrefix('brew --version'), 'brew 要带子命令，--version 不是').toBe('');
    expect(commandPrefix('magick -version')).toBe('magick');
    expect(commandPrefix('npm install three')).toBe('npm install');
    expect(commandPrefix('git push origin main')).toBe('git push');
    expect(commandPrefix('magick in.png out.webp')).toBe('magick');
    expect(commandPrefix('npm --version')).toBe('');
    expect(commandPrefix('ls | xargs rm')).toBe('');
    expect(commandPrefix('FOO=1 node x.js')).toBe('');
    expect(commandPrefix('./run.sh')).toBe('');
    expect(commandPrefix('cat "$HOME/.env"')).toBe('');
  });

  // claude 收到的结果：允许时原样带回 input，拒绝与过期时给一句它能照着改的话。
  it('translates answers for claude', () => {
    const input = { command: 'brew --version' };
    expect(JSON.parse(permissionToolResult({ input }, { decision: 'always' }))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(JSON.parse(permissionToolResult({ input }, { decision: 'deny', message: '别装东西' }))).toEqual({ behavior: 'deny', message: '别装东西' });
    expect(JSON.parse(permissionToolResult({ input }, { decision: 'deny' })).message).toContain('用户拒绝了');
    expect(JSON.parse(permissionToolResult({ input }, { decision: 'expired' })).message).toContain('这一轮已经结束');
  });

  // MCP 往返：initialize、tools/list、tools/call 写请求、等答复，答复写回后才回 claude；并行的两条互不阻塞。
  it('serves the approval tool over stdio', async () => {
    const inbox = tempDir();
    const feed = lineFeed();
    const out: Array<Record<string, any>> = [];
    const served = servePermissionMCP(feed.lines, (line) => out.push(JSON.parse(line)), inbox);
    feed.push(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    feed.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    feed.push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const call = (id: number, command: string) =>
      feed.push(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', input: { command, description: 'x' } } } }));
    call(3, 'brew --version');
    call(4, 'npm install three');
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(pred()).toBe(true);
    };
    await waitFor(() => listPermissionRequests(inbox).length === 2);
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(out[0].result.protocolVersion).toBe('2025-06-18');
    expect(out[1].result.tools[0].name).toBe('ask');
    const [brew, npm] = listPermissionRequests(inbox).map((x) => x.request);
    expect(brew).toMatchObject({ tool_name: 'Bash', command: 'brew --version' });
    expect(brew.suggestion, 'brew 后面不是子命令，拼不出前缀').toBeUndefined();
    expect(npm.suggestion).toBe('npm install');

    expect(writePermissionResponse(inbox, npm.id, { decision: 'deny', message: '不要装' })).toBe(true);
    expect(writePermissionResponse(inbox, npm.id, { decision: 'allow' }), '答过的不能再改').toBe(false);
    await waitFor(() => out.some((m) => m.id === 4));
    expect(out.some((m) => m.id === 3), '没答的那条还在等').toBe(false);
    writePermissionResponse(inbox, brew.id, { decision: 'allow' });
    await waitFor(() => out.some((m) => m.id === 3));
    feed.close();
    await served;
    const text = (id: number) => JSON.parse(out.find((m) => m.id === id)!.result.content[0].text);
    expect(text(3)).toEqual({ behavior: 'allow', updatedInput: { command: 'brew --version', description: 'x' } });
    expect(text(4)).toEqual({ behavior: 'deny', message: '不要装' });
  });

  // 不在客户端里（没有收件目录）却被调到：直接拒绝，不写任何文件。
  it('denies without an inbox', async () => {
    const feed = lineFeed();
    const out: Array<Record<string, any>> = [];
    const served = servePermissionMCP(feed.lines, (line) => out.push(JSON.parse(line)), '');
    feed.push(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'rm -rf x' } } } }));
    feed.close();
    await served;
    expect(JSON.parse(out[0].result.content[0].text).behavior).toBe('deny');
  });
});
