// Test-only adapters. Keep Unix fixtures intact; Windows launches them through an explicit Git sh.
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../envutil';

function testShell(): string {
  const candidates = [process.env.ONSET_TEST_SHELL];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    try {
      // A zero-byte System32 git placeholder can precede the real installation.
      const git = lookPath('git', directory);
      candidates.push(path.resolve(path.dirname(git), '../bin/sh.exe'));
    } catch { /* Inspect the next PATH entry. */ }
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (base) candidates.push(path.join(base, 'Git/bin/sh.exe'));
  const shell = candidates.find(file => file && fs.existsSync(file));
  if (!shell) throw new Error('Windows shell fixtures require Git for Windows; set ONSET_TEST_SHELL to its bin/sh.exe');
  return shell;
}

/** Returns a Node entry on Windows, the original executable shell file elsewhere. */
export function writeShellFixture(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  if (process.platform !== 'win32') return file;
  const shell = testShell();
  const shellBin = path.resolve(path.dirname(shell), '../usr/bin');
  return writeWindowsNodeFixture(file, `const {spawnSync}=require('node:child_process');
const env={...process.env,PATH:(process.env.PATH||'')+';'+${JSON.stringify(shellBin)}};
const result=spawnSync(${JSON.stringify(shell)},[${JSON.stringify(file)},...process.argv.slice(2)],{env,stdio:'inherit',windowsHide:true});
if(result.error){console.error(result.error.message);process.exit(126)}process.exit(result.status??1);
`);
}

export function writeWindowsNodeFixture(file: string, body: string): string {
  if (process.platform !== 'win32') throw new Error('Windows fixture only');
  const entry = file + '.fixture.cjs';
  fs.writeFileSync(entry, body);
  // The production cmd-shim reader takes this JS entry directly, preserving multiline arguments.
  fs.writeFileSync(file + '.cmd', `@node "%~dp0\\${path.basename(entry)}" %*\r\n`);
  return entry;
}

export function directoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
