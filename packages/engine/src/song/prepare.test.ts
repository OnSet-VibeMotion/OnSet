import { describe, expect, it } from 'vitest';
import { convertAlignment } from './prepare';
import { candidate } from './types';

describe('xingyu conversion', () => {
  it('converts and reports', () => {
    let raw = Buffer.from(
      '{"lines":[{"index":0,"text":"再唱 AI","start":1,"end":3,"status":"aligned","tokens":[{"text":"再唱","start":1,"end":2},{"text":"AI","start":2,"end":3,"estimated":true}]},{"index":1,"text":"再唱 AI","start":5,"end":7,"status":"aligned"}]}',
    );
    let got = convertAlignment(raw, candidate({ duration_seconds: 9 }), ['再唱 AI', '再唱 AI']);
    const tl = got.timeline;
    expect(got.issues).toEqual([]);
    expect(tl.lines!.length).toBe(2);
    expect(tl.lines![0].id).not.toBe(tl.lines![1].id);
    expect(tl.lines![0].words!.length).toBe(1);
    expect((tl.warnings ?? []).length).toBeGreaterThan(0);
    raw = Buffer.from('{"lines":[{"index":0,"text":"词","start":null,"end":3,"status":"missing_timestamps"}]}');
    got = convertAlignment(raw, candidate({ duration_seconds: 9 }), ['词']);
    expect(got.issues.length).toBeGreaterThan(0);
    expect(got.issues[0]).toContain('时间');
  });
});
