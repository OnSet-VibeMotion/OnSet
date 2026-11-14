import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import { onsetToolsServer, rendererEnv, rendererInvocation } from '../tools';
import { KindError, KindText, KindToolCall, newSessionID, run } from './index';

/**
 * 对真实 CLI 验证 onset 的工具服务（onset studio tools-mcp）：编排工具与渲染器都能列出并调用 onset 的工具，
 * 而且不用审批。每次都是真实的模型调用，只在设置 ONSET_TEST_TOOLS_MCP 时运行，例如
 *
 *   npm run build -w @onset/cli
 *   ONSET_TEST_TOOLS_MCP=claude,codex,qoder,codebuddy,opencode npx vitest run --root packages/engine src/agentrun -t RealToolsMCP
 *
 * 改了任何一家挂 MCP 的方式（tools.ts、acp.ts、codexapp.ts）之后，要在本机对它跑一遍。
 * opencode 默认模型不可用时用 ONSET_TEST_OPENCODE_MODEL 指定（例如 github-copilot/claude-haiku-4.5）。
 */
const list = process.env.ONSET_TEST_TOOLS_MCP ?? '';
const repo = path.resolve(__dirname, '..', '..', '..', '..');
const onsetCjs = path.join(repo, 'packages', 'cli', 'dist', 'onset.cjs');

/** 测试用的环境：opencode 默认模型不可用时换成 ONSET_TEST_OPENCODE_MODEL。 */
function testEnv(tool: string): Record<string, string> {
  const env = envMap();
  if (tool === 'opencode' && process.env.ONSET_TEST_OPENCODE_MODEL) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: process.env.ONSET_TEST_OPENCODE_MODEL });
  return env;
}

/** 一个带配置的临时项目，加一段调用构建好的 onset.cjs 的启动脚本（代替客户端的私有 shim）。 */
function fixture(): { project: string; onset: string } {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-toolsmcp-')));
  // 答案放在 .env 里：agent 读不到 .env（安全模式禁读），只有真的调了 config_get 才答得出 tencent。
  fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\nTTS_PROVIDER=edge\n');
  fs.writeFileSync(path.join(project, '.env'), 'TTS_PROVIDER=tencent\n');
  const onset = path.join(project, '.onset-test-shim');
  fs.writeFileSync(onset, `#!/bin/sh\nexec '${process.execPath}' '${onsetCjs}' "$@"\n`, { mode: 0o755 });
  return { project, onset };
}

describe('RealToolsMCP', () => {
  it.skipIf(list === '')('orchestrators call onset tools without approval', { timeout: 30 * 60_000 }, async () => {
    for (const raw of list.split(',')) {
      const tool = raw.trim();
      const { project, onset } = fixture();
      const env = testEnv(tool);
      let text = '';
      const calls: string[] = [];
      const asked: string[] = [];
      const { error } = await run(
        {
          tool,
          workdir: project,
          prompt: '调用 onset 工具服务里的 config_get 工具查询 TTS_PROVIDER（参数 key 填 "TTS_PROVIDER"），只回复它返回的值，不要做别的。',
          sessionID: newSessionID(tool),
          env,
          toolsServer: onsetToolsServer(onset, 'orchestrator', project, env),
          // 客户端里的路径：给了 ask，codebuddy / opencode / codex 走双向协议。onset 的工具不该来问。
          ask: async (name) => {
            asked.push(name);
            return { decision: 'deny', message: '测试里不批准' };
          },
        },
        (event) => {
          if (event.kind === KindText) text += event.text ?? '';
          // codebuddy 经自己的 DeferExecuteTool 调用延后加载的工具，工具名写在输入里：一起记下。
          if (event.kind === KindToolCall) calls.push(`${String(event.tool ?? '')} ${JSON.stringify(event.input ?? {})}`);
          if (event.kind === KindError) console.log(`${tool} 错误事件：${event.text}`);
          if (process.env.ONSET_TEST_TOOLS_MCP_VERBOSE && (event.kind === KindToolCall || event.kind === 'tool_result')) console.log(`${tool} 事件：${JSON.stringify(event).slice(0, 400)}`);
        },
        AbortSignal.timeout(10 * 60_000),
      );
      console.log(`${tool}：调用 ${JSON.stringify(calls)}，问过 ${JSON.stringify(asked)}，回复 ${JSON.stringify(text.trim().slice(0, 80))}`);
      expect(error, `${tool} 出错`).toBeNull();
      // 不按调用名判断：opencode 经自己的代码执行工具（execute）调 MCP，codebuddy 经 DeferExecuteTool。答案只有工具给得出。
      expect(asked, `${tool} 要了审批`).toEqual([]);
      expect(text.toLowerCase(), `${tool} 没答对（调用：${calls.join(', ')}）`).toContain('tencent');
    }
  });

  it.skipIf(list === '')('renderers reach the HyperFrames tool', { timeout: 30 * 60_000 }, () => {
    for (const raw of list.split(',')) {
      const tool = raw.trim();
      const { project, onset } = fixture();
      const env = testEnv(tool);
      const access = { commands: ['ls'], toolsServer: onsetToolsServer(onset, 'renderer', project, env) };
      const argv = rendererInvocation(tool, '调用 onset 工具服务里的 tool_help 工具查 hyperframes（参数 tool 填 "hyperframes"），然后只回复 DONE。', false, access);
      const ran = spawnSync(argv[0], argv.slice(1), { cwd: project, env: { ...env, ...rendererEnv(tool, access, env) }, encoding: 'utf8', timeout: 10 * 60_000 });
      const out = `${ran.stdout}\n${ran.stderr}`;
      console.log(`${tool} 渲染器：退出码 ${ran.status}，调用了 tool_help：${out.includes('tool_help')}`);
      if (ran.status !== 0) console.log(`${tool} 渲染器输出：${out.slice(0, 3000)}`);
      expect(ran.status, `${tool} 渲染器退出码`).toBe(0);
      expect(out, `${tool} 渲染器没有调用 tool_help`).toContain('tool_help');
    }
  });
});
