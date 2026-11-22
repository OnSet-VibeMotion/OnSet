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
      const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant');
      const response = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined;
      const u = response?.role === 'assistant' ? response.usage : undefined;
      const used = u ? u.input + u.cacheRead + u.cacheWrite + u.output : 0;
      if (used >= threshold) {
        const sheets: Array<{ index: number; msg: Message }> = [];
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (this.isCompactable(m)
            && m.role === 'toolResult'
            && !this.omitted.has(m.toolCallId)
            && m.content.some(c => c.type === 'image')) {
            sheets.push({ index: i, msg: m });
          }
        }
        // 保留最后一条 assistant 回复之后产生的全部未送入模型的图片，只淘汰已经交付给模型的旧图片。
        const older = lastAssistantIndex >= 0 ? sheets.filter(s => s.index < lastAssistantIndex) : sheets;
        const unseenCount = sheets.length - older.length;
        if (sheets.length >= 4 && older.length > 0) {
          const toDrop = unseenCount > 0 ? older : older.slice(0, -1);
          for (const { msg: sheet } of toDrop) {
            if (sheet.role !== 'toolResult') continue;
            this.omitted.add(sheet.toolCallId);
            trimmed++;
          }
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
