import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import { stageAgyMcp, stageMcodeMcp } from '../scene';
import { onsetToolsServer, rendererEnv, rendererInvocation } from '../tools';
import { KindError, KindText, KindToolCall, newSessionID, run } from './index';

/**
 * 对真实 CLI 验证 onset 的工具服务（onset studio tools-mcp）：编排工具与渲染器都能列出并调用 onset 的工具，
 * 而且不用审批。每次都是真实的模型调用，只在设置 ONSET_TEST_TOOLS_MCP 时运行，例如
 *
 *   npm run build -w @onset/cli
 *   ONSET_TEST_TOOLS_MCP=claude,codex,qoder,qoder-intl,codebuddy,opencode,mcode npx vitest run --root packages/engine src/agentrun -t RealToolsMCP
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
  // Windows 客户端把 cjs 入口交给 onsetCommand，不使用不可执行的 sh shim。
  if (process.platform === 'win32') return { project, onset: onsetCjs };
  const onset = path.join(project, '.onset-test-shim');
  fs.writeFileSync(onset, `#!/bin/sh\nexec '${process.execPath}' '${onsetCjs}' "$@"\n`, { mode: 0o755 });
  return { project, onset };
}

describe('RealToolsMCP', () => {
  // 国内版与国际版的设置写法相同，各跑一遍。
  for (const qoder of ['qoder', 'qoder-intl']) it.skipIf(!list.split(',').map((t) => t.trim()).includes(qoder))(`${qoder} keeps scene code intact while editing the brief`, { timeout: 5 * 60_000 }, async () => {
    const { project, onset } = fixture();
    const scene = path.join(project, 'scenes', 'scene-001');
    const shared = path.join(project, 'production', 'shared');
    fs.mkdirSync(scene, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(scene, 'main.js'), '/* keep scene code */\n');
    fs.writeFileSync(path.join(shared, 'shell.js'), '/* keep shared code */\n');
    const env = testEnv(qoder);
    const calls: string[] = [];
    try {
      const { error } = await run({
        tool: qoder, workdir: project, env,
        sessionID: newSessionID(qoder),
        toolsServer: onsetToolsServer(onset, 'orchestrator', project, env),
        prompt: '这是临时项目中的文件权限回归检查。只用 Read、Write、Edit 工具，不用 Bash 或脚本。先把 scenes/scene-001/prompt.md 写成 BRIEF_OK，再尝试把 scenes/scene-001/main.js 和 production/shared/shell.js 改成 /* changed */，再尝试创建 scenes/scene-001/new.js，内容 /* new */。任何操作被拒绝就记录并继续下一项，不绕过权限。最后只总结各项结果。',
      }, (event) => {
        if (event.kind === KindToolCall) calls.push(`${event.tool} ${JSON.stringify(event.input ?? {})}`);
      }, AbortSignal.timeout(4 * 60_000));
      console.log(`${qoder} 文件权限检查：` + calls.map((c) => c.slice(0, 180)).join('\n'));
      expect(error).toBeNull();
      expect(fs.readFileSync(path.join(scene, 'prompt.md'), 'utf8').trim()).toBe('BRIEF_OK');
      expect(fs.readFileSync(path.join(scene, 'main.js'), 'utf8')).toBe('/* keep scene code */\n');
      expect(fs.readFileSync(path.join(shared, 'shell.js'), 'utf8')).toBe('/* keep shared code */\n');
      expect(fs.existsSync(path.join(scene, 'new.js'))).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

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
      const callHyperFrames = process.platform === 'win32' && tool === 'codex';
      const prompt = callHyperFrames
        ? '调用 onset 工具服务里的 hyperframes 工具读取 GSAP 文档（参数 subcommand 填 "docs"，args 填 ["gsap"]），然后只回复 DONE。不要跑 shell。'
        : '调用 onset 工具服务里的 tool_help 工具查 hyperframes（参数 tool 填 "hyperframes"），然后只回复 DONE。';
      const argv = rendererInvocation(tool, prompt, false, access);
      const unstage = tool === 'agy' ? stageAgyMcp(project, access.toolsServer) : tool === 'mcode' ? stageMcodeMcp(project, access.toolsServer) : () => {};
      let ran;
      try {
        ran = spawnSync(argv[0], argv.slice(1), { cwd: project, env: { ...env, ...rendererEnv(tool, access, env) }, encoding: 'utf8', timeout: 10 * 60_000 });
      } finally {
        unstage();
      }
      const out = `${ran.stdout}\n${ran.stderr}`;
      console.log(`${tool} 渲染器：退出码 ${ran.status}，调用了 tool_help：${out.includes('tool_help')}`);
      if (ran.status !== 0) console.log(`${tool} 渲染器输出：${out.slice(0, 3000)}`);
      expect(ran.status, `${tool} 渲染器退出码`).toBe(0);
      if (callHyperFrames) {
        const calls = ran.stdout.split('\n').flatMap((line) => {
          try { return [JSON.parse(line) as { type?: string; item?: { type?: string; tool?: string; status?: string; error?: unknown; result?: { isError?: boolean } } }]; } catch { return []; }
        });
        const completed = calls.find((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.tool === 'hyperframes');
        expect(completed?.item?.status, 'HyperFrames 必须实际执行成功，不能只列出帮助或在审批失败后回复 DONE').toBe('completed');
        expect(completed?.item?.error).toBeNull();
        expect(completed?.item?.result?.isError).not.toBe(true);
        expect(out).not.toContain('MCP tool call requires approval');
      } else {
        expect(out, `${tool} 渲染器没有调用 tool_help`).toContain('tool_help');
      }
    }
  });
});
