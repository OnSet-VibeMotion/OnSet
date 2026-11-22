import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { marshal } from '../gojson';
import { stageAgyMcp } from './run';

// Antigravity CLI headless 模式从工作区 .agents/mcp_config.json 读 MCP：渲染期间放一份，渲染完删掉；别人的配置不覆盖。
describe('stageAgyMcp', () => {
  const server = { name: 'onset', command: '/bin/onset', args: ['studio', 'tools-mcp', '--profile', 'renderer'], env: { ONSET_X: '1' } };

  it('writes the renderer tools server with eager tools and cleans up afterwards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-agy-mcp-'));
    const file = path.join(dir, '.agents', 'mcp_config.json');
    try {
      const done = stageAgyMcp(dir, server);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(parsed.mcpServers.onset).toMatchObject({
        command: '/bin/onset',
        args: server.args,
        env: { ONSET_X: '1' },
        timeoutSeconds: 720,
        tools: {
          hyperframes: { eager: true },
          scene_preview_check: { eager: true },
          job_wait: { eager: true },
          job_cancel: { eager: true },
          tool_help: { eager: true },
        },
      });
      done();
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(path.join(dir, '.agents'))).toBe(false);
      // 上次没删干净的那份照样换掉。
      fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
      fs.writeFileSync(file, marshal({ mcpServers: { onset: { command: 'old', args: ['studio', 'tools-mcp'] } } }));
      stageAgyMcp(dir, server)();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a user mcp_config.json or symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-agy-mcp-'));
    try {
      fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
      const file = path.join(dir, '.agents', 'mcp_config.json');
      fs.writeFileSync(file, '{"mcpServers":{"mine":{"command":"x"}}}');
      expect(() => stageAgyMcp(dir, server)).toThrow('已有');
      expect(fs.readFileSync(file, 'utf8')).toContain('mine');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
