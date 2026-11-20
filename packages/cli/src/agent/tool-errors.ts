import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '@onset/engine/fsutil';
import type { MessageEndEvent } from '@earendil-works/pi-coding-agent';

type AgentMessage = MessageEndEvent['message'];

const maxErrorLength = 4096;

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
