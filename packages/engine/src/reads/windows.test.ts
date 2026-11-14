import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check, Defaults, loadInventory, newEvent, newPhrase } from './reads';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-reads-windows-'));
  roots.push(root);
  const directory = path.join(root, 'scenes', 'scene-demo');
  const approvals = path.join(root, 'production', 'approvals');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(approvals, { recursive: true });
  const file = path.join(directory, 'visible-event-inventory.json');
  const events = [
    { ...newEvent({ event_id: 'cover-a', text: '演示封面', role: 'cover', phrase_id: 'p1', readable_end_frame_exclusive: 45, exit_end_frame: 50 }), exception: 'approved_theme_preview' },
    { ...newEvent({ event_id: 'cover-b', text: '第二行标题', role: 'cover', phrase_id: 'p1', readable_end_frame_exclusive: 45, exit_end_frame: 50 }), exception: 'approved_theme_preview' },
    { ...newEvent({ event_id: 'background', role: 'decorative', enter_frame: 0, exit_end_frame: 120 }), readable_start_frame: null, readable_end_frame_exclusive: null },
    { ...newEvent({ event_id: 'graphic', role: 'graphic', phrase_id: 'p1', enter_frame: 20, exit_end_frame: 120 }), readable_start_frame: null, readable_end_frame_exclusive: null },
  ];
  const write = () => fs.writeFileSync(file, JSON.stringify({ schema: 1, fps: 30, events }));
  write();
  const approval = { status: 'APPROVED', cover: { textAndLineCountApproved: true, frame: 0, titleLines: ['演示封面', '第二行标题'], lineCount: 2, actualImagePreviewApproved: false } };
  const approvalFile = path.join(approvals, 'cover-style-v01.json');
  fs.writeFileSync(approvalFile, JSON.stringify(approval));
  const timeline = { fps: 30, phrases: [newPhrase({ phrase_id: 'p1', semantic_order: 1, start_frame: 7, end_frame_exclusive: 100 })] };
  return { file, events, write, approval, approvalFile, timeline };
}

describe('Windows reading inventory compatibility', () => {
  it('checks approved cover duration and valid non-text intervals without editing source inventories', () => {
    const f = fixture();
    const original = fs.readFileSync(f.file);
    const inv = loadInventory(f.file, 'win32');
    const report = check(inv, f.timeline, { ...Defaults, platform: 'win32' });
    expect(report.ok, report.problems.join('\n')).toBe(true);
    expect(report.events.map((event) => event.event_id)).toEqual(['cover-a', 'cover-b']);
    expect(report.hints?.join('\n')).toContain(f.approvalFile);
    expect(fs.readFileSync(f.file)).toEqual(original);
  });

  it.each(['darwin', 'linux'] as const)('preserves %s behavior for the same inventory', (platform) => {
    const f = fixture();
    const inv = loadInventory(f.file, platform);
    expect(inv.windowsApprovedCover).toBeUndefined();
    const report = check(inv, f.timeline, { ...Defaults, platform });
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes('早于绑定短语'))).toBe(true);
    expect(report.problems.some((problem) => problem.includes('background 的帧号顺序'))).toBe(true);
  });

  it('does not accept pending approvals or mismatched cover text', () => {
    const f = fixture();
    f.approval.status = 'PENDING';
    fs.writeFileSync(f.approvalFile, JSON.stringify(f.approval));
    expect(check(loadInventory(f.file, 'win32'), f.timeline, { ...Defaults, platform: 'win32' }).ok).toBe(false);
    f.approval.status = 'APPROVED';
    f.approval.cover.titleLines[0] = '另一份封面';
    fs.writeFileSync(f.approvalFile, JSON.stringify(f.approval));
    expect(check(loadInventory(f.file, 'win32'), f.timeline, { ...Defaults, platform: 'win32' }).ok).toBe(false);
  });

  it('still rejects short approved titles, invalid existence windows and early semantic graphics', () => {
    const f = fixture();
    f.events[0].readable_end_frame_exclusive = 1;
    f.events[2].exit_end_frame = 0;
    f.events[3].enter_frame = 0;
    f.write();
    const report = check(loadInventory(f.file, 'win32'), f.timeline, { ...Defaults, platform: 'win32' });
    expect(report.problems.some((problem) => problem.includes('读完'))).toBe(true);
    expect(report.problems.some((problem) => problem.includes('存在区间无效'))).toBe(true);
    expect(report.problems.some((problem) => problem.includes('graphic 在第 0 帧出现'))).toBe(true);
  });
});
