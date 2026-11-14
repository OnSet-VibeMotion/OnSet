import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Buffer, run, tempDir } from './testutil';
import { windowsOperations } from './windows_cmd';

it('does not register Windows capabilities on macOS or Linux', () => {
  expect(windowsOperations('darwin')).toEqual([]);
  expect(windowsOperations('linux')).toEqual([]);
  expect(windowsOperations('win32').map((op) => op.name)).toEqual(['windows_inspect', 'source_download']);
});

describe.skipIf(process.platform !== 'win32')('Windows inspection', () => {
  it('reports optional missing directories and real running scene count without creating artifacts', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'SCENE_JOBS=3\n');
    for (const id of ['scene-a', 'scene-b']) {
      const directory = path.join(root, 'scenes', id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `render-${id}.live.json`), JSON.stringify({ pid: 123, started_at: '2026-01-01T00:00:00Z' }));
    }
    const output = new Buffer();
    expect(await run(['windows', 'inspect', '--project-root', root], output), output.text).toBe(0);
    expect(fs.existsSync(path.join(root, 'production/visual-qc'))).toBe(false);
    const op = windowsOperations('win32')[0];
    const result = await op.run({ project_root: root, paths: [] }, {} as never);
    expect(result?.data).toMatchObject({ configured_scene_jobs: 3, running_scene_count: 2, paths: [{ exists: false }, { exists: false }] });
  });
});
