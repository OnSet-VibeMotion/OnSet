import type { MessageEndEvent } from '@earendil-works/pi-coding-agent';

type Message = MessageEndEvent['message'];

/** Drop old preview images at a preview boundary, retaining results, paths and recent visual evidence. */
export class PreviewHistory {
  private readonly omitted = new Set<string>();

  project(messages: Message[], threshold: number): { messages: Message[]; trimmed: number } {
    const last = messages.at(-1);
    let trimmed = 0;
    if (last?.role === 'toolResult' && last.toolName === 'scene_preview_check') {
      const response = messages.findLast(m => m.role === 'assistant');
      const u = response?.usage;
      const used = u ? u.input + u.cacheRead + u.cacheWrite + u.output : 0;
      if (used >= threshold) {
        const sheets = messages.filter(m => m.role === 'toolResult' && m.toolName === 'scene_preview_check'
          && !this.omitted.has(m.toolCallId) && m.content.some(c => c.type === 'image'));
        // Make a change only when there's a batch to drop. Each change can break a cached request prefix.
        if (sheets.length >= 4) for (const sheet of sheets.slice(0, -2)) {
          if (sheet.role !== 'toolResult') continue;
          this.omitted.add(sheet.toolCallId);
          trimmed++;
        }
      }
    }
    if (!this.omitted.size) return { messages, trimmed };
    return {
      trimmed,
      messages: messages.map(message => {
        if (message.role !== 'toolResult' || !this.omitted.has(message.toolCallId)) return message;
        return { ...message, content: [
          ...message.content.filter(c => c.type !== 'image'),
          { type: 'text' as const, text: '旧预览的附图已移出上下文。保留检查结论和文件路径，需要时可重新打开。' },
        ] };
      }),
    };
  }
}
