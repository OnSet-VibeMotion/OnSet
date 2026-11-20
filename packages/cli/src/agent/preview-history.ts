import type { MessageEndEvent } from '@earendil-works/pi-coding-agent';

type Message = MessageEndEvent['message'];

/**
 * Drop old preview / inspection images at an image-result boundary, retaining results, paths and recent visual evidence.
 *
 * - renderer: 只整理 scene_preview_check 返回的联系表与细节图（不碰用户参考图或 read 读进来的素材图）。
 * - orchestrator: 整理工具返回的检查图（read 打开的质检联系表/抽帧图等；用户消息里附带的图不属于 toolResult，始终保留）。
 */
export class PreviewHistory {
  private readonly omitted = new Set<string>();

  constructor(private readonly mode: 'renderer' | 'orchestrator' = 'renderer') {}

  private isCompactable(message: Message | undefined): boolean {
    if (!message || message.role !== 'toolResult') return false;
    if (this.mode === 'renderer') return message.toolName === 'scene_preview_check';
    return message.content.some(c => c.type === 'image');
  }

  project(messages: Message[], threshold: number): { messages: Message[]; trimmed: number } {
    const last = messages.at(-1);
    let trimmed = 0;
    if (this.isCompactable(last)) {
      const response = messages.findLast(m => m.role === 'assistant');
      const u = response?.usage;
      const used = u ? u.input + u.cacheRead + u.cacheWrite + u.output : 0;
      if (used >= threshold) {
        const sheets = messages.filter(m => this.isCompactable(m)
          && m.role === 'toolResult'
          && !this.omitted.has(m.toolCallId)
          && m.content.some(c => c.type === 'image'));
        // Make a change only when there's a batch to drop. Each change can break a cached request prefix.
        if (sheets.length >= 4) for (const sheet of sheets.slice(0, -2)) {
          if (sheet.role !== 'toolResult') continue;
          this.omitted.add(sheet.toolCallId);
          trimmed++;
        }
      }
    }
    if (!this.omitted.size) return { messages, trimmed };
    const note = this.mode === 'renderer'
      ? '旧预览的附图已移出上下文。保留检查结论和文件路径，需要时可重新打开。'
      : '旧检查的附图已移出上下文。保留文字结论和文件路径，需要时可用 read 重新打开。';
    return {
      trimmed,
      messages: messages.map(message => {
        if (message.role !== 'toolResult' || !this.omitted.has(message.toolCallId)) return message;
        return { ...message, content: [
          ...message.content.filter(c => c.type !== 'image'),
          { type: 'text' as const, text: note },
        ] };
      }),
    };
  }
}
