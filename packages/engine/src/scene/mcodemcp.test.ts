import { marshal } from '../gojson';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stageMcodeMcp } from './run';

// mcode exec 只从工作目录的 .mcp.json 读 MCP：渲染期间放一份，渲染完删掉；别人的 .mcp.json 不覆盖。
describe('stageMcodeMcp', () => {
  const server = { name: 'onset', command: '/bin/onset', args: ['studio', 'tools-mcp', '--profile', 'renderer'], env: { ONSET_X: '1' } };
  it.skipIf(process.platform === 'win32').each([false, true])('refuses a symlink even when its target exists: %s', (exists) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mcode-mcp-'));
    const scene = path.join(dir, 'scene');
    fs.mkdirSync(scene);
    const target = path.join(dir, 'outside.json');
    const content = marshal({ mcpServers: { onset: { args: ['tools-mcp'] } } });
    if (exists) fs.writeFileSync(target, content);
    fs.symlinkSync(target, path.join(scene, '.mcp.json'));
    try {
      expect(() => stageMcodeMcp(scene, server)).toThrow('符号链接');
      expect(fs.existsSync(target)).toBe(exists);
      if (exists) expect(fs.readFileSync(target, 'utf8')).toBe(content);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves unreadable existing configuration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mcode-mcp-'));
    const file = path.join(dir, '.mcp.json');
    fs.writeFileSync(file, 'private config');
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((name: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (name === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (read as Function)(name, ...args);
    }) as typeof fs.readFileSync);
    try { expect(() => stageMcodeMcp(dir, server)).toThrow('denied'); }
    finally { spy.mockRestore(); }
    expect(fs.readFileSync(file, 'utf8')).toBe('private config');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('writes the tools server for the render and removes it after', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mcode-mcp-'));
    const file = path.join(dir, '.mcp.json');
    const done = stageMcodeMcp(dir, server);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { onset: { command: '/bin/onset', args: server.args, env: { ONSET_X: '1' } } } });
    done();
    expect(fs.existsSync(file)).toBe(false);
    // 上次没删干净的那份照样换掉。
    fs.writeFileSync(file, marshal({ mcpServers: { onset: { command: 'old', args: ['studio', 'tools-mcp'] } } }));
    stageMcodeMcp(dir, server)();
    expect(fs.existsSync(file)).toBe(false);
  });
  it('refuses to overwrite a .mcp.json it did not write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mcode-mcp-'));
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"mine":{"command":"x"}}}');
    expect(() => stageMcodeMcp(dir, server)).toThrow('已有 .mcp.json');
    expect(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toContain('mine');
  });
});
