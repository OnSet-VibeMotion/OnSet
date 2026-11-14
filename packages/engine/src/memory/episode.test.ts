import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { newStore } from './testsupport';

it.each([
  ['whole seconds and trimmed fractions', ['2026-11-14T10:00:00Z', '2026-11-14T10:00:00.1Z', '2026-11-14T10:00:00.101Z', '2026-11-14T10:00:01Z']],
  ['legacy nanosecond precision', ['2026-11-14T10:00:00.123Z', '2026-11-14T10:00:00.123000001Z', '2026-11-14T10:00:00.123000002Z']],
] as const)('orders episodes chronologically with %s without rewriting them', (_name, timestamps) => {
  const store = newStore();
  const files = timestamps.map((created_at, index) => {
    // 编号反向排列，不能用随机编号代替时间排序。
    const id = `ep-${timestamps.length - index}`;
    const dir = path.join(store.dir, 'episodes', '2026-11', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'episode.json');
    const body = JSON.stringify({ schema: 1, id, created_at });
    fs.writeFileSync(file, body);
    return { file, body };
  });
  expect(store.episodes().map(episode => episode.created_at)).toEqual(timestamps);
  for (const { file, body } of files) expect(fs.readFileSync(file, 'utf8')).toBe(body);
});

it('uses the episode ID to break equal timestamp ties', () => {
  const store = newStore();
  for (const [id, created_at] of [['ep-a', '2026-11-14T10:00:00Z'], ['ep-b', '2026-11-14T10:00:00.000Z']]) {
    const dir = path.join(store.dir, 'episodes', '2026-11', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'episode.json'), JSON.stringify({ schema: 1, id, created_at }));
  }
  expect(store.episodes().map(episode => episode.id)).toEqual(['ep-a', 'ep-b']);
});
