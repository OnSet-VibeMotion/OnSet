/**
 * onset 的工具服务（MCP，stdio）：客户端里的编排工具与渲染器只经它调用 onset 的能力，不在 Bash 里跑 onset。
 *
 * 以前 onset 在它们的 PATH 里，缺信息时它们会 `which onset`、`strings "$(which onset)"` 反推格式（实测两次），
 * 每次都撞白名单、弹审批卡片打断用户。现在 onset 没有对外的命令行：工具直接来自操作表（ops/op.ts），
 * 工具名、具名参数、说明与例子都是操作自己定义的，结果是操作写下的文字加结构化的 data。
 *
 * 每次调用起一个执行进程（`onset.cjs __op <名字> <参数>`，同一个运行时、同一个 onset.cjs）：并发调用、
 * 环境变量互不影响，取消时整组结束。MCP 客户端多有调用超时（codex 默认 60 秒），而渲染、拼接动辄
 * 几分钟到几小时，所以每次最多等 wait_seconds；没跑完就返回任务号与已有输出，由 job_wait 接着等、
 * job_cancel 停掉。
 */
import './cli';
import type { ParamValues } from './ops/op';
import { toolOutputArchiveDir } from './output_archive';
import {
  DefaultWaitSeconds,
  defaultWaitSeconds,
  Jobs,
  maxWaitSeconds,
  opCommand,
  type Reply,
  type Spawner,
  spawnOp,
  spawnOpWithService,
} from './toolsmcp_jobs';
import { HyperFramesSubcommands, type Profile } from './toolsmcp_policy';
import { callTarget, describeTools, externalOps, prepareCall, type ToolDef, ToolsServerName } from './toolsmcp_schema';

export {
  callTarget,
  DefaultWaitSeconds,
  defaultWaitSeconds,
  describeTools,
  externalOps,
  HyperFramesSubcommands,
  Jobs,
  maxWaitSeconds,
  opCommand,
  type Profile,
  prepareCall,
  type Reply,
  type Spawner,
  spawnOp,
  spawnOpWithService,
  type ToolDef,
  ToolsServerName,
  toolOutputArchiveDir,
};

// ---------------------------------------------------------------- MCP

/**
 * onset studio tools-mcp 的服务循环：stdio 上按行收发 JSON-RPC（与 permission-mcp 同一套写法）。
 * tools/call 不阻塞读下一行：agent 可能并行发几条调用。
 */
export async function serveToolsMCP(
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  profile: Profile,
  spawner: Spawner = spawnOp,
  signal?: AbortSignal,
): Promise<void> {
  const send = (msg: Record<string, unknown>): void => write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  // 工作目录就是项目根（编排档位）：已装的第三方插件各自的工具一起登记。
  const tools = describeTools(profile, process.cwd());
  const byName = new Map(tools.map((t) => [t.name, t]));
  const jobs = new Jobs(spawner);
  const recentSceneRuns: number[] = [];
  const sceneRunWindowMs = 10 * 60 * 1000;
  const longJobNames = new Set(['scene_run', 'scene_run_all', 'align_run', 'voice_synthesize', 'concat', 'audio_mix']);
  // 被取消（编排工具那一整组收到 SIGTERM）时立刻停掉还在跑的任务：等不到 stdin 关闭，进程可能随后就被 SIGKILL。
  signal?.addEventListener('abort', () => jobs.stopAll(), { once: true });
  const pending: Promise<void>[] = [];
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      const id = msg.id;
      if (id === undefined) continue;
      switch (msg.method) {
        case 'initialize':
          send({
            id,
            result: {
              protocolVersion:
                typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: ToolsServerName, version: '1' },
              instructions:
                '片场的制作工具，每个工具对应一条制作步骤。参数怎么填、产出什么用 tool_help 查。' +
                '每次调用可指定 wait_seconds；没跑完时用返回的任务号调用 job_wait 接着等，job_cancel 停掉。' +
                '结果里「结果：」那一行是结构化的 JSON。onset 不在终端里，不要去找它。',
            },
          });
          break;
        case 'tools/list':
          send({
            id,
            result: {
              tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
            },
          });
          break;
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const input = (msg.params?.arguments ?? {}) as ParamValues;
          const reply = (r: Reply) =>
            send({
              id,
              result: {
                content: [{ type: 'text', text: r.text }],
                ...(r.data !== undefined && typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data)
                  ? { structuredContent: r.data }
                  : {}),
                isError: r.isError,
              },
            });
          const handle = async (): Promise<void> => {
            const explicitWait = typeof input.wait_seconds === 'number';
            const seconds = explicitWait ? (input.wait_seconds as number) : defaultWaitSeconds(name);
            if (name === 'job_wait' || name === 'job_cancel') {
              const job = jobs.get(String(input.job ?? ''));
              if (!job) {
                return reply({
                  text: `没有这个任务：${String(input.job ?? '')}（可能已经结束并交过结果）`,
                  isError: true,
                });
              }
              if (name === 'job_cancel') {
                return reply({ text: jobs.cancel(job.id) ? `已停掉 ${job.id}` : `${job.id} 已经结束`, isError: false });
              }
              const result = await jobs.wait(job, seconds, signal);
              const waitDefault = defaultWaitSeconds('job_wait');
              if (
                !result.isError &&
                job.code === null &&
                explicitWait &&
                seconds > 0 &&
                seconds < Math.min(60, waitDefault) &&
                longJobNames.has(job.name)
              ) {
                return reply({
                  ...result,
                  text: `${result.text}\n[等待提示] 等待长任务时请省略 wait_seconds（按当前默认 ${waitDefault} 秒等待），避免短轮询反复唤醒消耗上下文。`,
                });
              }
              return reply(result);
            }
            if (name === 'tool_help') {
              const target = byName.get(String(input.tool ?? ''));
              if (!target) return reply({ text: `没有这个工具：${String(input.tool ?? '')}`, isError: true });
              return reply({ text: target.help || target.description, isError: false });
            }
            const tool = byName.get(name);
            if (!tool?.op) return reply({ text: `没有这个工具：${name}`, isError: true });
            let params: ParamValues;
            try {
              params = prepareCall(tool, input);
            } catch (err) {
              return reply({ text: (err as Error).message, isError: true });
            }
            const target = callTarget(tool, params);
            let batchNudge = '';
            if (profile === 'orchestrator' && target.name === 'scene_run') {
              const now = Date.now();
              while (recentSceneRuns.length > 0 && now - recentSceneRuns[0]! > sceneRunWindowMs)
                recentSceneRuns.shift();
              recentSceneRuns.push(now);
              const active = jobs.activeCount('scene_run');
              if (active >= 1 || recentSceneRuns.length >= 3) {
                batchNudge =
                  '\n[调度提示] 检测到短时间内多次单独调用 scene_run。多镜头批量渲染或返修请改用一次 scene_run_all({"scenes":"scenes/","only_scenes":[...],"force":true}) 由片场统一并发调度，可大幅减少 job_wait 轮询与 token 消耗。';
              }
            }
            const result = await jobs.wait(jobs.start(target.name, target.params), seconds, signal);
            reply(batchNudge ? { ...result, text: result.text + batchNudge } : result);
          };
          pending.push(handle());
          break;
        }
        case 'ping':
          send({ id, result: {} });
          break;
        default:
          send({ id, error: { code: -32601, message: 'method not found: ' + String(msg.method) } });
      }
    }
    await Promise.allSettled(pending);
  } finally {
    jobs.stopAll();
  }
}
