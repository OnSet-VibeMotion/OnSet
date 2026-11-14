import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dirSize, watchSize } from './util';

describe('watchSize', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-size-'));
    dirs.push(d);
    return d;
  };

  it('adds up files in nested folders and skips missing ones', async () => {
    const d = temp();
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(d, 'x'), Buffer.alloc(100));
    fs.writeFileSync(path.join(d, 'a', 'b', 'y'), Buffer.alloc(50));
    expect(await dirSize(d)).toBe(150);
    expect(await dirSize(path.join(d, 'nope'))).toBe(0);
  });

  it('reports growth since it started, not the size already there', async () => {
    // 安装器往已有的目录里写（uv 的 Python 目录）：界面要的是这一步下了多少。
    const d = temp();
    fs.writeFileSync(path.join(d, 'old'), Buffer.alloc(1000));
    const seen: number[] = [];
    const stop = watchSize([d], (b) => seen.push(b), 20);
    await new Promise((r) => setTimeout(r, 60));
    fs.writeFileSync(path.join(d, 'new'), Buffer.alloc(300));
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(300);
  });
});
