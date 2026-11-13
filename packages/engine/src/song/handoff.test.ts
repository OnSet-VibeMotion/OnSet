// 移植自 internal/song/handoff_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newToolchain } from '../mediaprobe';
import { generate } from './generate';
import { handoff, handoffWithRefresh, loadHandoff, receive } from './handoff';
import { configure } from './platforms';
import { candidateDir, select, selected, Store } from './store';
import { Buf, cleanupTemps, fakeEnvironment, tempDir } from './testsupport';

afterEach(cleanupTemps);

describe('manual handoff', () => {
  it('handoff receive lifecycle', async () => {
    const { root, env } = fakeEnvironment();
    configure(root, 'manual', '', '', '');
    const out = new Buf();
    // No credentials, Python, media binaries or even PATH are needed to hand off.
    await generate(root, 2, 'default', null, out);
    for (const want of ['歌词', 'Mandarin educational solo rap', '等待用户提供音频', '暂停']) expect(out.text).toContain(want);
    const { handoff: h, dir } = loadHandoff(root);
    expect(h.state).toBe('waiting_for_audio');
    const snapshot = fs.readFileSync(path.join(dir, 'lyrics.txt'));
    expect(fs.existsSync(path.join(root, Store, 'candidates')), 'handoff generated candidates').toBe(false);
    handoff(root, out);
    expect(loadHandoff(root).handoff, 'did not reuse snapshot').toEqual(h);
    fs.writeFileSync(path.join(root, 'lyrics.txt'), 'new unrelated lyrics');
    expect(() => handoff(root, out), 'silently replaced pending snapshot').toThrow();
    expect(loadHandoff(root).handoff, 'changed wait record').toEqual(h);
    const media = newToolchain(env);
    const audio = path.join(tempDir(), 'downloaded.mp3');
    fs.writeFileSync(audio, 'external audio');
    const candidate = receive(root, audio, media);
    const cdir = candidateDir(root, candidate.id);
    expect(fs.readFileSync(path.join(cdir, 'lyrics.txt')).equals(snapshot), 'did not bind original lyrics').toBe(true);
    const imported = loadHandoff(root).handoff;
    expect(imported.state).toBe('imported');
    expect(imported.candidate_id).toBe(candidate.id);
    expect(receive(root, audio, media).id).toBe(candidate.id);
    expect(() => selected(root), 'selected without user confirmation').toThrow();
    select(root, candidate.id);
    handoff(root, out); // new material allowed after prior audio received
    const next = loadHandoff(root).handoff;
    expect(next.id).not.toBe(h.id);
    expect(next.state).toBe('waiting_for_audio');
  });

  it('refresh and tampering', () => {
    const { root } = fakeEnvironment();
    const out = new Buf();
    handoff(root, out);
    const old = loadHandoff(root).handoff;
    fs.writeFileSync(path.join(root, 'lyrics.txt'), '修正过的知识歌词');
    handoffWithRefresh(root, true, out);
    const { handoff: h, dir } = loadHandoff(root);
    expect(h.id, 'refresh ignored').not.toBe(old.id);
    fs.writeFileSync(path.join(dir, 'style.txt'), 'tampered');
    expect(() => loadHandoff(root), 'accepted altered snapshot').toThrow();
    expect(() => handoff(root, out), 'overwrote changed snapshot').toThrow();
  });

  it('does not follow symlinks', () => {
    const { root } = fakeEnvironment();
    const outside = tempDir();
    fs.mkdirSync(path.join(root, Store), { recursive: true });
    fs.symlinkSync(outside, path.join(root, Store, 'handoffs'));
    expect(() => handoff(root, new Buf()), 'followed symlink').toThrow();
    expect(fs.readdirSync(outside), 'wrote outside').toEqual([]);
  });

  it('receive failure keeps waiting', () => {
    const { root, env } = fakeEnvironment();
    handoff(root, new Buf());
    const h = loadHandoff(root).handoff;
    const m = newToolchain(env);
    expect(() => receive(root, path.join(root, 'missing.mp3'), m), 'accepted missing audio').toThrow();
    expect(loadHandoff(root).handoff, 'marked missing audio received').toEqual(h);
  });
});
