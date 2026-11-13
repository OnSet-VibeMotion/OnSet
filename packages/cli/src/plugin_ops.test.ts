/**
 * 内置插件在 apply 里登记的操作进操作表：工具服务、tool_help、命令行都有，不用改 toolsmcp.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as plugin from '@am/engine/plugin';
import { findOp } from './ops/op';
import { Buffer, run, tempDir } from './testutil';
import { describeTools } from './toolsmcp';

describe('ops registered by builtin plugins', () => {
  it('validate_publish comes from the publishing plugin and still runs', async () => {
    expect(plugin.pluginOps().find((o) => o.value.name === 'validate_publish')?.owner).toBe('publishing');
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'publish.md'), '---\nschema_version: 1\n---\n');
    const out = new Buffer();
    expect(await run(['validate', 'publish', path.join(root, 'publish.md'), '--project-root', root], out)).not.toBe(0);
    expect(out.text).toContain('缺少必填字段：workflow');
  });

  it('a new builtin plugin gets its tool without touching the tool server', () => {
    const undo = plugin.registerBuiltin({
      id: 'fake-echo',
      apply(ctx) {
        ctx.op({
          name: 'fake_echo',
          cli: ['fake-echo'],
          summary: '回显',
          description: '回显 text。',
          examples: ['fake_echo({"text": "hi"})'],
          params: { text: { type: 'string', description: '要回显的字', required: true } },
          run: (p, { out }) => {
            out.write(String(p.text) + '\n');
            return { data: { text: p.text } };
          },
        });
      },
    });
    try {
      expect(findOp('fake_echo')?.summary).toBe('回显');
      const tool = describeTools('orchestrator').find((t) => t.name === 'fake_echo');
      expect(tool?.inputSchema.required).toEqual(['text']);
      expect(tool?.help).toContain('fake_echo({"text": "hi"})');
      // 项目关掉它时工具列表里没有。
      const root = tempDir();
      fs.writeFileSync(path.join(root, 'article-to-motion.flow.json'), JSON.stringify({ version: 1, stations: [], disabled: ['fake-echo'] }));
      expect(describeTools('orchestrator', root).some((t) => t.name === 'fake_echo')).toBe(false);
    } finally {
      undo();
    }
    expect(findOp('fake_echo')).toBeUndefined();
  });

  it('the tool list drops a builtin plugin\'s tools when the project turns it off', () => {
    for (const id of ['song', 'cast', 'publishing']) {
      const names = plugin.pluginOps().filter((o) => o.owner === id).map((o) => o.value.name);
      expect(names.length, id).toBeGreaterThan(0);
      const root = tempDir();
      const listed = describeTools('orchestrator', root).map((t) => t.name);
      for (const name of names) expect(listed, name).toContain(name);
      fs.writeFileSync(path.join(root, 'article-to-motion.flow.json'), JSON.stringify({ version: 1, stations: [], disabled: [id] }));
      const off = describeTools('orchestrator', root).map((t) => t.name);
      for (const name of names) expect(off, name).not.toContain(name);
    }
  });
});
