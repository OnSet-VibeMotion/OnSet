import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, items } from './index';

describe('prereqs', () => {
  it('lists skills, the CLI and every film-style source, in preparation order', () => {
    const ids = items().map((item) => item.id);
    expect(ids.slice(0, 2)).toEqual(['skills', 'cli']);
    expect(ids).toContain('styles:lemo-opuscar');
  });

  it('reports nothing ready in an empty home, without touching the network', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prereqs-'));
    const status = check({ HOME: home, PATH: process.env.PATH ?? '' });
    expect(status.every((s) => !s.ready)).toBe(true);
    expect(status.filter((s) => s.required).map((s) => s.id)).toEqual(['skills', 'cli']);
    for (const s of status) expect(s.location.startsWith(home), `${s.id}: ${s.location}`).toBe(true);
  });
});
