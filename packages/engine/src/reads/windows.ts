import fs from 'node:fs';
import path from 'node:path';
import type { Inventory } from './reads';

const normalized = (text: string): string => text.replace(/[\t\n\r ]/g, '');

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
      for (const name of names.filter((name) => /^cover[^/\\]*\.json$/.test(name)).sort()) {
        const approvalFile = path.join(dir, name);
        try {
          const relative = path.relative(realRoot, fs.realpathSync(approvalFile));
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
          const cover = approval.cover;
          if (approval.status !== 'APPROVED' || cover?.textAndLineCountApproved !== true || cover.frame !== 0 || !Array.isArray(cover.titleLines)) continue;
          const lines: unknown[] = cover.titleLines;
          if (lines.length === 0 || cover.lineCount !== lines.length || !lines.every((line) => typeof line === 'string' && normalized(line) !== '')) continue;
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
