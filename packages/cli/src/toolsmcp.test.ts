import { spawn } from 'node:child_process';
import { ResultMarker } from '@onset/engine/opworker';
import { groupSpawnOptions } from '@onset/engine/procgroup';
import { describe, expect, it } from 'vitest';
import { allOps, opScopes } from './ops/op';
import fs from 'node:fs';
import { Jobs, describeTools, opCommand, prepareCall, serveToolsMCP, type Spawner } from './toolsmcp';

/** 把一串 JSON-RPC 请求喂给服务，收齐回复（按 id）。 */
async function call(requests: Record<string, unknown>[], spawner: Spawner, profile: 'orchestrator' | 'renderer' = 'orchestrator'): Promise<Map<unknown, any>> {
  const out = new Map<unknown, any>();
  async function* lines() {
    for (const r of requests) yield JSON.stringify({ jsonrpc: '2.0', ...r });
  }
  await serveToolsMCP(lines(), (line) => {
    const msg = JSON.parse(line);
    out.set(msg.id, msg);
  }, profile, spawner);
  return out;
}

/** 假的执行进程：sh 脚本里能拿到操作名（$1）与参数 JSON（$2），最后按协议写结果行。 */
function fakeWorker(script: string, result: Record<string, unknown> = { ok: true, exit_code: 0 }, windowsScript = ''): Spawner {
  if (process.platform === 'win32') {
    const code = `(async () => {${windowsScript};process.stdout.write(${JSON.stringify(ResultMarker + JSON.stringify(result) + '\n')});})()`;
    return (name, params) => spawn(process.execPath, ['-e', code, name, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'pipe'], ...groupSpawnOptions() });
  }
  const marker = ResultMarker.replace('\u0000', '\\0');
  const tail = `printf '${marker}%s\\n' '${JSON.stringify(result)}'`;
  return (name, params) => spawn('/bin/sh', ['-c', `${script}\n${tail}`, 'onset', name, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
}

const text = (msg: any): string => msg.result.content[0].text;

describe('onset tools MCP', () => {
  it('makes one tool per operation, with named parameters', () => {
    const tools = describeTools('orchestrator');
    const names = tools.map((t) => t.name);
    for (const want of ['scene_run', 'scene_run_all', 'beat_import', 'beat_cues', 'film_style_use', 'memory_remember', 'studio_show', 'hyperframes', 'job_wait', 'tool_help']) expect(names).toContain(want);
    // 建项目、准备前置资源、两个 MCP 服务是客户端自己的入口，不是工具。
    for (const absent of ['setup', 'init', 'run', 'studio_permission_mcp', 'studio_tools_mcp']) expect(names).not.toContain(absent);
    const importTool = tools.find((t) => t.name === 'beat_import')!;
    expect(importTool.inputSchema.required).toEqual(['music']);
    expect(Object.keys(importTool.inputSchema.properties!)).toEqual(expect.arrayContaining(['music', 'replace', 'project_root', 'wait_seconds']));
    expect(importTool.inputSchema.properties).not.toHaveProperty('args');
  });

  it('gives the Windows renderer its required source check, retaining the other platform tool lists', () => {
    expect(describeTools('renderer').map((t) => t.name)).toEqual(['hyperframes', ...(process.platform==='win32'?['scene_lint']:[]), 'job_wait', 'job_cancel', 'tool_help']);
  });

  // 说明与例子是 agent 照着调的：写成命令行它就会去终端里找 onset；例子里的参数名必须真的存在。
  it('writes every description and example as tool calls', () => {
    for (const op of allOps()) {
      if (!opScopes(op).includes('orchestrator') && !opScopes(op).includes('renderer')) continue;
      expect(op.summary, op.name).not.toBe('');
      const prose = [op.summary, op.description ?? '', ...(op.examples ?? []), ...Object.values(op.params).map((p) => p.description)].join('\n');
      expect(prose, `${op.name} 的说明里写了命令行`).not.toMatch(/(^|[^\w/.\-`])onset (setup|init|run|scene|beat|align|song|cast|dialogue|validate|memory|film-style|concat|review|audio|config|studio|style|usage|archive|hyperframes)\b/m);
      for (const example of op.examples ?? []) {
        if (example.trim().startsWith('#') || example.trim() === '') continue;
        const m = /^([a-z_]+)\((.*)\)(\s+#.*)?$/.exec(example.trim());
        expect(m, `${op.name} 的例子不是工具调用：${example}`).not.toBeNull();
        expect(m![1], `${op.name} 的例子调的是别的工具：${example}`).toBe(op.name);
        if (m![2] === '') continue;
        const params = JSON.parse(m![2]) as Record<string, unknown>;
        for (const key of Object.keys(params)) expect(op.params, `${op.name} 的例子用了不存在的参数 ${key}`).toHaveProperty(key);
      }
    }
  });

  it('checks parameters before starting anything', () => {
    const tools = describeTools('orchestrator');
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    expect(() => prepareCall(tool('beat_import'), {})).toThrow(/缺少参数 music/);
    expect(() => prepareCall(tool('beat_import'), { music: 'a.mp3', bogus: 1 })).toThrow(/没有参数 bogus/);
    expect(() => prepareCall(tool('beat_regrid'), { meter: 'four' })).toThrow(/要是整数/);
    expect(prepareCall(tool('beat_regrid'), { meter: 3 })).toMatchObject({ meter: 3, anchor: 0 });
  });

  it('only lets local, read-only or rendering HyperFrames commands through', () => {
    const hf = describeTools('renderer').find((t) => t.name === 'hyperframes')!;
    expect(prepareCall(hf, { subcommand: 'check', args: ['--json'] })).toMatchObject({ subcommand: 'check', args: ['--json'] });
    // snapshot 不把画面发给外部视觉服务。
    expect(prepareCall(hf, { subcommand: 'snapshot', args: ['--at', '1.5'] }).args).toEqual(['--at', '1.5', '--describe', 'false']);
    for (const sub of ['cloud', 'publish', 'skills', 'upgrade', 'preview']) expect(() => prepareCall(hf, { subcommand: sub })).toThrow(/不放行/);
    expect(() => prepareCall(hf, { subcommand: 'timeline', args: ['move'] })).toThrow(/--json/);
    expect(prepareCall(hf, { subcommand: 'timeline', args: ['--json'] }).args).toEqual(['--json']);
  });

  it('keeps direct rendering out of the orchestrator while retaining inspection and dispatch', async () => {
    const tools = describeTools('orchestrator');
    const hf = tools.find((t) => t.name === 'hyperframes')!;
    expect(hf.inputSchema.properties!.subcommand.enum).not.toContain('render');
    expect(hf.help).not.toContain('hyperframes({"subcommand": "render"})');
    expect(hf.help).toContain('scene_run');
    expect(prepareCall(hf, { subcommand: 'snapshot', args: ['scenes/scene-002', '--at', '1.5'] }).args).toContain('--describe');
    const spawned: string[] = [];
    const replies = await call([
      { id: 1, method: 'tools/call', params: { name: 'hyperframes', arguments: { subcommand: 'render', args: ['scenes/scene-002'] } } },
    ], (name, params) => { spawned.push(name); return fakeWorker('')(name, params); });
    expect(replies.get(1).result.isError).toBe(true);
    expect(text(replies.get(1))).toContain('scene_run');
    expect(spawned).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['scene_run', 'scene_run_all']));
    const renderer = describeTools('renderer').find((t) => t.name === 'hyperframes')!;
    expect(prepareCall(renderer, { subcommand: 'render' })).toMatchObject({ subcommand: 'render' });
  });

  it('runs an operation and returns its text and structured result', async () => {
    const replies = await call(
      [{ id: 1, method: 'tools/call', params: { name: 'beat_bars', arguments: {} } }],
      fakeWorker('echo "op=$1 params=$2"; echo "共 8 小节"', { ok: true, data: { bars: 8 }, exit_code: 0 }, 'console.log("op="+process.argv[1]+" params="+process.argv[2]);console.log("共 8 小节")'),
    );
    const r = replies.get(1).result;
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('op=beat_bars params={"project_root":"."}');
    expect(r.content[0].text).toContain('共 8 小节');
    expect(r.content[0].text).toContain('结果：{"bars":8}');
    expect(r.structuredContent).toEqual({ bars: 8 });
  });

  it('reports failures as tool errors', async () => {
    const replies = await call([{ id: 1, method: 'tools/call', params: { name: 'beat_bars', arguments: {} } }], fakeWorker('echo 读网格', { ok: false, error: '还没有已确认的节拍网格', exit_code: 1 }));
    expect(replies.get(1).result.isError).toBe(true);
    expect(text(replies.get(1))).toContain('[失败] 还没有已确认的节拍网格');
  });

  it('reports parameter problems without starting a process', async () => {
    let started = false;
    const spawner: Spawner = (name, params) => {
      started = true;
      return fakeWorker('true')(name, params);
    };
    const replies = await call([{ id: 1, method: 'tools/call', params: { name: 'beat_import', arguments: {} } }], spawner);
    expect(replies.get(1).result.isError).toBe(true);
    expect(text(replies.get(1))).toContain('缺少参数 music');
    expect(started).toBe(false);
  });

  it('hands back a job for long runs and lets the agent wait for it', async () => {
    const replies = await call([{ id: 1, method: 'tools/call', params: { name: 'beat_bars', arguments: { wait_seconds: 0 } } }], fakeWorker('sleep 0.3; echo done', undefined, 'await new Promise(r=>setTimeout(r,300));console.log("done")'));
    expect(text(replies.get(1))).toMatch(/还在运行：任务 job-1/);
    expect(text(replies.get(1))).toContain('结束本轮对话会终止仍在运行的任务');
    expect(text(replies.get(1))).toContain('不要用定时任务');
  });

  // hyperframes 的输出是写给终端的：跑着时只报进度，跑完交精简后的结果，原样输出留在临时文件里（hfoutput.ts）。
  it.skipIf(process.platform === 'win32')('compacts hyperframes output', async () => {
    const jobs = new Jobs(fakeWorker(`printf '%s\\n' '@hf-progress {"code":"capture","pct":40}' '[INFO] trace' '  ███░░  40%  Capturing'; sleep 0.4; printf '%s\\n' '◇  /p/scene-02.mp4' '   1.2 MB · 6.4s video'`));
    const job = jobs.start('hyperframes', { subcommand: 'render', args: [] });
    const running = await jobs.wait(job, 0.2);
    expect(running.text).toMatch(/^进度 40%（capture）\n\[还在运行：任务 job-1/);
    expect(running.text).not.toContain('[INFO]');
    const done = await jobs.wait(job, 5);
    expect(done.text).toContain('◇  /p/scene-02.mp4');
    expect(done.text).not.toContain('[INFO]');
    expect(done.text).not.toContain('@hf-progress');
    const log = /完整输出：(\S+)）/.exec(done.text)?.[1];
    expect(log && fs.readFileSync(log, 'utf8')).toContain('[INFO] trace');
    if (log) fs.rmSync(log);
  });

  it('job_wait returns only the new output and the final result', async () => {
    const out = new Map<unknown, any>();
    let push = null as ((line: string) => void) | null;
    const queue: string[] = [];
    async function* lines() {
      while (true) {
        if (queue.length > 0) {
          const next = queue.shift()!;
          if (next === 'END') return;
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          push = (line) => {
            queue.push(line);
            resolve();
          };
        });
      }
    }
    const send = (msg: Record<string, unknown>) => (push ? push(JSON.stringify({ jsonrpc: '2.0', ...msg })) : queue.push(JSON.stringify({ jsonrpc: '2.0', ...msg })));
    const served = serveToolsMCP(lines(), (line) => {
      const msg = JSON.parse(line);
      out.set(msg.id, msg);
    }, 'orchestrator', fakeWorker('echo first; sleep 0.4; echo second', { ok: true, data: { n: 2 }, exit_code: 0 }, 'console.log("first");await new Promise(r=>setTimeout(r,1000));console.log("second")'));
    send({ id: 1, method: 'tools/call', params: { name: 'beat_bars', arguments: { wait_seconds: process.platform === 'win32' ? 0.5 : 0.1 } } });
    while (!out.has(1)) await new Promise((r) => setTimeout(r, 20));
    expect(text(out.get(1))).toContain('first');
    send({ id: 2, method: 'tools/call', params: { name: 'job_wait', arguments: { job: 'job-1', wait_seconds: 5 } } });
    while (!out.has(2)) await new Promise((r) => setTimeout(r, 20));
    const second = text(out.get(2));
    expect(second).toContain('second');
    expect(second).not.toContain('first');
    expect(second).toContain('结果：{"n":2}');
    expect(second).not.toContain('onset-result');
    push ? push('END') : queue.push('END');
    await served;
  });

  // 客户端停掉一轮时编排工具那一整组收到 SIGTERM：工具服务要立刻停掉还在跑的任务（渲染这类各成进程组），
  // 不能等 stdin 关闭——随后的 SIGKILL 不给机会（2026-11：渲染器在界面上停不掉）。
  it('stops running jobs as soon as it is cancelled', async () => {
    const out = new Map<unknown, any>();
    let release = () => {};
    const ended = new Promise<void>((resolve) => (release = resolve));
    async function* lines() {
      yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'beat_bars', arguments: { wait_seconds: 0 } } });
      await ended;
    }
    let pid = 0;
    const worker = fakeWorker('sleep 30', { ok: true, exit_code: 0 }, 'await new Promise(resolve => setTimeout(resolve,30000))');
    const spawner: Spawner = (name, params) => {
      const child = worker(name, params);
      pid = child.pid ?? 0;
      return child;
    };
    const controller = new AbortController();
    const served = serveToolsMCP(lines(), (line) => {
      const msg = JSON.parse(line);
      out.set(msg.id, msg);
    }, 'orchestrator', spawner, controller.signal);
    while (!out.has(1)) await new Promise((r) => setTimeout(r, 20));
    expect(text(out.get(1))).toContain('还在运行');
    const alive = () => {
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    controller.abort();
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(alive(), '取消后任务的进程组应当没了').toBe(false);
    release();
    await served;
  });

  it('explains a tool on request, with its parameters and examples', async () => {
    const replies = await call([{ id: 1, method: 'tools/call', params: { name: 'tool_help', arguments: { tool: 'beat_regrid' } } }], fakeWorker('true'));
    const help = text(replies.get(1));
    expect(help).toContain('meter（整数）');
    expect(help).toContain('beat_regrid({"meter": 4, "anchor": 1})');
  });
});

// 客户端里 onset 由 Electron 当 Node 运行，main.ts 一启动就删掉 ELECTRON_RUN_AS_NODE（不能漏给 agent）。
// 执行进程要是照抄 process.env，起来的会是一个完整的 Electron 应用：操作跑完了进程也不退出，
// 工具服务每次都报「还在运行」（2026-11 实测）。CI 跑在普通 Node 下复现不了，所以在这里钉住。
describe('op worker command', () => {
  it('puts ELECTRON_RUN_AS_NODE back when onset runs inside Electron', () => {
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    Object.defineProperty(process.versions, 'electron', { value: '45.0.0', configurable: true });
    try {
      const command = opCommand('align_text', {});
      expect(command.file).toBe(process.execPath);
      expect(command.args.slice(1)).toEqual(['__op', 'align_text', '{}']);
      expect(command.env.ELECTRON_RUN_AS_NODE).toBe('1');
    } finally {
      delete (process.versions as Record<string, string | undefined>).electron;
      if (saved !== undefined) process.env.ELECTRON_RUN_AS_NODE = saved;
    }
    // 普通 Node 下不加。
    expect(opCommand('align_text', {}).env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
