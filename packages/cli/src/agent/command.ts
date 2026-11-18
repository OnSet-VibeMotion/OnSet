/**
 * onset studio agent：制作人（ORCHESTRATOR=director）。客户端与 onset run 按 tools.orchestratorInvocation 启动它，
 * 请求经 stdin 一行 JSON（director.Request），输出 claude 系的 stream-json，由 agentrun 解析。
 *
 * onset 的制作工具不经 MCP，直接在这个进程里做成 agent 的工具：工具列表与参数校验与工具服务（toolsmcp）
 * 是同一份（describeTools、prepareCall），每次调用照样起一个执行进程（Jobs），只是不用 wait_seconds /
 * job_wait——那是给 codex 的 60 秒 MCP 超时准备的，这里直接等到跑完，取消时整组结束。
 *
 * pi 在单独的 onset-agent.cjs 里（见 pi.ts 的说明），只有这个命令加载它。
 */
import path from 'node:path';
import * as director from '@onset/engine/director';
import * as studioview from '@onset/engine/studioview';
import { currentEnvironment } from '../cli';
import { Command } from '../cobra';
import { callTarget, describeTools, Jobs, prepareCall, spawnOp, spawnOpWithService, type Spawner } from '../toolsmcp';
import type { ParamValues } from '../ops/op';
import { newGate } from './gate';
import { todoTool } from './todo';
import type { AgentModule, AgentTool, Gate } from './types';

/** 打包时由 esbuild 定义成 onset-agent.cjs 的文件名；开发与测试时没有定义，直接 import 源码。 */
declare const ONSET_AGENT_BUNDLE: string | undefined;

/** 加载 pi 那一半。打包后是与 onset.cjs 同目录的 onset-agent.cjs。 */
export async function loadAgentModule(): Promise<AgentModule> {
  if (typeof ONSET_AGENT_BUNDLE !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(__dirname, ONSET_AGENT_BUNDLE)) as AgentModule;
  }
  return (await import('./pi')) as AgentModule;
}

/**
 * 把编排档位的操作做成 agent 的工具；job_wait、job_cancel 不要（这里直接等到跑完）。
 * 除了只读的 tool_help，都顺序执行：模型一次发出 scene_cues 与 scene_run 时，后者要等前者写完 scene.json。
 */
export function onsetTools(spawner: Spawner = spawnOp, root = '', profile: 'orchestrator' | 'renderer' = 'orchestrator'): { tools: AgentTool[]; jobs: Jobs } {
  const jobs = new Jobs(spawner);
  const defs = describeTools(profile, root).filter((t) => t.name !== 'job_wait' && t.name !== 'job_cancel');
  const byName = new Map(defs.map((t) => [t.name, t]));
  const tools: AgentTool[] = defs.map((def) => {
    const schema = JSON.parse(JSON.stringify(def.inputSchema)) as { properties?: Record<string, unknown> };
    if (schema.properties) delete schema.properties.wait_seconds;
    return {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: schema as Record<string, unknown>,
      sequential: def.name !== 'tool_help',
      async execute(input, signal) {
        if (def.name === 'tool_help') {
          const target = byName.get(String(input.tool ?? ''));
          if (!target) return { text: `没有这个工具：${String(input.tool ?? '')}`, isError: true };
          return { text: target.help || target.description, isError: false };
        }
        let params: ParamValues;
        try {
          params = prepareCall(def, input as ParamValues);
        } catch (err) {
          return { text: (err as Error).message, isError: true };
        }
        const target = callTarget(def, params);
        const job = jobs.start(target.name, target.params);
        const reply = await jobs.wait(job, undefined, signal);
        if (signal?.aborted) jobs.cancel(job.id);
        return { text: reply.text, isError: reply.isError };
      },
    };
  });
  return { tools, jobs };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function parseRequest(text: string): director.Request {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('onset studio agent 的 stdin 不是合法 JSON');
  }
  const r = (raw ?? {}) as Partial<director.Request>;
  if (typeof r.workdir !== 'string' || r.workdir === '') throw new Error('请求里没有 workdir');
  if (typeof r.prompt !== 'string') throw new Error('请求里没有 prompt');
  if (typeof r.agent_dir !== 'string') throw new Error('请求里没有 agent_dir');
  if (r.resume && !r.session_id) throw new Error('续接会话需要 session_id');
  return {
    workdir: r.workdir,
    prompt: r.prompt,
    profile: r.profile === 'renderer' ? 'renderer' : undefined,
    read_dirs: Array.isArray(r.read_dirs) ? r.read_dirs.filter((c): c is string => typeof c === 'string') : [],
    session_id: typeof r.session_id === 'string' ? r.session_id : undefined,
    resume: r.resume === true,
    model: typeof r.model === 'string' ? r.model : '',
    thinking: typeof r.thinking === 'string' && thinkingLevels.has(r.thinking) ? r.thinking : undefined,
    unsafe: r.unsafe === true,
    commands: Array.isArray(r.commands) ? r.commands.filter((c): c is string => typeof c === 'string') : [],
    writable_dirs: Array.isArray(r.writable_dirs) ? r.writable_dirs.filter((c): c is string => typeof c === 'string') : [],
    agent_dir: r.agent_dir,
    service: director.parseResolvedService(r.service) ?? undefined,
  };
}

