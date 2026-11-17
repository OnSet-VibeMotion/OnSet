import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allOps } from './ops/op';
import { Buffer, run, tempDir } from './testutil';

describe('config_set', () => {
  it('is not a tool the orchestrator can call', () => {
    expect(allOps().find((op) => op.name === 'config_set')?.scopes).toEqual(['cli']);
  });

  it('edits the line in place, keeps comments, and an empty value follows the global settings', async () => {
    const root = tempDir();
    const conf = path.join(root, 'onset.conf');
    fs.writeFileSync(conf, '# 编排工具\nORCHESTRATOR=codex\n# 配音\nTTS_PROVIDER=\n');
    const out = new Buffer();
    expect(await run(['config', 'set', 'TTS_PROVIDER', 'breeze', '--project-root', root], out), out.text).toBe(0);
    expect(await run(['config', 'set', 'ORCHESTRATOR', '', '--project-root', root], out), out.text).toBe(0);
    expect(await run(['config', 'set', 'SCENE_JOBS', '5', '--project-root', root], out), out.text).toBe(0);
    expect(fs.readFileSync(conf, 'utf8')).toBe('# 编排工具\nORCHESTRATOR=\n# 配音\nTTS_PROVIDER=breeze\nSCENE_JOBS=5\n');
    const bad = new Buffer();
    expect(await run(['config', 'set', 'TTS_PROVIDER', 'nope', '--project-root', root], bad)).toBe(1);
    expect(bad.text).toContain('不认识的配音工具');
  });
});


it('preserves companion options when the existing tool is quoted', async () => {
  const root = tempDir(), conf = path.join(root, 'onset.conf');
  fs.writeFileSync(conf, 'RENDERER="claude"\nRENDERER_OPTIONS=effort=high\nRENDERER_MODEL=opus\n');
  const out = new Buffer();
  expect(await run(['config', 'set', 'RENDERER', 'claude', '--project-root', root], out)).toBe(0);
  expect(fs.readFileSync(conf, 'utf8')).toContain('RENDERER_OPTIONS=effort=high');
  expect(await run(['config', 'set', 'RENDERER', 'codex', '--project-root', root], out)).toBe(0);
  expect(fs.readFileSync(conf, 'utf8')).not.toContain('effort=high');
});
