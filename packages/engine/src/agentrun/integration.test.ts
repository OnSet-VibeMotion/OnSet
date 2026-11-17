import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import { KindError, KindText, newSessionID, run, type Result } from './index';

/**
 * 对真实 CLI 跑两轮：第一轮记住一个词，第二轮续接后问它。
 *
 * 每次都是真实的模型调用，所以只在设置 ONSET_TEST_AGENT_TOOLS 时运行，例如
 *
 *   ONSET_TEST_AGENT_TOOLS=claude,codex,qoder,qoder-intl,codebuddy,opencode,mcode npx vitest run src/agentrun -t RealCLI
 *
 * 改了某个工具的调用参数或解析器之后，要在本机对它跑一遍。
 */
const list = process.env.ONSET_TEST_AGENT_TOOLS ?? '';

describe('RealCLI resume', () => {
  it.skipIf(list === '')('runs two turns per tool', { timeout: 20 * 60_000 }, async () => {
    for (const raw of list.split(',')) {
      const tool = raw.trim();
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-agentrun-'));
      const signal = AbortSignal.timeout(10 * 60_000);
      const turn = async (prompt: string, session: string, resume: boolean): Promise<[Result, string]> => {
        let text = '';
        const { result, error } = await run(
          { tool, workdir, prompt, sessionID: session, resume, env: envMap() },
          (event) => {
            if (event.kind === KindText) text += event.text ?? '';
            if (event.kind === KindError) console.log(`${tool} 错误事件：${event.text}`);
          },
          signal,
        );
        if (error) throw new Error(`${tool}：${error.message}（stderr：${result.stderr}）`);
        return [result, text];
      };
      const [first] = await turn('记住单词 PELICAN，只回复 OK。', newSessionID(tool), false);
      expect(first.sessionID, `${tool} 没有拿到会话 id`).not.toBe('');
      const [second, answer] = await turn('我让你记住的单词是什么？只回复单词。', first.sessionID, true);
      expect(second.sessionID, `${tool} 续接后会话 id 变了`).toBe(first.sessionID);
      expect(answer.toUpperCase(), `${tool} 续接没有带上上下文`).toContain('PELICAN');
    }
  });
});
