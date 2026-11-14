// 把 agentrun 的统一事件整理成终端里的可读文字。
import * as agentrun from '@onset/engine/agentrun';
import { formatFixed } from '@onset/engine/gofmt';
import type { Out } from './cobra';

export const summaryLimit = 160;

export class EventPrinter {
  constructor(
    private readonly stdout: Out,
    private readonly stderr: Out,
  ) {}

  print(event: agentrun.Event): void {
    switch (event.kind) {
      case agentrun.KindSession:
        this.stdout.write(`会话: ${event.session_id ?? ''}\n`);
        break;
      case agentrun.KindText:
        this.stdout.write((event.text ?? '').replace(/\n+$/, '') + '\n');
        break;
      case agentrun.KindToolCall:
        this.stdout.write(`→ ${event.tool ?? ''} ${toolSummary(event.input)}\n`);
        break;
      case agentrun.KindToolResult:
        if (event.is_error) this.stdout.write(`  ✗ ${firstLine(event.text ?? '')}\n`);
        break;
      case agentrun.KindPlan: {
        const marks: Record<string, string> = { completed: '✓', in_progress: '→', pending: '·' };
        this.stdout.write('计划：\n');
        for (const item of event.plan ?? []) this.stdout.write(`  ${marks[item.status] ?? ''} ${item.text}\n`);
        break;
      }
      case agentrun.KindError:
        this.stderr.write(`错误: ${event.text ?? ''}\n`);
        break;
      case agentrun.KindUsage: {
        const u = event.usage ?? {};
        let line = `用量: 输入 ${u.input_tokens ?? 0}（缓存 ${u.cached_input_tokens ?? 0}）/ 输出 ${u.output_tokens ?? 0}`;
        if (u.cost_usd !== undefined && u.cost_usd !== null) line += ` / $${formatFixed(u.cost_usd, 4)}`;
        this.stdout.write(line + '\n');
        break;
      }
    }
  }
}

/** 从工具输入里挑最能说明「做了什么」的一个字段。 */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const fields = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'filePath', 'pattern', 'url', 'description']) {
    const value = fields[key];
    if (typeof value === 'string' && value !== '') return truncate(firstLine(value));
  }
  return '';
}

export function firstLine(text: string): string {
  const trimmed = text.trim();
  const index = trimmed.indexOf('\n');
  return index >= 0 ? truncate(trimmed.slice(0, index)) + ' …' : truncate(trimmed);
}

export function truncate(text: string): string {
  const runes = [...text];
  return runes.length <= summaryLimit ? text : runes.slice(0, summaryLimit).join('') + '…';
}
