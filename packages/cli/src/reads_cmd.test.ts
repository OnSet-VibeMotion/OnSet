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

  it('accepts an explicitly empty film inventory only with evidence from every shot', async () => {
    const root = tempDir();
    const production = path.join(root, 'production');
    const scene = path.join(root, 'scenes/scene-001');
    fs.mkdirSync(production);
    fs.mkdirSync(scene, { recursive: true });
    fs.writeFileSync(path.join(scene, 'scene.json'), '{}');
    const empty = '{"schema":1,"fps":30,"events":[]}';
    fs.writeFileSync(path.join(production, 'visible-event-inventory.json'), empty);
    const args = ['validate', 'reads', '--project-root', root];
    expect(await run(args, new Buffer(), new Buffer())).toBe(1);
    fs.writeFileSync(path.join(scene, 'visible-events.json'), '{"schema":1,"fps":30}');
    expect(await run(args, new Buffer(), new Buffer())).toBe(1);
    fs.writeFileSync(path.join(scene, 'visible-events.json'), empty);
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(args, out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('0 个可读元素');
  });

  it('rejects bad options and missing file', async () => {
    const out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['validate', 'reads', '--chars-per-second', '0'], out, errOut)).toBe(1);
    expect(errOut.text).toContain('chars_per_second');
    errOut = new Buffer();
    expect(await run(['validate', 'reads', '--project-root', tempDir()], out, errOut)).toBe(1);
    expect(errOut.text).toContain('visible-event-inventory.json');
  });
});
