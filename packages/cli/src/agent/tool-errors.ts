import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '@onset/engine/fsutil';
import type { MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { toolOutputArchiveDir } from '../output_archive';

export { toolOutputArchiveDir };

type AgentMessage = MessageEndEvent['message'];

const maxErrorLength = 4096;
const maxBashOutputLength = 4096;

/** Preserve complete diagnostics locally without echoing entire tool inputs to the model. */
export function compactToolError(message: AgentMessage, agentDir: string): AgentMessage {
  if (message.role !== 'toolResult' || !message.isError) return message;
  const raw = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  if (raw.length <= maxErrorLength) return message;

  const hash = createHash('sha256').update(message.toolCallId).update('\0').update(raw).digest('hex');
  const dir = path.resolve(agentDir, 'tool-errors');
  const file = path.join(dir, hash + '.log');
  let suffix: string;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) atomicWrite(file, raw + '\n', 0o600);
    suffix = '\n… 错误已截短。完整诊断保存在本机应用数据目录：' + file;
  } catch {
    // Keep the original message in the session if the diagnostic cannot be archived.
    return message;
  }
  const text = raw.slice(0, Math.max(0, maxErrorLength - suffix.length)) + suffix.slice(0, maxErrorLength);
  return { ...message, content: [{ type: 'text', text }, ...message.content.filter(block => block.type !== 'text')] };
}

/**
 * 截短过长的工具返回：报错走 compactToolError，成功的超长 bash 输出落盘保留首尾。
 * 2026-11 实测：单镜成功 bash 输出累计超 1MB（含 22KB 字符画），整段留在上下文里每轮重复计费。
 */
export function compactToolResult(message: AgentMessage, agentDir: string, outputDir = toolOutputArchiveDir()): AgentMessage {
  if (message.role !== 'toolResult') return message;
  if (message.isError) return compactToolError(message, agentDir);
  if (message.toolName !== 'bash') return message;
  const raw = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  if (raw.length <= maxBashOutputLength) return message;

  const hash = createHash('sha256').update(message.toolCallId).update('\0').update(raw).digest('hex');
  const dir = path.resolve(outputDir);
  const file = path.join(dir, hash + '.log');
  let middle: string;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) atomicWrite(file, raw + '\n', 0o600);
    middle = `\n… 输出过长（共 ${raw.length} 字符，已省略中间部分）。完整输出保存在：${file} …\n`;
  } catch {
    return message;
  }
  const budget = Math.max(0, maxBashOutputLength - middle.length);
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  const text = (head > 0 ? raw.slice(0, head) : '') + middle.slice(0, maxBashOutputLength) + (tail > 0 ? raw.slice(-tail) : '');
  return { ...message, content: [{ type: 'text', text }, ...message.content.filter(block => block.type !== 'text')] };
}
