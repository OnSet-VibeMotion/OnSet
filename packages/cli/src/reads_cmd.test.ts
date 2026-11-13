// 移植自 internal/cli/reads_test.go。
// memory_test.go 的 TestValidateReadsRecordsFindingsPerScene（断言问题按镜头写进记忆库）移植在 memory_cmd.test.ts。
import { Buffer, run, tempDir } from './testutil';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('validate reads', () => {
  it('checks reading time and phrase binding', async () => {
    const root = tempDir();
    const production = path.join(root, 'production');
    fs.mkdirSync(production, { recursive: true });
    fs.writeFileSync(
      path.join(production, 'visible-event-inventory.json'),
      `{"schema":1,"fps":30,"events":[
 {"event_id":"a","scene_id":"scene-001","text":"一共分三步","role":"title","phrase_id":"p1","enter_frame":0,"readable_start_frame":5,"readable_end_frame_exclusive":60,"exit_end_frame":70}]}`,
    );
    let out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['validate', 'reads', '--project-root', root], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('跳过短语绑定');
    fs.writeFileSync(
      path.join(production, 'phrase-timeline.json'),
      '{"fps":30,"phrases":[{"phrase_id":"p1","semantic_order":1,"start_frame":30,"end_frame_exclusive":60}]}',
    );
    out = new Buffer();
    errOut = new Buffer();
    const report = path.join(root, 'reads.json');
    expect(await run(['validate', 'reads', '--project-root', root, '--report-json', report], out, errOut)).toBe(1);
    expect(errOut.text).toContain('早于绑定短语 p1');
    expect(fs.existsSync(report)).toBe(true);
  });

  it('rejects bad options and missing file', async () => {
    const out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['validate', 'reads', '--chars-per-second', '0'], out, errOut)).toBe(1);
    expect(errOut.text).toContain('--chars-per-second');
    errOut = new Buffer();
    expect(await run(['validate', 'reads', '--project-root', tempDir()], out, errOut)).toBe(1);
    expect(errOut.text).toContain('visible-event-inventory.json');
  });
});
