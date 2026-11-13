import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWrite } from './index';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-fsutil-'));

describe('atomicWrite', () => {
  it('creates the file', () => {
    const file = path.join(temp(), 'out.txt');
    atomicWrite(file, 'hello');
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  });

  it('creates parent directories', () => {
    const file = path.join(temp(), 'a', 'b', 'c', 'out.txt');
    atomicWrite(file, 'nested');
    expect(fs.readFileSync(file, 'utf8')).toBe('nested');
  });

  it('overwrites an existing file and leaves no temp files', () => {
    const dir = temp();
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, 'old');
    atomicWrite(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['out.txt']);
  });

  it('applies the mode', () => {
    const file = path.join(temp(), 'x.sh');
    atomicWrite(file, '#!/bin/sh\n', 0o755);
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
  });

  it('cleans the temp file when the write fails', () => {
    const dir = temp();
    const target = path.join(dir, 'taken');
    fs.mkdirSync(path.join(target, 'child'), { recursive: true });
    expect(() => atomicWrite(target, 'x')).toThrow(/写入/);
    expect(fs.readdirSync(dir)).toEqual(['taken']);
  });
});
