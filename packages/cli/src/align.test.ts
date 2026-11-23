import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as align from '@onset/engine/align';
import { readCues } from '@onset/engine/srt';
import { Buffer, tempDir } from './testutil';
import './align';
import { newRoot } from './cli';
import { ExitError } from './cobra';
import { findOp } from './ops/op';

/** runAlign：执行 onset align 子命令，返回 stdout 与错误。 */
async function runAlign(...args: string[]): Promise<{ out: string; err: unknown }> {
  const out = new Buffer();
  const { root: cmd } = newRoot(out, new Buffer());
  try {
    await cmd.execute(['align', ...args]);
    return { out: out.text, err: undefined };
  } catch (err) {
    return { out: out.text, err };
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function writeAlignFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** 把朗读文本逐单元写成规范形状的对齐结果，每个单元 0.1 秒。 */
function alignEvidence(file: string, spoken: string, start: number): void {
  const entries = align.tokenize(spoken).map((tok) => {
    const entry = { text: tok.text, start, end: start + 0.1 };
    start += 0.1;
    return entry;
  });
  writeAlignFile(file, JSON.stringify(entries));
}

describe('align', () => {
  it('text and build', async () => {
    const root = tempDir();
    writeAlignFile(
      path.join(root, 'production/script-final.md'),
      '# 标题\n\n@{year}<2024年|二零二四年>@{/year}，我们发布了@{api}<API|A P I>@{/api}。\n',
    );
    expect((await runAlign('text', '--project-root', root)).err).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'production/audio/tts-text.txt'), 'utf8')).toBe('二零二四年，我们发布了A P I。\n');
    alignEvidence(path.join(root, 'production/audio/align.json'), '二零二四年我们发布了API', 0.5);
    // 已有时间轴里手填的 visible_event_ids 要保留。
    writeAlignFile(
      path.join(root, 'production/phrase-timeline.json'),
      '{"schema":1,"fps":30,"phrases":[{"phrase_id":"api","reviewed":true,"visible_event_ids":["logo"]}]}',
    );

    const { out, err } = await runAlign('build', '--project-root', root, '--fps', '30');
    expect(err, `构建失败：${out}`).toBeUndefined();
    const cues = readCues(path.join(root, 'production/audio/voice.srt'));
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('2024年，我们发布了API。');
    expect(cues[0].start_seconds).toBe(0.5);
    const timeline = JSON.parse(fs.readFileSync(path.join(root, 'production/phrase-timeline.json'), 'utf8')) as {
      phrases: { visible_event_ids?: string[]; reviewed?: boolean }[];
    };
    expect(timeline.phrases).toHaveLength(2);
    expect(timeline.phrases[1].visible_event_ids?.[0]).toBe('logo');
    expect(timeline.phrases[1].reviewed).toBe(true);
    expect(fs.existsSync(path.join(root, 'production/audio/align-report.json')), '应写出报告').toBe(true);
  });

  it('build problems exit non-zero but write outputs', async () => {
    const root = tempDir();
    writeAlignFile(path.join(root, 'production/script-final.md'), '我们@{k}今天下午@{/k}出发去北京看看风景和朋友。\n');
    const seg = path.join(root, 'seg.json');
    alignEvidence(seg, '我们出发去北京看看风景和朋友', 0);
    const report = path.join(root, 'report.json');
    const { err } = await runAlign('build', '--project-root', root, '--fps', '25', '--align', seg + '@1.5', '--report-json', report);
    expect(err, '漏读受保护短语应以退出码 1 失败').toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
    expect(message(err)).toContain('短语 k');
    const parsed = JSON.parse(fs.readFileSync(report, 'utf8')) as { ok?: boolean; fps?: number };
    expect(parsed.ok ?? false).toBe(false);
    expect(parsed.fps).toBe(25);
    expect(fs.existsSync(path.join(root, 'production/audio/voice.srt')), '问题时仍应写出字幕').toBe(true);
  });

  it('build rejects bad input', async () => {
    const root = tempDir();
    writeAlignFile(path.join(root, 'production/script-final.md'), '你好<世界\n');
    expect(message((await runAlign('text', '--project-root', root)).err), '标记错误应报出位置').toContain('第 1 行第 3 列');
    expect(message((await runAlign('build', '--project-root', root)).err), '缺 fps 应报错').toContain('fps 必须');
    writeAlignFile(path.join(root, 'production/script-final.md'), '你好。\n');
    writeAlignFile(path.join(root, 'production/audio/align.json'), '{"result":{"words":[{"w":"你"}]}}');
    expect(message((await runAlign('build', '--project-root', root, '--fps', '30')).err), '认不出的对齐结果应报出顶层结构').toContain('键：result');
    alignEvidence(path.join(root, 'production/audio/align.json'), '你好', 0);
    writeAlignFile(
      path.join(root, 'production/phrase-adjust.json'),
      '{"schema":1,"adjustments":[{"phrase_id":"nope","edge":"start","frame":0,"reason":"x"}]}',
    );
    expect(message((await runAlign('build', '--project-root', root, '--fps', '30')).err), '修正层引用未知短语应报错').toContain('没有这个短语');
  });

  it('help is complete', () => {
    const problems: string[] = [];
    for (const name of ['align_text', 'align_build']) {
      const op = findOp(name);
      if (!op || (op.description ?? '').trim() === '' || !(op.examples ?? []).some((e) => e.startsWith(name + '('))) problems.push(`${name} 缺少说明或例子`);
    }
    expect(problems).toEqual([]);
    const build = findOp('align_build');
    expect(build?.description, 'align_build 的说明应写明规范形状与 funasr 形状').toContain('"start"');
    expect(build?.description).toContain('timestamp');
  });

  it('emits non-blocking hints when a long script lacks protected phrases or has overly long phrases', async () => {
    const root = tempDir();
    writeAlignFile(path.join(root, 'production/script-final.md'), '这是一段没有任何受保护短语标记的长口播文稿内容，用于测试系统是否会在导出朗读文本时给出温和的提示信息，帮助编排工具在配音前及时补标专有名词与核心概念。\n');
    const missing = await runAlign('text', '--project-root', root);
    expect(missing.err).toBeUndefined();
    expect(missing.out).toContain('还没有标注受保护短语');

    writeAlignFile(path.join(root, 'production/script-final.md'), '@{too-long}这是一个超过十六个阅读单位非常非常非常长的受保护短语@{/too-long}。\n');
    const long = await runAlign('text', '--project-root', root);
    expect(long.err).toBeUndefined();
    expect(long.out).toContain('受保护短语 too-long 偏长');
  });
});
