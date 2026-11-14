import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { envMap } from '../envutil';
import { run, type Event } from './index';

const tools = (process.env.ONSET_TEST_BACKGROUND_TOOLS ?? '').split(',').filter(Boolean);

it.skipIf(tools.length === 0)('RealBackgroundTasks reports a live child and its completion', { timeout: 10 * 60_000 }, async () => {
  for (const tool of tools) {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-background-'));
    const events: Event[] = [];
    const raw: string[] = [];
    const env = envMap();
    if (tool === 'opencode' && process.env.ONSET_TEST_OPENCODE_MODEL) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: process.env.ONSET_TEST_OPENCODE_MODEL });
    try {
      const outcome = await run({
        tool, workdir, env,
        prompt: '请实际调用子 Agent 工具，启动一个子 Agent 计算 17×19，不读写文件、不运行命令。若支持后台参数请在后台运行，等待它完成后回复结果。',
        ask: async () => ({ decision: 'deny', message: '本测试不需要运行命令或修改文件' }),
        raw: { write: (line) => raw.push(line) },
      }, (event) => events.push(event), AbortSignal.timeout(120_000));
      // 只在显式指定时留原始流，方便核对真实工具的协议；不写到用户项目或 HOME。
      if (process.env.ONSET_TEST_BACKGROUND_LOG) fs.writeFileSync(path.join(process.env.ONSET_TEST_BACKGROUND_LOG, tool + '.jsonl'), raw.join(''));
      expect(outcome.error, tool).toBeNull();
      const snapshots = events.filter((event) => event.kind === 'background-tasks');
      expect(snapshots.some((event) => (event.background_tasks?.length ?? 0) > 0), `${tool} 没有报告子任务`).toBe(true);
      expect(snapshots.at(-1)?.background_tasks, `${tool} 子任务没有结束`).toEqual([]);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
});
