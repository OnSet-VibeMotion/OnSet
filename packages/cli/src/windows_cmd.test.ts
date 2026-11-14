import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Buffer, run, tempDir, setenv } from './testutil';
import { windowsOperations } from './windows_cmd';

it('does not register Windows capabilities on macOS or Linux', () => {
  expect(windowsOperations('darwin')).toEqual([]);
  expect(windowsOperations('linux')).toEqual([]);
  expect(windowsOperations('win32').map((op) => op.name)).toEqual(['windows_inspect', 'source_download', 'windows_align']);
});

describe.skipIf(process.platform !== 'win32')('Windows inspection', () => {
  it('reports a complete local alignment model and detects missing files without downloading', async () => {
    const root=tempDir(),model=tempDir();
    fs.writeFileSync(path.join(root,'onset.conf'),'');
    setenv('ALIGN_MODEL',model); setenv('XDG_DATA_HOME',tempDir());
    for(const name of ['am.mvn','config.yaml','configuration.json','model.pt','seg_dict','tokens.json']) fs.writeFileSync(path.join(model,name),'fixture');
    const op=windowsOperations('win32')[0];
    expect((await op.run({project_root:root,paths:[]},{} as never))?.data).toMatchObject({alignment_model:{ready:true,path:model}});
    fs.unlinkSync(path.join(model,'tokens.json'));
    expect((await op.run({project_root:root,paths:[]},{} as never))?.data).toMatchObject({alignment_model:{ready:false,reason:'model_files_missing'}});
  });
  it('combines non-sensitive settings, missing Git and input hashes while rejecting escapes', async () => {
    const root = tempDir(); fs.writeFileSync(path.join(root,'onset.conf'),'SCENE_JOBS=3\n');
    fs.writeFileSync(path.join(root,'input.txt'),'sample');
    fs.writeFileSync(path.join(root,'.env'),'SECRET_TEST_VALUE=do-not-return\n');
    const op=windowsOperations('win32')[0];
    const result=await op.run({project_root:root,paths:[],hash_files:['input.txt','missing.txt']},{} as never);
    expect(result?.data).toMatchObject({git:{repository:false,reason:'not_initialized'},configured_scene_jobs:3,hashes:[{path:'input.txt',sha256:crypto.createHash('sha256').update('sample').digest('hex')},{path:'missing.txt',exists:false}]});
    expect(JSON.stringify(result)).not.toContain('do-not-return');
    expect(fs.existsSync(path.join(root,'.git'))).toBe(false);
    for(const file of ['../outside.txt','.env','.ENV','.codex/auth.json']) await expect(op.run({project_root:root,paths:[],hash_files:[file]},{} as never)).rejects.toThrow(/非凭据/);
    const outside=tempDir(); fs.symlinkSync(outside,path.join(root,'escape'),'junction');
    fs.writeFileSync(path.join(outside,'input.txt'),'outside');
    await expect(op.run({project_root:root,paths:[],hash_files:['escape/input.txt']},{} as never)).rejects.toThrow(/越出/);
    const media=new Uint8Array(3*1024*1024);fs.writeFileSync(path.join(root,'voice.wav'),media);
    expect((await op.run({project_root:root,paths:[],hash_files:['voice.wav']},{} as never))?.data).toMatchObject({hashes:[{bytes:media.length,sha256:crypto.createHash('sha256').update(media).digest('hex')}]});
    fs.writeFileSync(path.join(root,'big.txt'),'');fs.truncateSync(path.join(root,'big.txt'),256*1024*1024+1);
    await expect(op.run({project_root:root,paths:[],hash_files:['big.txt']},{} as never)).rejects.toThrow(/256 MiB/);
  });
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
