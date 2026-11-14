import fs from 'node:fs';
import path from 'node:path';
import {binDir,dataDir,lookPath,windowsPython} from '../envutil';
import {start} from '../procgroup';
import type {InstallOptions} from '../toolinstall';

const packages=[{module:'PIL',package:'Pillow==13.0.0'},{module:'fontTools',package:'fonttools==4.60.1'}];

function managedPython(env:Record<string,string>):string {
  const python=windowsPython(env);
  if(!python)return '';
  // Never install helper libraries into the user's unrelated system Python.
  const bin=binDir(env),roots=[bin?path.dirname(bin):'',dataDir(env)].filter(Boolean);
  return roots.some(root=>{
    const relative=path.relative(path.resolve(root,'tools'),python);
    return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);
  })?python:'';
}

export function windowsGraphicsStatus(env:Record<string,string>):{ok:boolean;where:string;missing:string[]} {
  if(process.platform!=='win32')return {ok:false,where:'',missing:[]};
  const python=managedPython(env),site=python?path.resolve(path.dirname(python),'../Lib/site-packages'):'';
  const missing=packages.filter(item=>!site||!fs.existsSync(path.join(site,item.module,'__init__.py'))).map(item=>item.package);
  return {ok:python!==''&&!missing.length,where:python||binDir(env),missing};
}

/** Explicit setup only: add missing helpers without rebuilding or upgrading the speech environment. */
export async function ensureWindowsGraphics(opts:InstallOptions):Promise<string> {
  if(process.platform!=='win32')throw Error('图像与字体辅助资源仅用于 Windows');
  const python=managedPython(opts.env),status=windowsGraphicsStatus(opts.env);
  if(!python)throw Error('请先在工具准备页安装本地配音或对齐 Python 环境');
  if(status.ok)return python;
  const uv=lookPath('uv',opts.env.PATH??'');
  opts.progress?.({stage:'准备 Windows 图像与字体辅助库',percent:0,indeterminate:true});
  const running=await start(uv,['pip','install','--python',python,'--no-deps','--only-binary',':all:',...status.missing],{env:opts.env,signal:opts.signal,stdio:['ignore','pipe','pipe']});
  for(const stream of [running.child.stdout,running.child.stderr])stream?.on('data',chunk=>opts.output?.write(chunk.toString()));
  await running.wait();
  const check=await start(python,['-c','from PIL import Image, ImageFont; from fontTools.ttLib import TTFont; print("Windows image and font helpers ready")'],{env:{...opts.env,PYTHONUTF8:'1'},signal:opts.signal,stdio:['ignore','pipe','pipe']});
  for(const stream of [check.child.stdout,check.child.stderr])stream?.on('data',chunk=>opts.output?.write(chunk.toString()));
  await check.wait();
  if(!windowsGraphicsStatus(opts.env).ok)throw Error('图像与字体辅助库安装后仍不完整');
  opts.progress?.({stage:'Windows 图像与字体辅助库已就绪',percent:100});
  return python;
}
