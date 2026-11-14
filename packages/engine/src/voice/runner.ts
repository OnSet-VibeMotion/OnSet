import { abortReason, start } from '../procgroup';
import { findOptional } from '../toolpath';
import { MissingError } from '../prereq';

/** 所有配音调用共用进程边界：不经 shell，取消时停止整棵进程树。 */
export async function runVoice(command: string, args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = findOptional(command, env);
  if (!file) throw new MissingError('配音工具 ' + command);
  const started = await start(file, args, { env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  let tail = '';
  // ElevenLabs / 腾讯的音频在 JSON 里；允许长音频，但不给失控进程无限占用内存。
  started.child.stdout!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 128 * 1024 * 1024) chunks.push(chunk);
    else overflow = true;
  });
  started.child.stderr!.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-4000); });
  try {
    await started.wait();
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    // 不把 provider 输出直接送回对话：部分 CLI 会在错误中回显认证信息。
    const diagnostic = tail.replace(/(?:Bearer\s+|(?:sk|ak)-)[\w.-]+/gi, '[redacted]').replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,]+/gi, '$1[redacted]');
    throw new Error(`配音服务调用失败：${command}${diagnostic ? '：' + diagnostic.trim().split('\n').slice(-3).join(' ') : ''}`, { cause: error });
  }
  signal?.throwIfAborted();
  if (overflow) throw new Error('配音服务返回内容超过 128 MB，请按完整段落分组合成');
  return Buffer.concat(chunks).toString('utf8');
}
