/**
 * onset 的工具服务（MCP，stdio）：客户端里的编排工具与渲染器只经它调用 onset 的能力，不在 Bash 里跑 onset。
 *
 * 编排档位默认开启静态紧凑模式：核心主链路以精简 schema 直出，其余扩展与第三方站工具经 tool_search 检索、
 * 经 tool_call 执行（永久静默兼容旧名 tool_help 与 onset_call），全程不发 tools/list_changed 以保住 KV Prompt Cache。
 *
 * 每次调用起一个执行进程（`onset.cjs __op <名字> <参数>`，同一个运行时、同一个 onset.cjs）：并发调用、
 * 环境变量互不影响，取消时整组结束。MCP 客户端多有调用超时（codex 默认 60 秒），而渲染、拼接动辄
 * 几分钟到几小时，所以每次最多等 wait_seconds；没跑完就返回任务号与已有输出，由 job_wait 接着等、
 * job_cancel 停掉。
 */
import './cli';
import * as studioview from '@onset/engine/studioview';
import type { ParamValues } from './ops/op';
import { toolOutputArchiveDir } from './output_archive';
import { DirectOnlyTools, formatToolIndex, parseRoutedArguments, searchTools } from './toolsmcp_compact';
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
import {
  CompactCoreOps,
  compactModeEnabled,
  fullModeEnabled,
  HyperFramesSubcommands,
  LegacyOnsetCallName,
  LegacyToolHelpName,
  OnsetCallToolName,
  type Profile,
  ToolCallName,
  ToolCategories,
  ToolSearchName,
  ToolsCompactEnv,
  ToolsFullEnv,
  toolCategory,
} from './toolsmcp_policy';
import {
  callTarget,
  type DescribeToolsOptions,
  describeToolCatalog,
  describeTools,
  externalOps,
  prepareCall,
  type ToolCatalog,
  type ToolDef,
  ToolsServerName,
} from './toolsmcp_schema';

export {
  CompactCoreOps,
  callTarget,
  compactModeEnabled,
  DefaultWaitSeconds,
  type DescribeToolsOptions,
  DirectOnlyTools,
  defaultWaitSeconds,
  describeToolCatalog,
  describeTools,
  externalOps,
  formatToolIndex,
  fullModeEnabled,
  HyperFramesSubcommands,
  Jobs,
  LegacyOnsetCallName,
  LegacyToolHelpName,
  maxWaitSeconds,
  OnsetCallToolName,
  opCommand,
  type Profile,
  parseRoutedArguments,
  prepareCall,
  type Reply,
  type Spawner,
  searchTools,
  spawnOp,
  spawnOpWithService,
  ToolCallName,
  type ToolCatalog,
  ToolCategories,
  type ToolDef,
  ToolSearchName,
  ToolsCompactEnv,
  ToolsFullEnv,
  ToolsServerName,
  toolCategory,
  toolOutputArchiveDir,
};

// ---------------------------------------------------------------- MCP

