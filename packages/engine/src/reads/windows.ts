import fs from 'node:fs';
import path from 'node:path';
import type { Inventory } from './reads';

const normalized = (text: string): string => text.replace(/[\t\n\r ]/g, '');

function confirmedByProjectUser(root: string, said: unknown): boolean {
  if(typeof said!=='string'||said.trim()==='')return false;
  const directory=path.join(root,'production/studio/sessions');
  if(!fs.existsSync(directory))return false;
  for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.events.jsonl')).sort()){
    try{
      const file=fs.realpathSync(path.join(directory,name)),relative=path.relative(fs.realpathSync(root),file);
      if(relative.startsWith('..')||path.isAbsolute(relative))continue;
      for(const line of fs.readFileSync(file,'utf8').split('\n')){
        try{const event=JSON.parse(line);if(event.kind==='user'&&event.text?.trim()===said.trim())return true;}catch{/* A partially written event is not approval evidence. */}
      }
    }catch{/* Unreadable session evidence cannot grant an exception. */}
  }
  return false;
}

/** 仅 Windows 的清单适配：批准的是封面主题提前出现，阅读时间与实际画面仍照常检查。 */
export function approvedWindowsCover(file: string): { ids: Set<string>; approval: string } | undefined {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { events?: unknown[] };
  const events = (raw.events ?? []).filter((event): event is Record<string, unknown> => event !== null && typeof event === 'object').filter((event) => event.role === 'cover' && event.exception === 'approved_theme_preview');
  if (events.length === 0) return;
  let root = path.dirname(path.resolve(file));
  for (;;) {
    const dir = path.join(root, 'production', 'approvals');
    if (fs.existsSync(dir)) {
      const realRoot = fs.realpathSync(root);
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names.filter((name) => /^(?:cover|script)[^/\\]*\.json$/.test(name)).sort()) {
        const approvalFile = path.join(dir, name);
        try {
          const relative = path.relative(realRoot, fs.realpathSync(approvalFile));
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
          const cover = approval.cover;
          const canonical=approval.status==='APPROVED'&&cover?.textAndLineCountApproved===true&&cover.frame===0;
          // Existing Windows projects also store the combined script/cover confirmation in snake_case.
          // Its exact quoted approval must occur as an actual project user event, never a tool output.
          const combined=approval.approval==='script_cover_pronunciation_and_film_style'&&(approval.status===undefined||approval.status==='APPROVED')&&confirmedByProjectUser(root,approval.said);
          if(!canonical&&!combined)continue;
          const lines:unknown[]=canonical?cover?.titleLines:cover?.title_lines;
          const count=canonical?cover?.lineCount:cover?.line_count;
          if (!Array.isArray(lines)||lines.length === 0 || count !== lines.length || !lines.every((line) => typeof line === 'string' && normalized(line) !== '')) continue;
          if (!events.every((event) => event.enter_frame === 0 && typeof event.event_id === 'string' && typeof event.text === 'string')) continue;
          const actual = events.map((event) => normalized(event.text as string));
          const expected = (lines as string[]).map(normalized);
          const matches = actual.length === expected.length && actual.every((text, index) => text === expected[index]);
          if (!matches && !(actual.length === 1 && actual[0] === expected.join(''))) continue;
          return { ids: new Set(events.map((event) => event.event_id as string)), approval: approvalFile };
        } catch { /* 损坏或不匹配的记录不构成批准。 */ }
      }
      return;
    }
    const parent = path.dirname(root);
    if (parent === root) return;
    root = parent;
  }
}

export function attachWindowsCover(inv: Inventory, file: string): Inventory {
  const approved = approvedWindowsCover(file);
  return approved ? { ...inv, windowsApprovedCover: approved } : inv;
}
