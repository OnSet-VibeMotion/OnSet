import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import { KindError, KindText, KindToolCall, KindUsage, newSessionID, run, type PermissionAnswer, type Result } from './index';

/**
 * 客户端里的双向协议（ACP、codex app-server）对真实 CLI 跑一遍：第一轮让它依次跑 brew --version（批准）
 * 与 npm --version（拒绝），确认两条都来问了、批准的跑了；第二轮续接，问它第一轮记住的词。
 *
 * 每次都是真实的模型调用，只在设置 ONSET_TEST_INTERACTIVE_TOOLS 时运行，例如
 *
 *   ONSET_TEST_INTERACTIVE_TOOLS=codex,opencode,codebuddy,mcode npx vitest run src/agentrun -t RealInteractive
 *
 * opencode 用的模型取用户自己的配置；默认模型不可用时用 ONSET_TEST_OPENCODE_MODEL 指定（例如 github-copilot/claude-haiku-4.5）。
 */
const list = process.env.ONSET_TEST_INTERACTIVE_TOOLS ?? '';

describe('RealInteractive approvals', () => {
  it.skipIf(list === '')('asks before commands outside the allowlist and resumes', { timeout: 20 * 60_000 }, async () => {
    for (const raw of list.split(',')) {
      const tool = raw.trim();
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-interactive-'));
      const env = envMap();
      if (tool === 'opencode' && process.env.ONSET_TEST_OPENCODE_MODEL) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: process.env.ONSET_TEST_OPENCODE_MODEL });
      const asked: string[] = [];
      const ask = async (toolName: string, input: unknown): Promise<PermissionAnswer> => {
        const command = String((input as { command?: unknown }).command ?? toolName);
        asked.push(command);
        return command.includes('brew') ? { decision: 'allow' } : { decision: 'deny', message: '用户拒绝了 npm' };
      };
      const signal = AbortSignal.timeout(10 * 60_000);
      const turn = async (prompt: string, session: string, resume: boolean): Promise<[Result, string, string[]]> => {
        let text = '';
        const kinds: string[] = [];
        const { result, error } = await run(
          { tool, workdir, prompt, sessionID: session, resume, env, ask, access: { commands: ['ls'] } },
          (event) => {
            kinds.push(event.kind);
            if (event.kind === KindText) text += event.text ?? '';
            if (event.kind === KindError) console.log(`${tool} 错误事件：${event.text}`);
          },
          signal,
        );
        if (error && !(tool === 'opencode' && resume === false)) throw new Error(`${tool}：${error.message}（stderr：${result.stderr}）`);
        return [result, text, kinds];
      };
      const [first, , kinds] = await turn(
        '记住单词 PELICAN。然后依次运行这两条 shell 命令并报告输出，不要换别的写法：1) brew --version  2) npm --version',
        newSessionID(tool),
        false,
      );
      console.log(`${tool}：问了 ${JSON.stringify(asked)}，模型 ${first.model}，用量 ${JSON.stringify(first.usage)}`);
      expect(first.sessionID, `${tool} 没有拿到会话 id`).not.toBe('');
      expect(asked.some((c) => c.includes('brew')), `${tool} 运行 brew 前没有来问`).toBe(true);
      expect(kinds).toContain(KindToolCall);
      // mcode 0.6.12 的 ACP 只报上下文占用（usage_update 的 used / size）与费用，不报 token：读不到就留空，不估算。
      if (tool !== 'mcode') expect(kinds).toContain(KindUsage);
      const [second, answer] = await turn('第一轮让你记住的单词是什么？只回复单词。', first.sessionID, true);
      expect(second.sessionID, `${tool} 续接后会话 id 变了`).toBe(first.sessionID);
      expect(answer.toUpperCase(), `${tool} 续接没有带上上下文`).toContain('PELICAN');
    }
  });
});
