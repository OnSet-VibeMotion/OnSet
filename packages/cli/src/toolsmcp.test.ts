import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { describeTools, serveToolsMCP, type Spawner, toArgv, toolNotation } from './toolsmcp';

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

/** 假的 am：用 sh 执行一段脚本，脚本里能拿到 argv（$@）。 */
function fakeAm(script: string): Spawner {
  return (argv) => spawn('/bin/sh', ['-c', script, 'am', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
}

const text = (msg: any): string => msg.result.content[0].text;

describe('am tools MCP', () => {
  it('makes one tool per command, leaving out setup, run and init', () => {
    const names = describeTools('orchestrator').map((t) => t.name);
    for (const want of ['scene_run', 'scene_run_all', 'align_build', 'concat', 'review', 'studio_show', 'film_style_use', 'beat_cues', 'hyperframes', 'job_wait', 'tool_help']) {
      expect(names).toContain(want);
    }
    for (const banned of ['setup', 'run', 'init', 'studio_permission_mcp', 'studio_tools_mcp']) expect(names).not.toContain(banned);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives the renderer only HyperFrames', () => {
    expect(describeTools('renderer').map((t) => t.name)).toEqual(['hyperframes', 'job_wait', 'job_cancel', 'tool_help']);
  });

  it('turns parameters back into the command line', () => {
    const tools = describeTools('orchestrator');
    const runAll = tools.find((t) => t.name === 'scene_run_all')!;
    expect(toArgv(runAll, { args: ['scenes/'], jobs: 2, force: true, duration_tolerance: 0.2 })).toEqual([
      'scene', 'run-all', '--jobs', '2', '--force=true', '--duration-tolerance', '0.2', '--', 'scenes/',
    ]);
    expect(() => toArgv(runAll, { nope: 1 })).toThrow(/没有参数 nope/);
    expect(() => toArgv(runAll, { force: 'yes' })).toThrow(/true 或 false/);
  });

  it('only lets local, read-only or rendering HyperFrames commands through', () => {
    const hf = describeTools('renderer').find((t) => t.name === 'hyperframes')!;
    expect(toArgv(hf, { subcommand: 'lint' })).toEqual(['hyperframes', 'lint']);
    expect(toArgv(hf, { subcommand: 'snapshot', args: ['--at', '1.5'] })).toEqual(['hyperframes', 'snapshot', '--at', '1.5', '--describe', 'false']);
    expect(toArgv(hf, { subcommand: 'timeline', args: ['--json'] })).toEqual(['hyperframes', 'timeline', '--json']);
    expect(() => toArgv(hf, { subcommand: 'timeline', args: ['move', '--json'] })).toThrow(/只读/);
    expect(() => toArgv(hf, { subcommand: 'publish' })).toThrow(/不放行/);
    expect(() => toArgv(hf, { subcommand: 'upgrade' })).toThrow(/不放行/);
  });

  it('runs a command and returns its output and exit code', async () => {
    const replies = await call(
      [{ id: 1, method: 'tools/call', params: { name: 'scene_run', arguments: { args: ['scenes/scene-001'] } } }],
      fakeAm('echo "ran $*"'),
    );
    expect(text(replies.get(1))).toBe('ran scene run -- scenes/scene-001\n[完成，退出码 0]');
    expect(replies.get(1).result.isError).toBe(false);
  });

  it('reports failures as tool errors', async () => {
    const replies = await call([{ id: 1, method: 'tools/call', params: { name: 'review', arguments: {} } }], fakeAm('echo boom >&2; exit 3'));
    expect(text(replies.get(1))).toBe('boom\n[失败，退出码 3]');
    expect(replies.get(1).result.isError).toBe(true);
  });

  it('hands back a job for long runs and lets the agent wait for it', async () => {
    const replies = await call(
      [{ id: 1, method: 'tools/call', params: { name: 'scene_run_all', arguments: { args: ['scenes/'], wait_seconds: 0.2 } } }],
      fakeAm('echo started; sleep 1; echo finished'),
    );
    expect(text(replies.get(1))).toMatch(/^started\n\[还在运行：任务 job-1。用 job_wait/);
  });

  it('job_wait returns only the new output and the final exit code', async () => {
    const out = new Map<unknown, any>();
    let push = null as ((line: string) => void) | null;
    const queue: string[] = [];
    async function* lines() {
      for (;;) {
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
    const done = serveToolsMCP(lines(), (line) => {
      const msg = JSON.parse(line);
      out.set(msg.id, msg);
    }, 'orchestrator', fakeAm('echo one; sleep 0.5; echo two'));
    send({ id: 1, method: 'tools/call', params: { name: 'concat', arguments: { wait_seconds: 0.1 } } });
    await new Promise((r) => setTimeout(r, 300));
    send({ id: 2, method: 'tools/call', params: { name: 'job_wait', arguments: { job: 'job-1', wait_seconds: 5 } } });
    await new Promise((r) => setTimeout(r, 1000));
    send({ id: 3, method: 'tools/call', params: { name: 'job_wait', arguments: { job: 'job-1' } } });
    queue.push('END');
    push?.('');
    await done;
    expect(text(out.get(1))).toMatch(/^one\n\[还在运行/);
    expect(text(out.get(2))).toBe('two\n[完成，退出码 0]');
    expect(out.get(3).result.isError).toBe(true);
  });

  it('explains a tool on request, with its full help', async () => {
    const replies = await call([{ id: 1, method: 'tools/call', params: { name: 'tool_help', arguments: { tool: 'align_build' } } }], fakeAm('true'));
    expect(text(replies.get(1))).toContain('phrase-timeline.json');
  });

  // am 的帮助与输出是给命令行写的；交给 agent 前换成工具调用，agent 照着就能调，不会去终端里找 am。
  it('rewrites am command lines as tool calls', () => {
    const tools = describeTools('orchestrator');
    expect(toolNotation('请重新运行 am beat cues 并重渲染', tools)).toBe('请重新运行 beat_cues() 并重渲染');
    expect(toolNotation('先 am film-style add lemo/ink；再 am scene run-all scenes/ --force', tools)).toBe(
      '先 film_style_add({"args": ["lemo/ink"]})；再 scene_run_all({"args": ["scenes/"], "force": true})',
    );
    expect(toolNotation('  am beat regrid --meter 4 --anchor 1   重排重拍', tools)).toBe('  beat_regrid({"meter": 4, "anchor": 1})   重排重拍');
    // 例子独占一行时参数可以是中文；反斜杠续行接起来。
    expect(toolNotation('  am film-style use 油画厚涂', tools)).toBe('  film_style_use({"args": ["油画厚涂"]})');
    expect(toolNotation('  am align build --fps 30 \\\n    --align a.json', tools)).toBe('  align_build({"fps": 30, "align": ["a.json"]})');
    expect(toolNotation('am hyperframes check --json', tools)).toBe('hyperframes({"subcommand": "check", "args": ["--json"]})');
    // 不是命令的不动：路径里的 am、「由 am 维护」、不开放的 am setup。
    for (const keep of ['~/.local/bin/am', '由 am 维护', 'am-scene.js', '先运行 am setup']) expect(toolNotation(keep, tools)).toBe(keep);
  });

  it('hands help and output to the agent as tool calls', async () => {
    const replies = await call(
      [
        { id: 1, method: 'tools/call', params: { name: 'tool_help', arguments: { tool: 'scene_run_all' } } },
        { id: 2, method: 'tools/call', params: { name: 'beat_bars', arguments: {} } },
      ],
      fakeAm('echo "下一步：am beat cues scenes/"'),
    );
    expect(text(replies.get(1))).toContain('scene_run_all({"args": ["scenes/"], "force": true})');
    expect(text(replies.get(1))).not.toMatch(/(^|\s)am scene/m);
    expect(text(replies.get(2))).toContain('下一步：beat_cues({"args": ["scenes/"]})');
  });
});
