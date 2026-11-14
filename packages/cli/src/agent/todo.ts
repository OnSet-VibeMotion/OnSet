/**
 * 制作人的待办清单工具。pi 自己没有待办工具，而客户端靠待办清单显示整片制作做到哪了：其他几家的待办
 * （claude 的 TodoWrite、codex 的 todo_list……）都被 agentrun 译成 plan 事件。这里照 claude 的
 * TodoWrite 起名、照它的参数形状收（todos: [{content, status, activeForm?}]，每次是完整清单），
 * 它的 tool_use 经 StreamWriter 原样写出，agentrun 按 claude 系解析就变成 plan 事件，不用另写解析。
 *
 * 执行什么也不做，只回一句确认：清单本身就在工具调用的参数里，会话记录与界面都从那里读。
 */
import type { AgentTool } from './types';

export const TodoToolName = 'TodoWrite';

const statuses = ['pending', 'in_progress', 'completed'] as const;

export function todoTool(): AgentTool {
  return {
    name: TodoToolName,
    label: '待办清单',
    description:
      '写下或更新这一轮工作的待办清单，用户会在对话顶部看到进度。每次传完整的清单（不是增量）；同一时间只有一项 in_progress，做完一项立刻标 completed。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的待办清单',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '这一步做什么，例如「写口播稿」' },
              status: { type: 'string', enum: [...statuses] },
              activeForm: { type: 'string', description: '进行中时显示的说法，例如「正在写口播稿」' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    sequential: false,
    async execute(input) {
      const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
      const done = todos.filter((t) => t?.status === 'completed').length;
      return { text: `待办清单已更新：共 ${todos.length} 项，完成 ${done} 项。`, isError: false };
    },
  };
}
