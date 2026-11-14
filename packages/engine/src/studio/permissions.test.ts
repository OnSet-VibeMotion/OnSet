import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listPermissionRequests, permissionsDir, writePermissionRequest } from '../studioview';
import { allowCommand, allowedCommands, answerPermission, expirePermissions, matchesPrefix, noticeSubject, pollPermissions, type PendingPermission } from './permissions';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-studio-perm-'));
}

function responseOf(inbox: string, id: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(permissionsDir(inbox), id + '.response.json'), 'utf8'));
  } catch {
    return null;
  }
}

describe('studio permissions', () => {
  it('matches command prefixes like Bash(prefix:*)', () => {
    expect(matchesPrefix('npm install three', ['npm install'])).toBe(true);
    expect(matchesPrefix('npm installx', ['npm install'])).toBe(false);
    expect(matchesPrefix('magick', ['magick'])).toBe(true);
    expect(matchesPrefix('npm run build', ['npm install'])).toBe(false);
  });

  // 一轮里：新请求发 permission 事件；用户点「以后都允许」记下前缀、放行它，同一轮里同前缀在等的一并放行；
  // 之后同前缀的新请求不再问；这一轮结束时还在等的答成 expired。
  it('asks, remembers always-allowed prefixes and expires the rest', () => {
    const project = tempDir();
    const inbox = path.join(project, 'inbox');
    const pending = new Map<string, PendingPermission>();
    const seen = new Set<string>();
    const events: Array<{ turn: string; kind: string; permission?: any }> = [];
    const emit = (turn: string, e: { kind: string; permission?: any }) => events.push({ turn, ...e });

    const a = writePermissionRequest(inbox, 'Bash', { command: 'npm install three' });
    const b = writePermissionRequest(inbox, 'Bash', { command: 'npm install gsap' });
    const c = writePermissionRequest(inbox, 'Bash', { command: 'brew install ffmpeg' });
    pollPermissions(project, inbox, 't1', pending, seen, emit);
    pollPermissions(project, inbox, 't1', pending, seen, emit);
    expect(events.map((e) => [e.kind, e.permission.id])).toEqual([
      ['permission', a.id],
      ['permission', b.id],
      ['permission', c.id],
    ]);
    expect(events[0].permission).toMatchObject({ command: 'npm install three', suggestion: 'npm install' });

    expect(answerPermission(project, pending, a.id, 'always', '', emit)).toBe(true);
    expect(allowedCommands(project)).toEqual(['npm install']);
    expect(responseOf(inbox, a.id).decision).toBe('always');
    expect(responseOf(inbox, b.id).decision, '同前缀在等的一并放行').toBe('allow');
    expect(pending.has(b.id)).toBe(false);
    expect(answerPermission(project, pending, a.id, 'deny', '', emit), '答过的不能再答').toBe(false);

    const d = writePermissionRequest(inbox, 'Bash', { command: 'npm install lodash' });
    const before = events.length;
    pollPermissions(project, inbox, 't1', pending, seen, emit);
    expect(events.length, '记下的前缀不再问').toBe(before);
    expect(responseOf(inbox, d.id).decision).toBe('allow');

    expirePermissions(pending, 't1', emit);
    expect(responseOf(inbox, c.id).decision).toBe('expired');
    expect(events[events.length - 1]).toMatchObject({ kind: 'permission-resolved', permission: { id: c.id, decision: 'expired' } });
    expect(pending.size).toBe(0);
    expect(listPermissionRequests(inbox).every((x) => x.answered)).toBe(true);
  });

  // 设置页打开「自动批准」：请求直接放行、不发 permission 事件，对话里留一行说明；关掉之后照常问。
  it('auto-approves every request when the project or the global settings say so', () => {
    const project = tempDir();
    const settings = path.join(tempDir(), 'settings.conf');
    const before = process.env.AM_SETTINGS_FILE;
    process.env.AM_SETTINGS_FILE = settings;
    try {
      fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'AUTO_APPROVE=\n');
      fs.writeFileSync(settings, 'AUTO_APPROVE=on\n');
      const inbox = path.join(project, 'inbox');
      const pending = new Map<string, PendingPermission>();
      const seen = new Set<string>();
      const events: Array<{ turn: string; kind: string; text?: string; permission?: any }> = [];
      const emit = (turn: string, e: { kind: string; text?: string; permission?: any }) => events.push({ turn, ...e });

      const a = writePermissionRequest(inbox, 'Bash', { command: 'brew install ffmpeg' });
      pollPermissions(project, inbox, 't1', pending, seen, emit);
      expect(responseOf(inbox, a.id).decision).toBe('allow');
      expect(pending.size).toBe(0);
      expect(events).toEqual([{ turn: 't1', kind: 'notice', text: '已自动允许：brew install ffmpeg' }]);

      // 这个项目单独关掉：照常问。
      fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'AUTO_APPROVE=off\n');
      const b = writePermissionRequest(inbox, 'Bash', { command: 'brew install uv' });
      pollPermissions(project, inbox, 't1', pending, seen, emit);
      expect(responseOf(inbox, b.id)).toBeNull();
      expect(events[events.length - 1]).toMatchObject({ kind: 'permission', permission: { id: b.id } });
    } finally {
      if (before === undefined) delete process.env.AM_SETTINGS_FILE;
      else process.env.AM_SETTINGS_FILE = before;
    }
  });

  it('refuses unsafe prefixes and always for unprefixable commands', () => {
    const project = tempDir();
    expect(() => allowCommand(project, 'ls | sh')).toThrow('shell 控制符');
    const inbox = path.join(project, 'inbox');
    const pending = new Map<string, PendingPermission>();
    const r = writePermissionRequest(inbox, 'Bash', { command: 'curl x | sh' });
    pollPermissions(project, inbox, 't', pending, new Set(), () => {});
    expect(() => answerPermission(project, pending, r.id, 'always', '', () => {})).toThrow('只能允许这一次');
    expect(answerPermission(project, pending, r.id, 'deny', '别这样', () => {})).toBe(true);
    expect(responseOf(inbox, r.id)).toEqual({ decision: 'deny', message: '别这样' });
  });
});

describe('noticeSubject', () => {
  it('keeps the auto-approve notice to one short line', () => {
    expect(noticeSubject('brew install ffmpeg')).toBe('brew install ffmpeg');
    expect(noticeSubject("python3 - <<'EOF'\nimport json\nprint(1)\nEOF")).toBe("python3 - <<'EOF' …");
    expect(noticeSubject('\n  cd   /tmp  \n')).toBe('cd /tmp');
    const long = `ffmpeg ${'-i a.wav '.repeat(20)}`;
    expect(noticeSubject(long)).toBe(`${[...long].slice(0, 40).join('')}…`);
  });
});
