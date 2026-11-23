import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as determinism from '../determinism';
import { buildEditsCSS, buildEditsScript, EditsFile, emptyEdits, injectEditsHtml, readEdits, validateEdits, writeEdits } from './edits';

function mkScene(html: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-edits-'));
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  return dir;
}

const sampleHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>test</title></head>
  <body>
    <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="3">
      <div id="title">标题</div>
      <div id="bar" style="background: rgb(31, 155, 233);"></div>
    </div>
  </body>
</html>
`;

describe('scene edits', () => {
  it('validates, prunes no-op values, and rejects unsafe selectors or colors', () => {
    const clean = validateEdits({
      schema: 1,
      elements: {
        '#title': { selector: '#title', dx: 12.3456, dy: 0, scaleX: 1, scaleY: 1.25, rotate: -15, color: 'rgb(31, 155, 233)', text: '新标题' },
        '#noop': { selector: '#noop', dx: 0, dy: 0, scaleX: 1, scaleY: 1, rotate: 0 },
      },
    });
    expect(Object.keys(clean.elements)).toEqual(['#title']);
    expect(clean.elements['#title']).toEqual({
      selector: '#title',
      dx: 12.346,
      scaleY: 1.25,
      rotate: -15,
      color: 'rgb(31, 155, 233)',
      text: '新标题',
    });

    expect(() => validateEdits({ elements: { '#x } body { color: red': { selector: '#x } body { color: red', dx: 1 } } })).toThrow(/选择器/);
    expect(() => validateEdits({ elements: { '#x': { selector: '#x', backgroundColor: 'url(javascript:alert(1))' } } })).toThrow(/背景颜色/);
    expect(() => validateEdits({ elements: { '#x': { selector: '#x', opacity: 2 } } })).toThrow(/范围/);
  });

  it('writes deterministic CSS + JS into index.html that passes determinism.scan() cleanly', () => {
    const dir = mkScene(sampleHtml);
    try {
      const saved = writeEdits(dir, {
        schema: 1,
        elements: {
          '#title': { selector: '#title', dx: 24, dy: -10, scaleX: 1.2, scaleY: 1.2, rotate: 5, opacity: 0.8, fontSize: 64, color: '#ff5500', text: '改过的 </script> 标题' },
          '#bar': { selector: '#bar', backgroundColor: 'rgb(31, 155, 233)' },
          '#gone': { selector: '#gone', hidden: true },
        },
      });
      expect(readEdits(dir)).toEqual(saved);
      expect(fs.existsSync(path.join(dir, EditsFile))).toBe(true);

      const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
      expect(html).toContain('<!-- onset-edits:start -->');
      expect(html).toContain('translate: 24px -10px !important');
      expect(html).toContain('scale: 1.2 1.2 !important');
      expect(html).toContain('rotate: 5deg !important');
      expect(html).toContain('background-color: rgb(31, 155, 233) !important');
      expect(html).toContain('display: none !important');
      // Escaped </script> inside JSON payload so HTML script tag cannot break out.
      expect(html).not.toContain('改过的 </script>');
      expect(html).toContain('\\u003c/script>');

      const scan = determinism.scan(dir);
      expect(determinism.problems(scan)).toEqual([]);

      // Re-writing the same edits is idempotent.
      writeEdits(dir, saved);
      expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(html);

      // Clearing edits removes both the injected block and onset-edits.json.
      writeEdits(dir, emptyEdits());
      expect(fs.existsSync(path.join(dir, EditsFile))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(sampleHtml);
      expect(readEdits(dir)).toEqual(emptyEdits());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits script tag when only CSS properties are edited', () => {
    const edits = validateEdits({ elements: { '#bar': { selector: '#bar', backgroundColor: '#1f9be9' } } });
    expect(buildEditsCSS(edits)).toContain('background-color: #1f9be9 !important');
    expect(buildEditsScript(edits)).toBe('');
    const html = injectEditsHtml(sampleHtml, edits);
    expect(html).toContain('id="onset-edits-css"');
    expect(html).not.toContain('id="onset-edits-js"');
  });
});
