import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { usageEmpty } from '../tools';
import { ExitError, KindDone, KindSession, KindUsage, TailBuffer, newSessionID, run, type Event } from './index';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-agentrun-'));
}

/** 写一个假的编排工具脚本，lookPath 无论要什么名字都返回它。 */
function fakeCLI(body: string): (name: string) => string {
  const file = path.join(tempDir(), 'fake');
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  return () => file;
}

function fixturePath(name: string): string {
  return path.join(import.meta.dirname, 'testdata', name + '.jsonl');
}

function collect(events: Event[]): (event: Event) => void {
  return (event) => events.push(event);
}

describe('agentrun run', () => {
  it('streams codex fixture', async () => {
    const workdir = tempDir();
    // 把 stdin 落盘，确认 codex 的 prompt 走 stdin。
    const script = `cat > "$PWD/stdin.txt"; cat '${fixturePath('codex-1')}'`;
    const events: Event[] = [];
    let raw = '';
    const { result, error } = await run(
      { tool: 'codex', workdir, prompt: '做一件事', lookPath: fakeCLI(script), raw: { write: (s: string) => (raw += s) } },
      collect(events),
    );
    expect(error).toBeNull();
    expect(fs.readFileSync(path.join(workdir, 'stdin.txt'), 'utf8')).toBe('做一件事');
    expect(result.sessionID).toBe('01a19706-15cc-7c23-92b3-d0008785ee57');
    expect(result.produced).toBe(true);
    expect(usageEmpty(result.usage)).toBe(false);
    // 结尾应是 usage + done。
    expect(events[events.length - 1].kind).toBe(KindDone);
    expect(events[events.length - 2].kind).toBe(KindUsage);
    // 原始流应逐行保留。
    expect(raw.split('\n').length - 1).toBe(7);
  });

  it('emits preset session first', async () => {
    const events: Event[] = [];
    const id = newSessionID('claude');
    const { result, error } = await run({ tool: 'claude', workdir: tempDir(), prompt: 'p', sessionID: id, lookPath: fakeCLI('exit 0') }, collect(events));
    expect(error).toBeNull();
    expect(events[0].kind).toBe(KindSession);
    expect(events[0].session_id).toBe(id);
    expect(result.sessionID).toBe(id);
    // 没有正文的运行不应算作有产出。
    expect(result.produced).toBe(false);
  });

  it('reports exit code and stderr', async () => {
    const events: Event[] = [];
    const { error } = await run(
      { tool: 'claude', workdir: tempDir(), prompt: 'p', sessionID: 'gone', resume: true, lookPath: fakeCLI("echo 'No conversation found' >&2; exit 3") },
      collect(events),
    );
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).code).toBe(3);
    expect(error!.message).toContain('No conversation found');
    // 失败时也要发 done。
    expect(events[events.length - 1].kind).toBe(KindDone);
  });

  it('cancel kills process group', async () => {
    const workdir = tempDir();
    // 子进程再拉起孙进程：取消后孙进程也必须被杀掉，不能继续写文件。
    const script = `(sleep 3; touch "$PWD/leaked") & echo '{"type":"thread.started","thread_id":"t"}'; wait`;
    const controller = new AbortController();
    const events: Event[] = [];
    const done = run({ tool: 'codex', workdir, prompt: 'p', lookPath: fakeCLI(script) }, collect(events), controller.signal);
    await sleep(300);
    controller.abort();
    const outcome = await Promise.race([done, sleep(5000).then(() => undefined)]);
    expect(outcome, '取消后没有退出').toBeDefined();
    expect(outcome!.error?.name).toBe('AbortError');
    await sleep(3500);
    // 孙进程要随进程组终止。
    expect(fs.existsSync(path.join(workdir, 'leaked'))).toBe(false);
  });

  it('rejects bad specs', async () => {
    const noop = () => {};
    // 未知工具。
    expect((await run({ tool: 'bad', prompt: '' }, noop)).error).not.toBeNull();
    // codex 不能预先指定会话。
    expect((await run({ tool: 'codex', prompt: 'p', sessionID: 'x' }, noop)).error).not.toBeNull();
    const missing = () => {
      throw new Error('nope');
    };
    const { error } = await run({ tool: 'codex', prompt: 'p', lookPath: missing }, noop);
    expect(error?.message).toContain('缺少必需工具');
  });

  it('new session id', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const tool of ['claude', 'qoder', 'codebuddy']) expect(newSessionID(tool), tool).toMatch(uuid);
    // codex / opencode 的 id 只能从流里读。
    expect(newSessionID('codex')).toBe('');
    expect(newSessionID('opencode')).toBe('');
    // id 应当随机。
    expect(newSessionID('claude')).not.toBe(newSessionID('claude'));
  });

  it('tail buffer keeps end', () => {
    const buffer = new TailBuffer(5);
    buffer.write(Buffer.from('abc'));
    buffer.write(Buffer.from('defgh'));
    expect(buffer.toString()).toBe('defgh');
  });
});
