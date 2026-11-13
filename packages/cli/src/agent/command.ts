/**
 * am studio agent：导演（ORCHESTRATOR=director）。客户端与 am run 按 tools.orchestratorInvocation 启动它，
 * 请求经 stdin 一行 JSON（director.Request），输出 claude 系的 stream-json，由 agentrun 解析。
 *
 * am 的制作工具不经 MCP，直接在这个进程里做成 agent 的工具：工具列表与参数校验与工具服务（toolsmcp）
 * 是同一份（describeTools、prepareCall），每次调用照样起一个执行进程（Jobs），只是不用 wait_seconds /
 * job_wait——那是给 codex 的 60 秒 MCP 超时准备的，这里直接等到跑完，取消时整组结束。
 *
 * pi 在单独的 am-agent.cjs 里（见 pi.ts 的说明），只有这个命令加载它。
 */
import path from 'node:path';
import * as director from '@am/engine/director';
import * as studioview from '@am/engine/studioview';
import { currentEnvironment } from '../cli';
import { Command, ref } from '../cobra';
import { callTarget, describeTools, Jobs, prepareCall, spawnOp, type Spawner } from '../toolsmcp';
import type { ParamValues } from '../ops/op';
import { newGate } from './gate';
import type { AgentModule, AgentTool, Gate } from './types';

/** 打包时由 esbuild 定义成 am-agent.cjs 的文件名；开发与测试时没有定义，直接 import 源码。 */
declare const AM_AGENT_BUNDLE: string | undefined;

/** 加载 pi 那一半。打包后是与 am.cjs 同目录的 am-agent.cjs。 */
export async function loadAgentModule(): Promise<AgentModule> {
  if (typeof AM_AGENT_BUNDLE !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(__dirname, AM_AGENT_BUNDLE)) as AgentModule;
  }
  return (await import('./pi')) as AgentModule;
}

/** 一次调用最多等多久：比任何一步制作都长（整片渲染几个小时），真正的上限是用户按停止。 */
const maxToolSeconds = 24 * 3600;

/** 把编排档位的操作做成 agent 的工具；job_wait、job_cancel 不要（这里直接等到跑完）。 */
export function amTools(spawner: Spawner = spawnOp, root = ''): { tools: AgentTool[]; jobs: Jobs } {
  const jobs = new Jobs(spawner);
  const defs = describeTools('orchestrator', root).filter((t) => t.name !== 'job_wait' && t.name !== 'job_cancel');
  const byName = new Map(defs.map((t) => [t.name, t]));
  const tools: AgentTool[] = defs.map((def) => {
    const schema = JSON.parse(JSON.stringify(def.inputSchema)) as { properties?: Record<string, unknown> };
    if (schema.properties) delete schema.properties.wait_seconds;
    return {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: schema as Record<string, unknown>,
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
        const reply = await jobs.wait(job, maxToolSeconds, signal);
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
    throw new Error('am studio agent 的 stdin 不是合法 JSON');
  }
  const r = (raw ?? {}) as Partial<director.Request>;
  if (typeof r.workdir !== 'string' || r.workdir === '') throw new Error('请求里没有 workdir');
  if (typeof r.prompt !== 'string') throw new Error('请求里没有 prompt');
  if (typeof r.agent_dir !== 'string') throw new Error('请求里没有 agent_dir');
  if (r.resume && !r.session_id) throw new Error('续接会话需要 session_id');
  return {
    workdir: r.workdir,
    prompt: r.prompt,
    session_id: typeof r.session_id === 'string' ? r.session_id : undefined,
    resume: r.resume === true,
    model: typeof r.model === 'string' ? r.model : '',
    unsafe: r.unsafe === true,
    commands: Array.isArray(r.commands) ? r.commands.filter((c): c is string => typeof c === 'string') : [],
    writable_dirs: Array.isArray(r.writable_dirs) ? r.writable_dirs.filter((c): c is string => typeof c === 'string') : [],
    agent_dir: r.agent_dir,
  };
}

/** 跑一轮；测试直接调它（换掉 spawner、gate，给假模型）。 */
export async function runBuiltinAgent(
  req: director.Request,
  write: (line: string) => void,
  signal: AbortSignal | undefined,
  options: { spawner?: Spawner; gate?: Gate; setupModels?: (runtime: unknown) => Promise<string> | string; env?: Record<string, string | undefined> } = {},
): Promise<{ ok: boolean; error?: string }> {
  const env = options.env ?? currentEnvironment();
  const { tools, jobs } = amTools(options.spawner, req.workdir);
  const gate =
    options.gate ??
    newGate({
      workdir: req.workdir,
      unsafe: req.unsafe === true,
      commands: req.commands ?? [],
      writableDirs: req.writable_dirs ?? [],
      amTools: new Set(tools.map((t) => t.name)),
      inbox: env[studioview.ViewInboxEnv] ?? '',
    });
  const agent = await loadAgentModule();
  try {
    return await agent.runAgent({ request: req, tools, gate, write, signal, setupModels: options.setupModels });
  } finally {
    jobs.stopAll();
  }
}

export function newAgentCommand(): Command {
  const listModels = ref(false);
  const cmd = new Command({
    use: 'agent',
    hidden: true,
    short: '客户端内部用：导演（编排工具 director）',
    long: `导演：不用另装 AI CLI，填一个模型服务的 API key 就能做编排。由客户端（或 am run）按
ORCHESTRATOR=director 启动，人不直接运行。请求经 stdin 一行 JSON，输出 claude 系的 stream-json。

--list-models 打印已填 API key 的服务商下能选的模型，每行一个「服务商/模型」。`,
    example: `  # 客户端里换成导演后，每一轮都这样启动：
  echo '{"workdir":"/path/to/project","prompt":"…","agent_dir":"…"}' | am studio agent`,
    runE: async (c) => {
      const env = currentEnvironment();
      if (listModels.value) {
        const agent = await loadAgentModule();
        for (const m of await agent.listModels(director.defaultDir(env))) process.stdout.write(m + '\n');
        return;
      }
      const req = parseRequest(await readStdin());
      // 取消时 agentrun 先发 SIGTERM：停掉这一轮、结束还在跑的制作步骤（各成进程组，不显式结束会留在后台），再退出。
      const controller = new AbortController();
      const parent = c.context();
      parent.addEventListener('abort', () => controller.abort(), { once: true });
      process.once('SIGTERM', () => controller.abort());
      const result = await runBuiltinAgent(req, (line) => process.stdout.write(line + '\n'), controller.signal, { env });
      // 失败照常抛出：execute 打出原因、退出码 1，agentrun 据此判这一轮失败（原因同时在 result 事件里）。
      if (!result.ok) throw new Error(result.error ?? '导演出错');
    },
  });
  cmd.flags().boolVar(listModels, 'list-models', false, '打印能选的模型');
  return cmd;
}
