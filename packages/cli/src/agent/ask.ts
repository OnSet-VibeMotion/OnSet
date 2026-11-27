/**
 * 内置制作人（director / pi）的结构化多题提问工具：与 MCP 的 studio_ask 共用同一份 Schema 与收件箱协议。
 * 制作人进程内直接阻塞等待用户提交（无外部 MCP 工具超时限制），取消时由 AbortSignal 立即唤醒。
 */
import * as studioview from '@onset/engine/studioview';
import type { AgentTool } from './types';

export function askTool(inbox: string, pollInterval = studioview.QuestionPollInterval): AgentTool {
  return {
    name: studioview.StudioAskToolName,
    label: '请用户确认',
    description: studioview.studioAskDescription,
    parameters: studioview.studioAskInputSchema as unknown as Record<string, unknown>,
    sequential: true,
    async execute(input, signal) {
      try {
        studioview.normalizeQuestionInput(input);
      } catch (err) {
        return { text: (err as Error).message, isError: true };
      }
      if (inbox === '') {
        const data = { status: 'unavailable' };
        return {
          text:
            '当前不在片场客户端中，无法弹出交互提问卡片。请直接在回复正文用文字与 ```questions 代码块列出问题并结束本轮，等待用户回复。\n结果：' +
            JSON.stringify(data),
          isError: false,
        };
      }
      const req = studioview.writeQuestionRequest(inbox, input);
      const outcome = await studioview.waitQuestionResponse(inbox, req.id, pollInterval, signal);
      if (outcome.kind !== 'response') {
        return { text: '提问已取消。', isError: true };
      }
      const summary = studioview.formatQuestionAnswers(req, outcome.response);
      return {
        text: `${summary}\n结果：${JSON.stringify(outcome.response)}`,
        isError: false,
      };
    },
  };
}
