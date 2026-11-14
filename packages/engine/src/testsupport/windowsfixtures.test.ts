import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { envMap } from '../envutil';
import { run, runAsync } from '../mediaprobe/run';
import { runProcess } from '../song/proc';
import { localPath } from '../song/store';
import { runCommand } from '../filmstyle/gitlib';
import { start } from '../procgroup';
import { directoryLink, writeWindowsNodeFixture } from './windowsfixtures';

function temporary(): string {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'onset-windows-fixture-'));
  onTestFinished(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return directory;
}

describe.skipIf(process.platform !== 'win32')('Windows executable and path boundaries',()=>{
  it('media and song commands preserve Unicode, multiline arguments and exit codes through cmd-shims',async()=>{
    const file=path.join(temporary(),'probe');
    writeWindowsNodeFixture(file,'process.stdout.write(process.argv[2]);process.stderr.write("诊断");process.exit(3);');
    const arg='中文 参数\nsecond line', env=envMap();
    const sync=run(file+'.cmd',[arg],env);
    expect(sync.stdout.toString()).toBe(arg);
    expect(sync.stderr.toString()).toBe('诊断');
    expect(sync).toMatchObject({error:'exit status 3',exited:true});
    const asyncResult=await runAsync(file+'.cmd',[arg],env,{captureStdout:true,captureStderr:true});
    expect(asyncResult.stdout.toString()).toBe(arg);
    expect(asyncResult).toMatchObject({error:'exit status 3',exited:true});
    let stdout='',stderr='';
    expect(await runProcess(file+'.cmd',[arg],env,{stdout:chunk=>{stdout+=chunk;},stderr:chunk=>{stderr+=chunk;}})).toMatchObject({error:'exit status 3',exitCode:3,exited:true});
    expect(stdout).toBe(arg);expect(stderr).toBe('诊断');
    await expect(runCommand(file+'.cmd',[arg],{env})).rejects.toMatchObject({code:3});
  });

  it('checks every Windows path ancestor and rejects drive-relative, traversal and junction escapes',()=>{
    const root=temporary(),outside=temporary();
    fs.mkdirSync(path.join(root,'production'));
    directoryLink(outside,path.join(root,'production','linked'));
    expect(()=>localPath(root,'production\\linked\\candidate.json')).toThrow('符号链接');
    for(const rel of ['..\\outside','C:relative','C:\\absolute','\\\\server\\share'])expect(()=>localPath(root,rel)).toThrow('安全相对路径');
    expect(localPath(root,'production\\safe.json')).toBe(path.join(root,'production','safe.json'));
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('cancellation terminates an owned native Node descendant as well as its parent',async()=>{
    const root=temporary(),file=path.join(root,'renderer');
    const marker=path.join(root,'child.pid');
    writeWindowsNodeFixture(file,`const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`);
    const controller=new AbortController();
    const running=await start(file+'.cmd',[],{env:envMap(),signal:controller.signal,stdio:'ignore'});
    try{
      const deadline=Date.now()+5000;
      while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      expect(fs.existsSync(marker)).toBe(true);
      const pid=Number(fs.readFileSync(marker,'utf8'));
      controller.abort();
      await expect(running.wait()).rejects.toBeInstanceOf(Error);
      expect(()=>process.kill(pid,0)).toThrow();
    }finally{controller.abort();}
  });
});
