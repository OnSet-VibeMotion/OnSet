/**
 * am studio agent（导演）两半之间的接口：
 *
 * - command.ts 在 am.cjs 里：读请求、把操作表做成工具、管权限，不 import pi；
 * - pi.ts 打成单独的 am-agent.cjs，只在这一个命令里加载，跑 pi 的 agent 循环。
 *
 * 这里只放类型，两边都能 import，不会把 pi 拖进 am.cjs。
 */
import type * as director from '@am/engine/director';

/** 交给 agent 的一个工具（am 的一条操作，或 tool_help）。parameters 是 JSON Schema。 */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 是否要与同一批里的其他工具调用排队执行。pi 默认把模型一次发出的几个工具调用并行跑；一批里只要有一个
   * 是顺序的，整批就逐个执行（pi-agent-core 的 executeToolCalls）。am 的制作步骤都写项目文件，必须顺序。
   */
  sequential: boolean;
  execute(input: Record<string, unknown>, signal: AbortSignal | undefined): Promise<{ text: string; isError: boolean }>;
}

/**
 * 一次工具调用要不要放行：返回 null 放行，返回字符串则拦下，字符串是告诉模型的原因。
 * toolName 是 pi 的工具名（read、bash……）或 am 的工具名。
 */
export type Gate = (toolName: string, input: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<string | null>;

export interface RunOptions {
  request: director.Request;
  tools: AgentTool[];
  gate: Gate;
  /** 写一行 stream-json（不带换行）。 */
  write: (line: string) => void;
  signal?: AbortSignal;
  /**
   * 测试用：在模型运行时上登记假服务商，返回要用的「服务商/模型」。
   * 参数是 pi 的 ModelRuntime，这里不写它的类型，免得这份文件 import pi。
   */
  setupModels?: (runtime: unknown) => Promise<string> | string;
}

/** pi.ts（am-agent.cjs）导出的东西。 */
export interface AgentModule {
  runAgent(options: RunOptions): Promise<{ ok: boolean; error?: string }>;
  listModels(agentDir: string): Promise<string[]>;
}
