import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVoice } from './runner';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-voice-runner-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const env = () => ({ ...process.env, ONSET_BIN_DIR: root }) as Record<string, string>;

describe('voice process boundary', () => {
  it('passes punctuation and shell syntax literally without evaluating it', async () => {
    const text = '中文 $(touch nope) `command` "quotes"\n下一行';
    const got = await runVoice(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', text], env());
    expect(got).toBe(text);
  });

  it('points a missing tool to setup and reports a failing process without leaking a key', async () => {
    await expect(runVoice('onset-no-such-tts', [], env())).rejects.toThrow('工具准备页');
    await expect(runVoice(process.execPath, ['-e', 'console.error("api_key=sk-secretvalue");process.exit(1)'], env())).rejects.toThrow('[redacted]');
  });

  it('cancels the provider and its subprocess before they write delayed output', async () => {
    const ready = path.join(root, 'ready');
    const late = path.join(root, 'late');
    const script = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late'),800)`)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const pending = runVoice(process.execPath, ['-e', script], env(), controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    try {
      await expect.poll(() => fs.existsSync(ready)).toBe(true);
    } finally { controller.abort(); }
    await assertion;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fs.existsSync(late)).toBe(false);
  });
});
