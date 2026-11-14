import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, inputFiles } from './record';
import { buildPrompt, DesignFile } from './scene';
import { mustLoad, writeScene } from './testsupport';

const payload = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"内容"}';

describe('two-stage design', () => {
  it('leaves scenes without a design untouched, and makes design.md an input when present', () => {
    const dir = writeScene(payload);
    const before = buildPrompt(mustLoad(dir), {});
    expect(before).not.toContain('设计稿');
    expect(inputFiles(mustLoad(dir))).not.toContain(DesignFile);
    const fpBefore = fingerprint(mustLoad(dir), 'claude', {});
    fs.writeFileSync(path.join(dir, DesignFile), '# 设计稿\n先立住三层。\n');
    const s = mustLoad(dir);
    expect(inputFiles(s)).toContain(DesignFile);
    const after = buildPrompt(s, {});
    expect(after).toContain('镜头目录里的 design.md 是为本镜头写好的设计稿');
    expect(fingerprint(s, 'claude', {}).parts?.['file:design.md']).toBeDefined();
    expect(fingerprint(s, 'claude', {}).fingerprint).not.toBe(fpBefore.fingerprint);
  });

  it('asks the designer for design.md only, wrapping the full brief without the old design', () => {
    const dir = writeScene(payload);
    fs.writeFileSync(path.join(dir, DesignFile), '旧稿');
    const s = { ...mustLoad(dir), designOnly: true };
    const prompt = buildPrompt(s, {});
    expect(prompt.startsWith('当前只为一个 MG 动画镜头写设计稿')).toBe(true);
    expect(prompt).toContain('<onset-scene-brief>');
    expect(prompt).toContain('镜头编号：scene-001');
    expect(prompt).not.toContain('是为本镜头写好的设计稿');
    expect(prompt).toContain('[[USER_MESSAGE]]设计稿已写完：design.md');
    // 只写设计稿是这一次的做法，不是镜头的输入。
    expect(fingerprint(s, 'claude', {}).fingerprint).toBe(fingerprint(mustLoad(dir), 'claude', {}).fingerprint);
  });

  it('puts exemplars into the prompt and the fingerprint only when there are some', () => {
    const dir = writeScene(payload);
    const s = mustLoad(dir);
    const plain = fingerprint(s, 'claude', {});
    expect(fingerprint({ ...s, exemplars: { names: [], section: 'x', digest: 'd', dirs: [] } }, 'claude', {}).fingerprint).toBe(plain.fingerprint);
    const withOne = { ...s, exemplars: { names: ['e1'], section: '\n参考范例：/tmp/e1\n', digest: 'abc', dirs: ['/tmp/e1'] } };
    expect(buildPrompt(withOne, {})).toContain('参考范例：/tmp/e1');
    expect(fingerprint(withOne, 'claude', {}).parts?.exemplars).toBe('abc');
  });
});
