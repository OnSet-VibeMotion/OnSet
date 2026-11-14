// 渲染器会话续接的真实 CLI 测试（scene/resume.ts 的第二层靠它）：每家用渲染时的同一份命令行（tools.rendererInvocation）
// 开会话让它记一个词，再按会话号续接问它，答对且会话号不变才算续上了。每次都是真实模型调用，CI 不跑：
//
//   ONSET_TEST_RENDERER_RESUME=claude,codex,codebuddy,opencode npx vitest run --root packages/engine src/scene -t RealRendererResume
//
// opencode 默认模型不可用时加 ONSET_TEST_OPENCODE_MODEL；qoder 渲染时套系统沙箱，见 sandbox.test.ts 与 AGENTS.md。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KindSession, KindText, newParser } from '../agentrun';
import { lookPath } from '../envutil';
import { presetSessionID, rendererInvocation, type RendererSession } from '../tools';

const tools = (process.env.ONSET_TEST_RENDERER_RESUME ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

describe.skipIf(tools.length === 0)('RealRendererResume', () => {
  for (const tool of tools) {
    it(tool, () => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-resume-')));
      const env = { ...(process.env as Record<string, string>) };
      const model = tool === 'opencode' ? (process.env.ONSET_TEST_OPENCODE_MODEL ?? '') : '';
      const ask = (prompt: string, session: RendererSession | null) => {
        const argv = rendererInvocation(tool, prompt, false, {}, model, session);
        argv[0] = lookPath(argv[0], env.PATH ?? '');
        const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env, encoding: 'utf8', timeout: 240000, input: '' });
        const parser = newParser(tool);
        let id = '';
        let text = '';
        for (const line of (r.stdout ?? '').split('\n')) {
          for (const e of parser.parse(line)) {
            if (e.kind === KindSession && e.session_id) id = e.session_id;
            if (e.kind === KindText) text += e.text ?? '';
          }
        }
        return { status: r.status, id, text };
      };
      const first = ask('Remember the word PINEAPPLE-42 for later. Reply only OK.', presetSessionID(tool) ? { id: crypto.randomUUID(), resume: false } : null);
      expect(first.status, tool).toBe(0);
      expect(first.id, '读不到会话号就续不上').not.toBe('');
      const again = ask('What was the word I asked you to remember? Reply with the word only.', { id: first.id, resume: true });
      expect(again.status, tool).toBe(0);
      expect(again.id).toBe(first.id);
      expect(again.text).toContain('PINEAPPLE-42');
    }, 600000);
  }
});
