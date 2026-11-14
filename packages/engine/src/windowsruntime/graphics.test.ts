import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect,it,vi,onTestFinished} from 'vitest';
import * as procgroup from '../procgroup';
import {items} from '../prereqs';
import {ensureWindowsGraphics,windowsGraphicsStatus} from './graphics';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'onset-win-graphics-'));
 onTestFinished(()=>fs.rmSync(root,{recursive:true,force:true}));
 const python=path.join(root,'tools/venv/funasr/Scripts/python.exe'),site=path.resolve(path.dirname(python),'../Lib/site-packages');
 fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'fixture');
 const env={ONSET_BIN_DIR:path.join(root,'bin'),XDG_DATA_HOME:path.join(root,'data'),PATH:path.join(root,'bin')};fs.mkdirSync(env.ONSET_BIN_DIR);
 const add=(name:string)=>{fs.mkdirSync(path.join(site,name),{recursive:true});fs.writeFileSync(path.join(site,name,'__init__.py'),'fixture');};
 return {root,python,site,env,add};
}

it('lists helper preparation only on Windows without changing existing required prerequisites',()=>{
 expect(items().some(item=>item.id==='python:graphics')).toBe(process.platform==='win32');
 if(process.platform==='win32')expect(items().find(item=>item.id==='python:graphics')?.later?.title).toBe('图像与字体辅助库');
});

it.skipIf(process.platform!=='win32')('requires both actual helper modules, not only a Python executable',()=>{
 const f=fixture();expect(windowsGraphicsStatus(f.env)).toMatchObject({ok:false,missing:['Pillow==13.0.0','fonttools==4.60.1']});
 f.add('PIL');expect(windowsGraphicsStatus(f.env)).toMatchObject({ok:false,missing:['fonttools==4.60.1']});
 f.add('fontTools');expect(windowsGraphicsStatus(f.env)).toMatchObject({ok:true,where:f.python,missing:[]});
});

it.skipIf(process.platform!=='win32')('adds only missing wheels and leaves the existing speech environment intact',async()=>{
 const f=fixture();f.add('PIL');const torch=path.join(f.site,'torch.py');fs.writeFileSync(torch,'existing torch');fs.writeFileSync(path.join(f.env.ONSET_BIN_DIR,'uv.exe'),'fixture');
 const calls:string[][]=[];
 const mock=vi.spyOn(procgroup,'start').mockImplementation(async(_file,args)=>{
  calls.push(args);if(args[0]==='pip')f.add('fontTools');
  return {child:{stdout:null,stderr:null},wait:async()=>{}} as Awaited<ReturnType<typeof procgroup.start>>;
 });
 try{
  expect(await ensureWindowsGraphics({env:f.env})).toBe(f.python);
  expect(calls[0]).toEqual(['pip','install','--python',f.python,'--no-deps','--only-binary',':all:','fonttools==4.60.1']);
  expect(fs.readFileSync(torch,'utf8')).toBe('existing torch');
  expect(await ensureWindowsGraphics({env:f.env})).toBe(f.python);expect(calls).toHaveLength(2);
 }finally{mock.mockRestore();}
});
