import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 本地 Windows 安装使用与已部署工具同一次构建的提示词，防止源码先更新造成参数漂移。 */
export function installedWindowsAssets(root, platform = process.platform) {
  if (platform !== 'win32') return undefined;
  const marker = path.join(root, '.onset-local', 'active-runtime.json');
  if (!fs.existsSync(marker)) return undefined;
  const { stage } = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const stagedRoot = fs.realpathSync(path.join(root, '.onset-local', 'staged'));
  const resolved = fs.realpathSync(stage);
  const within = (base, target) => {
    const rel = path.relative(base, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (!within(stagedRoot, resolved)) throw Error('Windows runtime stage escaped local staged directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'manifest.json'), 'utf8'));
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const [relative, expected] of Object.entries(manifest.outputs)) {
    const file = path.resolve(root, relative);
    if (!within(root, file) || sha(file) !== expected) throw Error('Windows runtime bundles changed; rebuild or redeploy together: ' + relative);
  }
  for (const [relative, expected] of Object.entries(manifest.inputs).filter(([relative]) => relative.startsWith('assets/'))) {
    const file = path.resolve(resolved, relative);
    if (!within(resolved, file) || sha(file) !== expected) throw Error('Windows runtime assets changed; redeploy together: ' + relative);
  }
  return path.join(resolved, 'assets');
}

/** 显式本地重建成功后同步保存运行包与资产，下一次普通启动仍使用这份配套版本。 */
export function recordWindowsRuntime(root, platform = process.platform) {
  if (platform !== 'win32') return undefined;
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const runtime = ['packages/cli/dist/onset.cjs','packages/cli/dist/onset-agent.cjs',...['entry','main','browser','preload'].map(name => 'apps/desktop/out/' + name + '.js'),...walk(path.join(root,'apps/desktop/out/renderer')).map(relative)];
  const assets = walk(path.join(root,'assets')).map(relative);
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const stagedRoot = path.join(root,'.onset-local/staged');
  fs.mkdirSync(stagedRoot,{recursive:true});
  const stage = fs.mkdtempSync(path.join(stagedRoot,'windows-local-build-'));
  for (const file of [...runtime,...assets]) {
    const target = path.join(stage,file);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(root,file),target,fs.constants.COPYFILE_EXCL);
  }
  const manifest = {schema:1,stage,builtAt:new Date().toISOString(),inputs:Object.fromEntries(assets.map(file => [file,sha(path.join(stage,file))])),outputs:Object.fromEntries(runtime.map(file => [file,sha(path.join(stage,file))]))};
  for (const [file,expected] of Object.entries(manifest.outputs)) if (sha(path.join(root,file)) !== expected) throw Error('Windows runtime changed while recording build: ' + file);
  fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const marker=path.join(root,'.onset-local/active-runtime.json'),temporary=marker+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({schema:1,stage,installedAt:new Date().toISOString()})+'\n',{flag:'wx'});
  try {fs.renameSync(temporary,marker);} finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return path.join(stage,'assets');
}
