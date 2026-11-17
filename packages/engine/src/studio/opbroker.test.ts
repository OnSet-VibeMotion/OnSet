import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectContaining } from './opbroker';
import type { Project } from './studio';

describe('projectContaining', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-broker-')); dirs.push(d); return d; };
  const project = (p: string, id: string): Project => ({ id, path: p, name: path.basename(p), last_opened_at: '' });

  it('finds the project of the request, not the one open in the client', () => {
    const root = tmp();
    const a = path.join(root, '甲项目'), b = path.join(root, '乙项目');
    fs.mkdirSync(path.join(a, 'scenes'), { recursive: true });
    fs.mkdirSync(b);
    const projects = [project(b, 'b'), project(a, 'a')];
    expect(projectContaining(projects, a)?.id).toBe('a');
    expect(projectContaining(projects, path.join(a, 'scenes'))?.id).toBe('a');
    expect(projectContaining(projects, root)).toBeNull();
    expect(projectContaining(projects, path.join(root, '甲项目-2'))).toBeNull();
  });

  it('prefers the innermost project and follows symlinks', () => {
    const root = tmp();
    const outer = path.join(root, 'outer'), inner = path.join(outer, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    fs.symlinkSync(inner, path.join(root, 'link'));
    const projects = [project(outer, 'outer'), project(inner, 'inner')];
    expect(projectContaining(projects, inner)?.id).toBe('inner');
    expect(projectContaining(projects, path.join(root, 'link'))?.id).toBe('inner');
  });
});