export interface ServeToolsMCPOptions extends DescribeToolsOptions {
  inbox?: string;
  questionTimeoutMs?: number;
  questionPollInterval?: number;
}

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
  options: ServeToolsMCPOptions = {},
): Promise<void> {
  const send = (msg: Record<string, unknown>): void => write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const compact = profile === 'orchestrator' && (options.compact ?? compactModeEnabled());
  // 工作目录就是项目根（编排档位）：已装的第三方插件各自的工具一起登记。
  const catalog = describeToolCatalog(profile, process.cwd(), { compact });
  const tools = catalog.exposed;
  const allByName = new Map(catalog.all.map((t) => [t.name, t]));
  const jobs = new Jobs(spawner);
  const recentSceneRuns: number[] = [];
  const sceneRunWindowMs = 10 * 60 * 1000;
  const longJobNames = new Set(['scene_run', 'scene_run_all', 'align_run', 'voice_synthesize', 'concat', 'audio_mix']);
  // 被取消（编排工具那一整组收到 SIGTERM）时立刻停掉还在跑的任务：等不到 stdin 关闭，进程可能随后就被 SIGKILL。
  signal?.addEventListener('abort', () => jobs.stopAll(), { once: true });
  const pending: Promise<void>[] = [];
  const instructions =
    profile === 'orchestrator'
      ? `片场的制作工具，每个工具对应一条制作步骤。查参数、示例或按关键词/领域搜工具用 ${ToolSearchName}。` +
        (compact
          ? `核心主链路工具直接暴露，其余扩展与第三方站工具经 ${ToolSearchName} 查找后通过 ${ToolCallName}({"tool": "<名>", "arguments": {...}}) 调用，全部目录可用 ${ToolSearchName}({"query": "*"}) 列出。`
          : '') +
        '每次调用可指定 wait_seconds；没跑完时用返回的任务号调用 job_wait 接着等，job_cancel 停掉。' +
        '结果里「结果：」那一行是结构化的 JSON。onset 不在终端里，不要去找它。'
      : '片场的渲染工具。参数怎么填、产出什么用 tool_help 查。每次调用可指定 wait_seconds；没跑完时用返回的任务号调用 job_wait 接着等，job_cancel 停掉。结果里「结果：」那一行是结构化的 JSON。onset 不在终端里，不要去找它。';

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
              instructions,
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
            if (name === ToolSearchName || name === LegacyToolHelpName) {
              return reply(searchTools(catalog, input, { legacyHelp: name === LegacyToolHelpName }));
            }
            if (name === studioview.StudioAskToolName && profile === 'orchestrator') {
              try {
                studioview.normalizeQuestionInput(input);
              } catch (err) {
                return reply({ text: (err as Error).message, isError: true });
              }
              const inbox = options.inbox ?? process.env[studioview.ViewInboxEnv] ?? '';
              if (inbox === '') {
                const data = { status: 'unavailable' };
                return reply({
                  text:
                    '当前不在片场客户端中，无法弹出交互提问卡片。请直接在回复正文用文字与 ```questions 代码块列出问题并结束本轮，等待用户回复。\n结果：' +
                    JSON.stringify(data),
                  isError: false,
                  data,
                });
              }
              const req = studioview.writeQuestionRequest(inbox, input);
              const budgetMs = options.questionTimeoutMs ?? Math.max(15, maxWaitSeconds() - 15) * 1000;
              const pollMs = options.questionPollInterval ?? studioview.QuestionPollInterval;
              const outcome = await studioview.waitQuestionResponse(inbox, req.id, pollMs, signal, budgetMs);
              if (outcome.kind === 'aborted') {
                return reply({
                  text: '提问已取消。',
                  isError: true,
                  data: { status: 'cancelled', question_id: req.id },
                });
              }
              if (outcome.kind === 'deferred') {
                const data = { status: 'deferred', question_id: req.id };
                return reply({
                  text:
                    '用户尚未提交问题卡片，卡片已保留在界面上等待用户填写。不要重复提问、不要替用户决定，请简短提示用户在问题卡片中提交选择后继续，然后结束本轮。\n结果：' +
                    JSON.stringify(data),
                  isError: false,
                  data,
                });
              }
              const summary = studioview.formatQuestionAnswers(req, outcome.response);
              return reply({
                text: `${summary}\n结果：${JSON.stringify(outcome.response)}`,
                isError: false,
                data: outcome.response,
              });
            }
            let opName = name;
            let opInput = input;
            let waitSeconds = seconds;
            if (name === ToolCallName || name === LegacyOnsetCallName) {
              opName = String(input.tool ?? '').trim();
              if (opName === '') return reply({ text: `${name} 缺少参数 tool`, isError: true });
              if (DirectOnlyTools.has(opName)) {
                return reply({ text: `请直接调用 ${opName}，不要经 ${name} 转发`, isError: true });
              }
              try {
                opInput = parseRoutedArguments(input.arguments, name);
              } catch (err) {
                return reply({ text: (err as Error).message, isError: true });
              }
              waitSeconds = explicitWait
                ? (input.wait_seconds as number)
                : typeof opInput.wait_seconds === 'number'
                  ? (opInput.wait_seconds as number)
                  : defaultWaitSeconds(opName);
            }
            const tool = allByName.get(opName);
            if (!tool?.op) return reply({ text: `没有这个工具：${opName}`, isError: true });
            let params: ParamValues;
            try {
              params = prepareCall(tool, opInput);
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
            const result = await jobs.wait(jobs.start(target.name, target.params), waitSeconds, signal);
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
