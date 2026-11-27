import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import './filmstyle';
import './filmstyle_refs_cmd';
import { Command, ref } from './cobra';
import { opCommand } from './ops/cli';
import { allOps } from './ops/op';
import { Buffer, tempDir } from './testutil';
import { describeToolCatalog } from './toolsmcp';

async function runFilmStyle(root: string, ...args: string[]): Promise<{ out: string; err: Error | null }> {
  const out = new Buffer();
  const cmd = new Command({ use: 'film-style' });
  for (const op of allOps().filter((o) => o.cli[0] === 'film-style')) {
    cmd.addCommand(opCommand(op, out, out, ref(false)));
  }
  cmd.setOut(out);
  cmd.setErr(out);
  try {
    await cmd.execute([...args, '--project-root', root]);
    return { out: out.text, err: null };
  } catch (err) {
    return { out: out.text, err: err as Error };
  }
}

describe('mg-styles & film_style_refs CLI/MCP', () => {
  it('exposes film_style_refs as an instant orchestrator MCP tool', () => {
    const tool = describeToolCatalog('orchestrator').all.find((t) => t.name === 'film_style_refs');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).not.toHaveProperty('wait_seconds');
  });

  it('lists, uses, shows mg-styles and queries offline refs cleanly', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), '');

    const listed = await runFilmStyle(root, 'list', '--source', 'mg-styles', '--json');
    expect(listed.err).toBeNull();
    const styles = JSON.parse(listed.out) as { slug: string }[];
    expect(styles).toHaveLength(15);

    const used = await runFilmStyle(root, 'use', 'mg-styles/03-isometric');
    expect(used.err, used.out).toBeNull();
    expect(used.out).toContain('等轴三维积木');

    const shown = await runFilmStyle(root, 'show', '--json');
    expect(shown.err).toBeNull();
    const showData = JSON.parse(shown.out) as { installed: boolean; style: { source: string; slug: string } };
    expect(showData.installed).toBe(true);
    expect(showData.style).toMatchObject({ source: 'mg-styles', slug: '03-isometric' });

    // 未配置参考帧目录时优雅降级
    const savedEnv = process.env.ONSET_FILM_STYLE_REFS_DIR;
    delete process.env.ONSET_FILM_STYLE_REFS_DIR;
    try {
      const missing = await runFilmStyle(root, 'refs', '--json');
      expect(missing.err).toBeNull();
      expect(JSON.parse(missing.out)).toMatchObject({ available: false, slug: '03-isometric', frames: [] });
    } finally {
      if (savedEnv !== undefined) process.env.ONSET_FILM_STYLE_REFS_DIR = savedEnv;
    }

    // 传入本地临时参考帧目录 + manifest.json 校验通过
    const refsDir = tempDir();
    const slugDir = path.join(refsDir, '03-isometric');
    fs.mkdirSync(slugDir, { recursive: true });
    const payload = globalThis.Buffer.from('iso-frame-data');
    fs.writeFileSync(path.join(slugDir, 'frame-01.png'), payload);
    fs.writeFileSync(
      path.join(slugDir, 'manifest.json'),
      JSON.stringify({ 'frame-01.png': crypto.createHash('sha256').update(payload).digest('hex') }),
    );
    const ok = await runFilmStyle(root, 'refs', 'mg-styles/03-isometric', '--refs-dir', refsDir, '--json');
    expect(ok.err, ok.out).toBeNull();
    const refData = JSON.parse(ok.out) as { available: boolean; frames: { file: string; verified: boolean }[] };
    expect(refData.available).toBe(true);
    expect(refData.frames[0]).toMatchObject({ file: 'frame-01.png', verified: true });
  });
});
