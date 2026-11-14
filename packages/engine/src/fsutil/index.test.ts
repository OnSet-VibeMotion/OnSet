import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWrite, removeTree } from './index';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-fsutil-'));

describe('removeTree', () => {
  it('removes nested read-only git objects and accepts an absent directory', () => {
    const dir = temp();
    const object = path.join(dir, '.git', 'objects', 'pack', 'test.pack');
    fs.mkdirSync(path.dirname(object), { recursive: true });
    fs.writeFileSync(object, 'git object');
    fs.chmodSync(object, 0o444);
    removeTree(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => removeTree(dir)).not.toThrow();
  });

  it('does not change or delete files reached through directory links', () => {
    const parent = temp();
    const dir = path.join(parent, 'checkout');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(dir);
    fs.mkdirSync(outside);
    const file = path.join(outside, 'keep.txt');
    fs.writeFileSync(file, 'keep');
    fs.chmodSync(file, 0o444);
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      // 强制触发 Windows 上清除只读属性的分支，链接目标必须保持只读。
      const object = path.join(dir, 'object');
      fs.writeFileSync(object, 'object');
      fs.chmodSync(object, 0o444);
      removeTree(dir);
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('keep');
      expect(fs.statSync(file).mode & 0o200).toBe(0);
    } finally {
      fs.chmodSync(file, 0o644);
      removeTree(parent);
    }
  });
});

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
    // Windows mode bits do not represent executable permissions; exercise the actual file there.
    if (process.platform === 'win32') {
      expect(fs.readFileSync(file, 'utf8')).toBe('#!/bin/sh\n');
      expect(() => fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK)).not.toThrow();
    } else expect(fs.statSync(file).mode & 0o777).toBe(0o755);
  });

  it('cleans the temp file when the write fails', () => {
    const dir = temp();
    const target = path.join(dir, 'taken');
    fs.mkdirSync(path.join(target, 'child'), { recursive: true });
    expect(() => atomicWrite(target, 'x')).toThrow(/写入/);
    expect(fs.readdirSync(dir)).toEqual(['taken']);
  });
});
