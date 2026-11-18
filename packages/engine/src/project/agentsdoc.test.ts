/**
 * 仓库根 AGENTS.md 只放索引、命令与对所有改动都成立的几条；细节按领域放在 docs/dev/。
 * 每个开发会话都会整份读进上下文：它曾经长到 271 KB，读一遍就占掉大半个上下文窗口（2026-11-18）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetsBase } from '../assets';

const repoRoot = assetsBase();
const agents = path.join(repoRoot, 'AGENTS.md');
const devDocs = path.join(repoRoot, 'docs', 'dev');

/** 超过这个大小就把新加的细节挪进 docs/dev/ 里对应的那一份。 */
const MaxAgentsBytes = 16 * 1024;

describe('AGENTS.md', () => {
  it('stays an index small enough to read every session', () => {
    expect(fs.statSync(agents).size).toBeLessThanOrEqual(MaxAgentsBytes);
  });

  it('indexes exactly the docs in docs/dev', () => {
    const text = fs.readFileSync(agents, 'utf8');
    const named = new Set([...text.matchAll(/docs\/dev\/([\w-]+\.md)/g)].map((m) => m[1]));
    // 桌面客户端的四份由 desktop.md 那一行列出。
    for (const m of text.matchAll(/`(desktop-[\w-]+\.md)`/g)) named.add(m[1]);
    const present = fs.readdirSync(devDocs).filter((f) => f.endsWith('.md'));
    expect([...named].sort()).toEqual(present.sort());
  });
});