/** pi 的 thinkingLevel 取值（pi-agent-core 的 ThinkingLevel）；别的值不交给 pi。 */
const thinkingLevels: ReadonlySet<string> = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 跑一轮；测试直接调它（换掉 spawner、gate，给假模型）。 */
export async function runBuiltinAgent(
  req: director.Request,
  write: (line: string) => void,
  signal: AbortSignal | undefined,
  options: { spawner?: Spawner; gate?: Gate; setupModels?: (runtime: unknown) => Promise<string> | string; env?: Record<string, string | undefined> } = {},
): Promise<{ ok: boolean; error?: string }> {
  const env = options.env ?? currentEnvironment();
  // 整理经验这类会再起制作人的操作要拿到模型服务与 key：经执行进程的 stdin 交下去（spawnOpWithService），不进环境。
  const onset = onsetTools(options.spawner ?? spawnOpWithService(req.service ?? null), req.workdir, req.profile ?? 'orchestrator');
  const jobs = onset.jobs;
  // 待办清单与 onset 的工具一样直接放行：它只把清单写进工具调用，什么也不做。
  const tools = [...onset.tools, todoTool()];
  const gate =
    options.gate ??
    newGate({
      workdir: req.workdir,
      unsafe: req.unsafe === true,
      commands: req.commands ?? [],
      writableDirs: req.writable_dirs ?? [],
      readDirs: req.profile === 'renderer' ? req.read_dirs : undefined,
      agentDir: req.agent_dir,
      onsetTools: new Set(tools.map((t) => t.name)),
      inbox: req.profile === 'renderer' ? '' : env[studioview.ViewInboxEnv] ?? '',
    });
  const agent = await loadAgentModule();
  try {
    return await agent.runAgent({ request: req, tools, gate, write, signal, setupModels: options.setupModels });
  } finally {
    jobs.stopAll();
  }
}

export function newAgentCommand(): Command {
  const cmd = new Command({
    use: 'agent',
    hidden: true,
    short: '客户端内部用：制作人（编排工具 director）',
    long: `制作人：不用另装 AI CLI，配一个模型服务（base URL 与 API key）就能做编排。由客户端（或 onset run）按
ORCHESTRATOR=director 启动，人不直接运行。请求经 stdin 一行 JSON，输出 claude 系的 stream-json。`,
    example: `  # 客户端里换成制作人后，每一轮都这样启动：
  echo '{"workdir":"/path/to/project","prompt":"…","agent_dir":"…"}' | onset studio agent`,
    runE: async (c) => {
      const env = currentEnvironment();
      const req = parseRequest(await readStdin());
      // 取消时 agentrun 先发 SIGTERM：停掉这一轮、结束还在跑的制作步骤（各成进程组，不显式结束会留在后台），再退出。
      const controller = new AbortController();
      const parent = c.context();
      parent.addEventListener('abort', () => controller.abort(), { once: true });
      process.once('SIGTERM', () => controller.abort());
      const result = await runBuiltinAgent(req, (line) => process.stdout.write(line + '\n'), controller.signal, { env });
      // 失败照常抛出：execute 打出原因、退出码 1，agentrun 据此判这一轮失败（原因同时在 result 事件里）。
      if (!result.ok) throw new Error(result.error ?? '制作人出错');
    },
  });
  return cmd;
}
