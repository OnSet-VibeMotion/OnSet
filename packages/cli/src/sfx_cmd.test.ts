import fs from 'node:fs';
import path from 'node:path';
import { BuiltinAssetsRelDir, BuiltinManifestFile } from '@onset/engine/baseassets';
import { FreesoundApiKeyEnv } from '@onset/engine/freesound';
import { describe, expect, it } from 'vitest';
import { findOp, normalizeParams, TextSink } from './ops/op';
import { tempDir } from './testutil';
import { describeTools } from './toolsmcp';

const SfxAndBaseOps = ['assets_generate_base', 'sfx_search', 'sfx_download'] as const;

describe('sfx_cmd operations and MCP exposure', () => {
  it('exposes base assets & sfx tools only to orchestrator and never to renderer', () => {
    const orchestratorNames = describeTools('orchestrator').map((t) => t.name);
    const rendererNames = describeTools('renderer').map((t) => t.name);
    for (const name of SfxAndBaseOps) {
      expect(orchestratorNames, `编排端应暴露 ${name}`).toContain(name);
      expect(rendererNames, `渲染器严禁暴露 ${name}`).not.toContain(name);
    }
  });

  it('executes assets_generate_base op and writes deterministic builtin assets', async () => {
    const project = tempDir();
    const op = findOp('assets_generate_base')!;
    expect(op).toBeDefined();
    const out = new TextSink();
    const res = await op.run(normalizeParams(op, { project_root: project }), {
      out,
      err: new TextSink(),
      signal: new AbortController().signal,
      unsafe: false,
    });
    expect(out.text).toContain('新建 5');
    expect(fs.existsSync(path.join(project, BuiltinAssetsRelDir, 'paper.svg'))).toBe(true);
    expect(fs.existsSync(path.join(project, BuiltinAssetsRelDir, 'whoosh.wav'))).toBe(true);
    expect(fs.existsSync(path.join(project, BuiltinAssetsRelDir, BuiltinManifestFile))).toBe(true);
    expect((res as { data?: { created_count?: number } })?.data?.created_count).toBe(5);
  });

  it('fails clearly when FREESOUND_API_KEY is missing in sfx_search and sfx_download', async () => {
    const prev = process.env[FreesoundApiKeyEnv];
    delete process.env[FreesoundApiKeyEnv];
    try {
      const searchOp = findOp('sfx_search')!;
      const downloadOp = findOp('sfx_download')!;
      const ctx = () => ({
        out: new TextSink(),
        err: new TextSink(),
        signal: new AbortController().signal,
        unsafe: false,
      });

      await expect(searchOp.run(normalizeParams(searchOp, { query: 'whoosh' }), ctx())).rejects.toThrow(
        new RegExp(FreesoundApiKeyEnv),
      );
      await expect(
        downloadOp.run(normalizeParams(downloadOp, { sound_id: 123, project_root: tempDir() }), ctx()),
      ).rejects.toThrow(new RegExp(FreesoundApiKeyEnv));
    } finally {
      if (prev !== undefined) process.env[FreesoundApiKeyEnv] = prev;
    }
  });
});
