import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installedWindowsAssets, recordWindowsRuntime } from './windows-runtime-assets.mjs';

test('Windows pins installed prompts to matching bundles; other platforms keep source behavior', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-assets-'));
  try {
    assert.equal(installedWindowsAssets(root, 'win32'), undefined);
    const stage = path.join(root, '.onset-local/staged/one');
    fs.mkdirSync(path.join(stage, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'assets/prompt.md'), 'old schema');
    fs.writeFileSync(path.join(root, 'tool.cjs'), 'old tool');
    const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ outputs: { 'tool.cjs': sha(path.join(root, 'tool.cjs')) }, inputs: { 'assets/prompt.md': sha(path.join(stage, 'assets/prompt.md')) } }));
    fs.writeFileSync(path.join(root, '.onset-local/active-runtime.json'), JSON.stringify({ stage }));
    assert.equal(installedWindowsAssets(root, 'win32'), path.join(stage, 'assets'));
    fs.writeFileSync(path.join(root, 'tool.cjs'), 'new tool');
    assert.throws(() => installedWindowsAssets(root, 'win32'), /bundles changed/);
    assert.equal(installedWindowsAssets(root, 'darwin'), undefined);
    fs.writeFileSync(path.join(root, 'tool.cjs'), 'old tool');
    fs.writeFileSync(path.join(stage, 'assets/prompt.md'), 'new schema');
    assert.throws(() => installedWindowsAssets(root, 'win32'), /assets changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local rebuild records matching assets and supports the next ordinary Windows launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-rebuilt-assets-'));
  try {
    const files=['packages/cli/dist/onset.cjs','packages/cli/dist/onset-agent.cjs',...['entry','main','browser','preload'].map(name=>'apps/desktop/out/'+name+'.js'),'apps/desktop/out/renderer/index.html','assets/prompt.md'];
    for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'first build');}
    const first=recordWindowsRuntime(root,'win32');
    assert.equal(installedWindowsAssets(root,'win32'),first);
    fs.writeFileSync(path.join(root,'assets/prompt.md'),'next source schema');
    assert.equal(fs.readFileSync(path.join(first,'prompt.md'),'utf8'),'first build');
    fs.writeFileSync(path.join(root,files[0]),'next tool');
    assert.throws(()=>installedWindowsAssets(root,'win32'),/bundles changed/);
    const second=recordWindowsRuntime(root,'win32');
    assert.notEqual(first,second);
    assert.equal(installedWindowsAssets(root,'win32'),second);
    assert.equal(fs.readFileSync(path.join(second,'prompt.md'),'utf8'),'next source schema');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('local rebuild asset recording leaves other platforms untouched', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'onset-nonwindows-assets-'));
  try {assert.equal(recordWindowsRuntime(root,'darwin'),undefined);assert.equal(recordWindowsRuntime(root,'linux'),undefined);assert.deepEqual(fs.readdirSync(root),[]);}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});
