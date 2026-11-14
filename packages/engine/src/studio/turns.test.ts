import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { collect, prepare } from '../renderassets';
import { describe, expect, it } from 'vitest';
import { newID } from './sessions';
import { sleep, tempDir, writeTree } from './testsupport';
import { ConflictError, changedPaths, diffTrees, isContentState, loadTurn, readBlob, revertTurn, scanTree, statPrefix, statTree, validID, type Turn } from './turns';

function turnOf(fields: Partial<Turn>): Turn {
  return { turn_id: 't-1', session_id: '', kind: '', message: '', status: '', started_at: '', changes: null, before: null, ...fields };
}

describe('turns', () => {
  it('does not revert the resource pool or its ownership manifest independently of links', () => {
    const root = tempDir();
    const source = path.join(root, 'assets/vendor/lib.js');
    writeTree(root, { 'assets/vendor/lib.js': 'old library' });
    const scene = path.join(root, 'scenes', 'one');
    fs.mkdirSync(scene, { recursive: true });
    const files = () => collect([{ from: source, to: 'vendor/lib.js' }]);
    prepare(root, scene, files());
    const before = scanTree(root);
    fs.writeFileSync(source, 'new library');
    prepare(root, scene, files());
    const after = scanTree(root);
    expect(Object.keys(after).some((p) => p.startsWith('.onset/') || p.endsWith('.onset-resources.json'))).toBe(false);
    revertTurn(root, turnOf({ status: 'succeeded', before, after, changes: diffTrees(before, after) }));
    prepare(root, scene, files());
    expect(fs.readFileSync(path.join(scene, 'vendor/lib.js'), 'utf8')).toBe('old library');
  });
  it('scanTree skips state dirs and stores text', () => {
    const root = tempDir();
    writeTree(root, {
      'scenes/a/prompt.md': 'hello',
      'scenes/a/out.mp4': 'fake video',
      'scenes/a/attempts/old.log': 'skip',
      'node_modules/x/index.js': 'skip',
      'production/studio/tasks.json': 'skip',
      'production/scene-plan.json': '{}',
      'assets/binary.dat': 'a\x00b',
      '.agents/skills/s/SKILL.md': 'skip',
      'scenes/a/.studio-frames/f.jpg': 'skip',
      'production/studio-notes/keep.md': 'keep',
    });
    const tree = scanTree(root);
    for (const skipped of ['scenes/a/attempts/old.log', 'node_modules/x/index.js', 'production/studio/tasks.json', '.agents/skills/s/SKILL.md', 'scenes/a/.studio-frames/f.jpg']) {
      expect(tree, `${skipped} 不应进快照`).not.toHaveProperty([skipped]);
    }
    expect(isContentState(tree['scenes/a/prompt.md']) && isContentState(tree['production/studio-notes/keep.md'])).toBe(true);
    for (const statOnly of ['scenes/a/out.mp4', 'assets/binary.dat']) expect(tree[statOnly].startsWith(statPrefix)).toBe(true);
    expect(readBlob(root, tree['scenes/a/prompt.md'])?.toString()).toBe('hello');
  });

  it('revert restores text and skips media', () => {
    const root = tempDir();
    writeTree(root, { 'keep.md': 'same', 'edit.md': 'old', 'gone.md': 'bye', 'out.mp4': 'v1' });
    const before = scanTree(root);
    writeTree(root, { 'edit.md': 'new', 'added.md': 'fresh', 'out.mp4': 'v2-longer' });
    fs.rmSync(path.join(root, 'gone.md'));
    const after = scanTree(root);
    const turn = turnOf({ status: 'succeeded', before, after, changes: diffTrees(before, after) });
    const want: Record<string, string> = { 'added.md': 'added', 'edit.md': 'modified', 'gone.md': 'deleted', 'out.mp4': 'modified' };
    expect(turn.changes).toHaveLength(Object.keys(want).length);
    for (const change of turn.changes!) {
      expect(want[change.path]).toBe(change.change);
      expect(change.revertable).toBe(change.path !== 'out.mp4');
    }
    const skipped = revertTurn(root, turn);
    expect(skipped).toEqual(['out.mp4']);
    for (const [rel, body] of Object.entries({ 'edit.md': 'old', 'gone.md': 'bye', 'keep.md': 'same' })) {
      expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(body);
    }
    expect(fs.existsSync(path.join(root, 'added.md')), '本轮新增的文件应当删掉').toBe(false);
  });

  it('revert refuses files changed later', async () => {
    const root = tempDir();
    writeTree(root, { 'a.md': '1', 'b.md': '1' });
    const before = scanTree(root);
    writeTree(root, { 'a.md': '2', 'b.md': '2' });
    const after = scanTree(root);
    const turn = turnOf({ status: 'succeeded', before, after, changes: diffTrees(before, after) });
    await sleep(10);
    writeTree(root, { 'b.md': '3' });
    let err: unknown;
    try {
      revertTurn(root, turn);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).paths).toEqual(['b.md']);
    expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '有冲突时不应做部分回退').toBe('2');
    for (const status of ['running', 'reverted']) expect(() => revertTurn(root, turnOf({ status, after }))).toThrow();
    expect(() => revertTurn(root, turnOf({ status: 'failed' })), '没有结束快照时不能回退').toThrow();
  });

  it('statTree detects changes', () => {
    const root = tempDir();
    writeTree(root, { 'a.md': '1', 'b.md': '1' });
    const before = statTree(root);
    writeTree(root, { 'a.md': '22', 'c.md': 'new' });
    fs.rmSync(path.join(root, 'b.md'));
    expect(changedPaths(before, statTree(root)).join(',')).toBe('a.md,b.md,c.md');
  });

  it('validID rejects traversal', () => {
    for (const id of ['', '../x', 'a/b', 'A', 'a'.repeat(81)]) expect(validID(id), `${id} 不应合法`).toBe(false);
    expect(validID(newID('t')), '自己生成的 id 必须合法').toBe(true);
    expect(() => loadTurn(tempDir(), '../../etc/passwd'), '非法 id 不应读文件').toThrow();
  });
});
