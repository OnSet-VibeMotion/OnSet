// 渲染器会话续接的真实 CLI 测试（scene/resume.ts 的第二层靠它）：每家用渲染时的同一份命令行（tools.rendererInvocation）
// 开会话让它记一个词，再按会话号续接问它，答对且会话号不变才算续上了。每次都是真实模型调用，CI 不跑：
//
//   ONSET_TEST_RENDERER_RESUME=claude,codex,codebuddy,opencode,mcode npx vitest run --root packages/engine src/scene -t RealRendererResume
//
// opencode 默认模型不可用时加 ONSET_TEST_OPENCODE_MODEL；qoder 渲染时套系统沙箱，见 sandbox.test.ts 与 AGENTS.md。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KindSession, KindText, newParser } from '../agentrun';
import { envMap, lookPath } from '../envutil';
import { windowsCommand } from '../procgroup/windows';
import { presetSessionID, rendererInvocation, windowsPromptInput, type RendererSession } from '../tools';

const tools = (process.env.ONSET_TEST_RENDERER_RESUME ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

describe.skipIf(tools.length === 0)('RealRendererResume', () => {
  for (const tool of tools) {
    it(tool, () => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-resume-')));
      const env = envMap();
      const model = tool === 'opencode' ? (process.env.ONSET_TEST_OPENCODE_MODEL ?? '') : '';
      const ask = (prompt: string, session: RendererSession | null) => {
        const argv = rendererInvocation(tool, prompt, false, process.platform === 'win32' ? { unfiltered: true } : {}, model, session);
        argv[0] = lookPath(argv[0], env.PATH ?? '');
        const input = windowsPromptInput(tool, argv, prompt);
        const command = process.platform === 'win32' ? windowsCommand(input.argv[0], input.argv.slice(1), env) : { file: input.argv[0], args: input.argv.slice(1), env: {}, verbatim: false };
        const r = spawnSync(command.file, command.args, { cwd: dir, env: { ...env, ...command.env }, windowsVerbatimArguments: command.verbatim, windowsHide: true, encoding: 'utf8', timeout: 240000, input: input.stdin });
        const parser = newParser(tool);
        let id = '';
        let text = '';
        for (const line of (r.stdout ?? '').split('\n')) {
          for (const e of parser.parse(line)) {
            if (e.kind === KindSession && e.session_id) id = e.session_id;
            if (e.kind === KindText) text += e.text ?? '';
          }
        }
        return { status: r.status, id, text, error: r.error?.message || r.stderr || '' };
      };
      const first = ask('Remember the word PINEAPPLE-42 for later. Reply only OK.', presetSessionID(tool) ? { id: crypto.randomUUID(), resume: false } : null);
      expect(first.status, tool + ': ' + first.error).toBe(0);
      expect(first.id, '读不到会话号就续不上').not.toBe('');
      const again = ask('What was the word I asked you to remember? Reply with the word only.', { id: first.id, resume: true });
      expect(again.status, tool + ': ' + again.error).toBe(0);
      expect(again.id).toBe(first.id);
      expect(again.text).toContain('PINEAPPLE-42');
    }, 600000);
  }
});
