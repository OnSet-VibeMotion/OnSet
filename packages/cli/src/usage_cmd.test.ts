//
// TestConsolidateRecordsDrafterUsageInMemoryStore（整理者的用量记在记忆库的账本里）移植在 memory_cmd.test.ts，
// 与 onset memory 的其余用例放在一起。
import { Buffer, hasFfmpeg, lookPath, makeClip, run, setenv, tempDir } from './testutil';
import fs from 'node:fs';
import { writeShellFixture } from '@onset/engine/testsupport/windowsfixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ledger from '@onset/engine/ledger';
import { skillsProgressPrinter } from './cli';

describe('usage', () => {
  // 每次渲染打印用量，run-all 报告带每个镜头与整批的合计，onset scene usage 把归档的尝试也算进去。
  it.skipIf(!hasFfmpeg)('render usage is reported and totalled', async () => {
    const project = tempDir();
    const binDir = tempDir();
    const source = path.join(tempDir(), 'source.mp4');
    makeClip(source, 'testsrc=size=320x240:rate=30:duration=1');
    const script =
      "#!/bin/sh\nset -eu\n" +
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":50}}'\n` +
      "/bin/cp '" +
      source +
      "' out.mp4\n";
    writeShellFixture(path.join(binDir, 'codex'), script);
    fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    for (const id of ['scene-001', 'scene-002']) {
      const dir = path.join(project, 'scenes', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
      fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n');
      fs.writeFileSync(
        path.join(dir, 'scene.json'),
        `{"id":"${id}","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文"}`,
      );
    }
    process.chdir(project);
    setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')));
    setenv('HOME', tempDir());

    let out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['scene', 'run', 'scenes/scene-001'], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('[scene-001] 用量：输入 1,000（其中缓存 600）· 输出 50 · 合计 1,050 token');
    out = new Buffer();
    const reportPath = path.join(project, 'report.json');
    expect(await run(['scene', 'run-all', 'scenes/', '--force', '--retries', '0', '--report-json', reportPath], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('用量合计：输入 2,000');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.usage.input_tokens).toBe(2000);
    expect(report.scenes[0].usage?.output_tokens).toBe(50);
    out = new Buffer();
    expect(await run(['scene', 'usage', 'scenes/'], out, errOut), errOut.text).toBe(0);
    // scene-001 渲染过两次（第一次被 run-all 归档进 attempts/），都要算进去。
    expect(out.text).toContain('scene-001：2 次尝试（2 次成功）· 输入 2,000');
    expect(out.text).toContain('合计：输入 3,000');
  });

  it('onset usage totals orchestrator and render usage', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    process.chdir(root);
    // 客户端每一轮对话记一行账（studio/sessions.ts 的 recordUsage）；这里直接写两行同样的账。
    for (let i = 0; i < 2; i++) {
      ledger.append(ledger.projectFile(root), {
        time: '2026-11-09T00:00:00Z',
        source: ledger.SourceStudio,
        tool: 'codex',
        model: 'gpt-test',
        session: 'th-1',
        status: 'succeeded',
        usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, basis: 'total-input', source: 'codex turn.completed' },
      });
    }
    let out = new Buffer();
    const entries = ledger.read(ledger.projectFile(root));
    expect(entries?.length).toBe(2);
    const e = entries![0];
    expect([e.source, e.tool, e.model, e.session, e.status]).toEqual([ledger.SourceStudio, 'codex', 'gpt-test', 'th-1', 'succeeded']);
    expect(e.usage?.input_tokens).toBe(1000);

    // 一个镜头有一次渲染尝试，也计入合计。
    const dir = path.join(root, 'scenes', 's1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
    fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n');
    fs.writeFileSync(
      path.join(dir, 'scene.json'),
      '{"id":"s1","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文"}',
    );
    const attempt = '{"scene_id":"s1","renderer":"claude","outcome":"succeeded","usage":{"input_tokens":300,"output_tokens":20,"basis":"total-input","source":"claude result"}}';
    fs.writeFileSync(path.join(dir, 'render-s1.attempt.json'), attempt);

    out = new Buffer();
    expect(await run(['usage', '--json'], out, out), out.text).toBe(0);
    const report = JSON.parse(out.text);
    expect(report.orchestrator.calls).toBe(2);
    expect(report.orchestrator.total.input_tokens).toBe(2000);
    expect((report.total.input_tokens ?? 0) + (report.total.output_tokens ?? 0)).toBe(2 * 1050 + 320);
    expect(Object.keys(report.orchestrator.by_model)).toContain('codex/gpt-test');
    out = new Buffer();
    expect(await run(['usage'], out, out), out.text).toBe(0);
    for (const want of ['渲染：1 个镜头、1 次尝试', '编排：2 次调用', 'Studio', '本项目合计：输入 2,300']) expect(out.text).toContain(want);
  });

  it('usage --breakdown reports cache hit rate, retry/repair waste and top scenes', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    process.chdir(root);
    ledger.append(ledger.projectFile(root), {
      time: '2026-11-09T00:00:00Z',
      source: ledger.SourceStudio,
      tool: 'codex',
      model: 'gpt-test',
      session: 'th-1',
      status: 'succeeded',
      usage: { input_tokens: 1000, cached_input_tokens: 750, output_tokens: 100, basis: 'total-input', source: 'codex turn.completed' },
    });
    const makeScene = (id: string) => {
      const dir = path.join(root, 'scenes', id);
      fs.mkdirSync(path.join(dir, 'attempts', 'attempt-01'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
      fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n');
      fs.writeFileSync(
        path.join(dir, 'scene.json'),
        `{"id":"${id}","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文"}`,
      );
      return dir;
    };
    const s1 = makeScene('scene-001');
    fs.writeFileSync(
      path.join(s1, 'attempts', 'attempt-01', 'render-scene-001.attempt.json'),
      JSON.stringify({
        scene_id: 'scene-001',
        renderer: 'claude',
        outcome: 'failed',
        usage: { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 200, turns: 4, basis: 'total-input', source: 'claude result' },
      }),
    );
    fs.writeFileSync(
      path.join(s1, 'render-scene-001.attempt.json'),
      JSON.stringify({
        scene_id: 'scene-001',
        renderer: 'claude',
        outcome: 'succeeded',
        retry: true,
        usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 150, turns: 3, basis: 'total-input', source: 'claude result' },
      }),
    );
    fs.writeFileSync(
      path.join(s1, 'render-scene-001.stream.jsonl'),
      [
        '{"event":"step_update","step_update":{"step_index":10,"state":"ACTIVE","step_type":"tool","tool_name":"mcp_onset_scene_preview_check","tool_info":{"parameters":{"frames":"0,15,29"}}}}',
        '{"event":"step_update","step_update":{"step_index":10,"state":"DONE","step_type":"tool","tool_name":"mcp_onset_scene_preview_check","tool_info":{"parameters":{"frames":"0,15,29"},"output":"ok scene_preview_check"}}}',
        '{"event":"step_update","step_update":{"step_index":15,"state":"ACTIVE","step_type":"tool","tool_name":"mcp_onset_scene_preview_check","tool_info":{"parameters":{"zoom_frame":"0"}}}}',
        '{"event":"step_update","step_update":{"step_index":15,"state":"DONE","step_type":"tool","tool_name":"mcp_onset_scene_preview_check","tool_info":{"parameters":{"zoom_frame":"0"}}}}',
        '{"event":"result","result":{"response":"已通过 scene_preview_check 验收"}}',
      ].join('\n') + '\n',
    );
    const s2 = makeScene('scene-002');
    fs.writeFileSync(
      path.join(s2, 'render-scene-002.stream.jsonl'),
      [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call-bash-1","name":"Bash","input":{"command":"hyperframes snapshot --at 0.5"}}]}}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"scene_preview_check","input":{}}]}}',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(s2, 'render-scene-002.attempt.json'),
      JSON.stringify({
        scene_id: 'scene-002',
        renderer: 'claude',
        outcome: 'succeeded',
        local_repair: true,
        usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 50, turns: 2, basis: 'total-input', source: 'claude result' },
      }),
    );

    let out = new Buffer();
    expect(await run(['usage', '--breakdown', '--json'], out, out), out.text).toBe(0);
    const data = JSON.parse(out.text);
    expect(data.breakdown.orchestrator_cache_hit_rate).toBe(75);
    expect(data.breakdown.render_cache_hit_rate).toBe(57.1);
    expect(data.breakdown.retry_and_repair_input_tokens).toBe(1500);
    expect(data.breakdown.retry_and_repair_output_tokens).toBe(200);
    expect(data.breakdown.top_scenes[0]).toMatchObject({
      scene_id: 'scene-001',
      attempts: 2,
      retries: 1,
      repairs: 0,
      turns: 7,
      preview_calls: 2,
    });
    expect(data.breakdown.top_scenes[1]).toMatchObject({
      scene_id: 'scene-002',
      attempts: 1,
      retries: 0,
      repairs: 1,
      preview_calls: 2,
    });

    out = new Buffer();
    expect(await run(['usage', '--breakdown'], out, out), out.text).toBe(0);
    for (const want of ['降本诊断拆账', '缓存命中率：渲染 57.1%，编排 75.0%', '重试与返修消耗：输入 1500，输出 200', 'scene-001', '预览 2 次']) {
      expect(out.text).toContain(want);
    }
  });


  it('skills progress printer refreshes one line', () => {
    const out = new Buffer();
    const print = skillsProgressPrinter(out);
    print({ stage: '下载技能仓库', percent: 35.2 });
    print({ stage: '下载技能仓库', percent: 35.4 });
    print({ stage: '下载技能文件', percent: 72, indeterminate: true });
    print({ stage: '完成', percent: 100 });
    const text = out.text;
    expect(text.split('下载技能仓库').length - 1).toBe(1);
    expect(text).toContain(' 35%');
    expect(text).toContain('下载技能文件');
    expect(text.endsWith('100%\n')).toBe(true);
  });
});
