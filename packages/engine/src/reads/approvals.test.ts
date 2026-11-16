import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check, Defaults, loadInventory, newEvent, newPhrase } from './reads';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-reads-approvals-'));
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

describe('Reading inventory compatibility', () => {
  it('checks approved cover duration and valid non-text intervals without editing source inventories', () => {
    const f = fixture();
    const original = fs.readFileSync(f.file);
    const inv = loadInventory(f.file);
    const report = check(inv, f.timeline, Defaults);
    expect(report.ok, report.problems.join('\n')).toBe(true);
    expect(report.events.map((event) => event.event_id)).toEqual(['cover-a', 'cover-b']);
    expect(report.hints?.join('\n')).toContain(f.approvalFile);
    expect(fs.readFileSync(f.file)).toEqual(original);
  });

  it('does not accept pending approvals or mismatched cover text', () => {
    const f = fixture();
    f.approval.status = 'PENDING';
    fs.writeFileSync(f.approvalFile, JSON.stringify(f.approval));
    expect(check(loadInventory(f.file), f.timeline, Defaults).ok).toBe(false);
    f.approval.status = 'APPROVED';
    f.approval.cover.titleLines[0] = '另一份封面';
    fs.writeFileSync(f.approvalFile, JSON.stringify(f.approval));
    expect(check(loadInventory(f.file), f.timeline, Defaults).ok).toBe(false);
  });

  it('still rejects short approved titles, invalid existence windows and early semantic graphics', () => {
    const f = fixture();
    f.events[0].readable_end_frame_exclusive = 1;
    f.events[2].exit_end_frame = 0;
    f.events[3].enter_frame = 0;
    f.write();
    const report = check(loadInventory(f.file), f.timeline, Defaults);
    expect(report.problems.some((problem) => problem.includes('读完'))).toBe(true);
    expect(report.problems.some((problem) => problem.includes('存在区间无效'))).toBe(true);
    expect(report.problems.some((problem) => problem.includes('graphic 在第 0 帧出现'))).toBe(true);
  });

  it('recognizes combined snake_case approvals only with matching actual project user evidence',()=>{
    const f=fixture();fs.unlinkSync(f.approvalFile);
    const root=path.resolve(path.dirname(f.approvalFile),'../..'),sessions=path.join(root,'production/studio/sessions');
    fs.mkdirSync(sessions,{recursive:true});
    const said='确认稿件、封面和读法，保留所选风格';
    const approval={approval:'script_cover_pronunciation_and_film_style',said,cover:{title_lines:['演示封面','第二行标题'],line_count:2}};
    const file=path.join(path.dirname(f.approvalFile),'script-v01.json'),events=path.join(sessions,'test.events.jsonl');
    fs.writeFileSync(file,JSON.stringify(approval));
    fs.writeFileSync(events,JSON.stringify({kind:'text',text:said})+'\n');
    expect(check(loadInventory(f.file),f.timeline,Defaults).ok).toBe(false);
    fs.appendFileSync(events,JSON.stringify({kind:'user',text:said})+'\n');
    expect(check(loadInventory(f.file),f.timeline,Defaults).ok).toBe(true);
    expect(loadInventory(f.file).approvedCover).toBeDefined();
    approval.said='未确认的另一句话';fs.writeFileSync(file,JSON.stringify(approval));
    expect(check(loadInventory(f.file),f.timeline,Defaults).ok).toBe(false);
  });
});
