import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('This local resource migration is Windows only');
const runtime = path.join(root, '.onset-local');
const data = path.join(runtime, 'data', 'onset');
const original = path.join(process.env.LOCALAPPDATA, 'onset');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let copied = 0;
function copyVerified(source, target) {
  const relative = path.relative(runtime, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Target escaped the local runtime');
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Inspect resource link before migrating: ' + source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source).sort()) copyVerified(path.join(source, entry), path.join(target, entry));
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); copied++; }
    if (sha(source) !== sha(target)) throw new Error('Resource copy hash mismatch: ' + target);
  }
}
for (const name of ['models', 'film-styles', 'hyperframes']) if (fs.existsSync(path.join(original, name))) copyVerified(path.join(original, name), path.join(data, name));
const uv = path.join(process.env.USERPROFILE, '.local', 'bin', 'uv.exe');
if (fs.existsSync(uv)) copyVerified(uv, path.join(runtime, 'bin', 'uv.exe'));
const nodeHome = path.join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs');
if (fs.existsSync(path.join(nodeHome, 'node.exe'))) copyVerified(path.join(nodeHome, 'node.exe'), path.join(runtime, 'bin', 'node.exe'));
if (fs.existsSync(path.join(nodeHome, 'node_modules', 'npm'))) copyVerified(path.join(nodeHome, 'node_modules', 'npm'), path.join(runtime, 'npm'));
const chromeHome = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application');
if (fs.existsSync(path.join(chromeHome, 'chrome.exe'))) {
  copyVerified(path.join(chromeHome, 'chrome.exe'), path.join(runtime, 'tools', 'chrome', 'chrome.exe'));
  // 只复制浏览器应用目录，不复制用户资料或登录态。
  const versions = fs.readdirSync(chromeHome).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name));
  for (const version of versions) copyVerified(path.join(chromeHome, version), path.join(runtime, 'tools', 'chrome', version));
}
const base = path.join(runtime, 'python', 'cpython-3.12.9-windows-x86_64-none');
if (!fs.existsSync(path.join(base, 'python.exe'))) throw new Error('Prepare the local Python 3.12.9 before relocating existing venv bases');
for (const relative of ['tools/venv/funasr', 'tools/uv/edge-tts']) {
  const environment = path.join(runtime, relative);
  const cfg = path.join(environment, 'pyvenv.cfg');
  if (!fs.existsSync(cfg)) continue;
  const before = fs.readFileSync(cfg, 'utf8');
  if (!/version_info = 3\.12\.9/.test(before)) throw new Error('Inspect the Python ABI before relocating: ' + cfg);
  const backup = cfg + '.before-local-base';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, before, { flag: 'wx' });
  fs.writeFileSync(cfg, before.replace(/^home = .*$/m, 'home = ' + base));
  try {
    const info = JSON.parse(execFileSync(path.join(environment, 'Scripts', 'python.exe'), ['-c', 'import json,sys,ssl;print(json.dumps({"base":sys.base_prefix,"version":list(sys.version_info[:3])}))'], { encoding: 'utf8', windowsHide: true }));
    if (path.resolve(info.base).toLowerCase() !== base.toLowerCase()) throw new Error('Python still depends on an external base');
  } catch (error) { fs.writeFileSync(cfg, before); throw error; }
}
const report = { preparedAt: new Date().toISOString(), copiedFiles: copied, originalsPreserved: true, data, python: base, runtime };
fs.writeFileSync(path.join(runtime, 'verification', 'local-resources.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
