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
    expect(() => validateEdits({ elements: { '#[': { selector: '#[', opacity: 0.5 } } })).toThrow(/选择器/);
    expect(() => validateEdits({ elements: { 'div(': { selector: 'div(', text: 'hi' } } })).toThrow(/选择器/);
    // CSS.escape 生成的转义括号在引号外也应视为合法选择器。
    expect(validateEdits({ elements: { '#part\\(one': { selector: '#part\\(one', dx: 4 } } }).elements['#part\\(one']?.dx).toBe(4);
    expect(() => validateEdits({ elements: { '#x': { selector: '#x', backgroundColor: 'url(javascript:alert(1))' } } })).toThrow(/背景颜色/);
    expect(() => validateEdits({ elements: { '#x': { selector: '#x', opacity: 2 } } })).toThrow(/范围/);
  });

  it('keeps generated script opacity idempotent across repeated init events, respects page-written opacity, and isolates querySelector errors', () => {
    const script = buildEditsScript({
      schema: 1,
      elements: {
        '#[': { selector: '#[', opacity: 0.5 },
        '#title': { selector: '#title', opacity: 0.8, text: '新文案' },
      },
    });
    const styleState: Record<string, string> = {};
    const titleEl = {
      textContent: '旧文案',
      children: [] as unknown[],
      firstChild: null as unknown,
      dataset: {} as Record<string, string>,
      style: {
        get opacity() {
          return styleState.opacity ?? '';
        },
        set opacity(v: string) {
          styleState.opacity = v;
        },
        removeProperty(name: string) {
          delete styleState[name];
        },
      },
    };
    const docListeners: Record<string, Array<() => void>> = {};
    const winListeners: Record<string, Array<() => void>> = {};
    let frameOpacity = '1';
    const hf = {
      seek(t: number) {
        frameOpacity = t > 0 ? '0.5' : '1';
        titleEl.style.opacity = frameOpacity;
      },
    };
    const fakeDoc = {
      readyState: 'loading',
      querySelector(sel: string) {
        if (sel === '#[') throw new SyntaxError('invalid selector');
        return sel === '#title' ? titleEl : null;
      },
      addEventListener(name: string, fn: () => void) {
        (docListeners[name] ??= []).push(fn);
      },
    };
    const fakeWin = {
      __hf: hf,
      addEventListener(name: string, fn: () => void) {
        (winListeners[name] ??= []).push(fn);
      },
    };
    const fn = new Function('window', 'document', 'getComputedStyle', script);
    fn(fakeWin, fakeDoc, () => ({ opacity: frameOpacity }));
    expect(titleEl.textContent).toBe('新文案');
    expect(Number(titleEl.style.opacity)).toBeCloseTo(0.8, 5);
    // DOMContentLoaded 重复初始化不叠乘（仍是 0.8，而不是 0.64）。
    expect(docListeners.DOMContentLoaded?.length).toBe(1);
    expect(winListeners.load?.length).toBe(1);
    docListeners.DOMContentLoaded![0]!();
    expect(Number(titleEl.style.opacity)).toBeCloseTo(0.8, 5);
    // 若页面自己的逻辑在 load 前新写入了 0.5，load 时的 apply 应以 0.5 为基值得到 0.4，不回退到旧基值 1。
    titleEl.style.opacity = '0.5';
    winListeners.load![0]!();
    expect(Number(titleEl.style.opacity)).toBeCloseTo(0.4, 5);
    // 模拟 CSSOM 将 0.7 * 0.8 = 0.5599999999999999 序列化为 "0.56"：再次触发 load/apply 不得继续衰减成 0.448。
    const origSet = Object.getOwnPropertyDescriptor(titleEl.style, 'opacity')!.set!;
    Object.defineProperty(titleEl.style, 'opacity', {
      configurable: true,
      get: () => styleState.opacity ?? '',
      set: (v: string) => origSet(v === '0.5599999999999999' ? '0.56' : v),
    });
    titleEl.style.opacity = '0.7';
    winListeners.load![0]!();
    expect(titleEl.style.opacity).toBe('0.56');
    winListeners.load![0]!();
    expect(titleEl.style.opacity).toBe('0.56');
    // seek 到动画不透明度 0.5 的帧后，按当前帧基值乘以 0.8 = 0.4。
    hf.seek(1);
    expect(Number(titleEl.style.opacity)).toBeCloseTo(0.4, 5);
  });

  it('rejects symlinked onset-edits.json outside sceneDir on readEdits and rolls back index.html if JSON commit fails', () => {
    const dir = mkScene(sampleHtml);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-outside-'));
    try {
      const secret = path.join(outside, 'leak.json');
      fs.writeFileSync(secret, JSON.stringify({ schema: 1, elements: { '#title': { selector: '#title', text: 'secret' } } }));
      fs.symlinkSync(secret, path.join(dir, EditsFile));
      expect(() => readEdits(dir)).toThrow(/超出|链接|目录/);
      // writeEdits 也在写 HTML 前拒绝越界符号链接，不污染 index.html。
      expect(() => writeEdits(dir, { schema: 1, elements: { '#title': { selector: '#title', dx: 10 } } })).toThrow(/超出|链接|目录/);
      expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(sampleHtml);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }

    // HTML 已写入后第二次提交（写 onset-edits.json）失败时，必须把 index.html 完整回滚到原始字节。
    const rollbackDir = mkScene(sampleHtml);
    try {
      fs.mkdirSync(path.join(rollbackDir, EditsFile));
      expect(() => writeEdits(rollbackDir, { schema: 1, elements: { '#title': { selector: '#title', dx: 12 } } })).toThrow();
      expect(fs.readFileSync(path.join(rollbackDir, 'index.html'), 'utf8')).toBe(sampleHtml);
    } finally {
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    }
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
