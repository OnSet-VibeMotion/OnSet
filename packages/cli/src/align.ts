/**
 * 强制对齐映射的操作：从终稿导出朗读文本，再把对齐结果映射回终稿，写出 voice.srt 与 phrase-timeline.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as align from '@am/engine/align';
import { atomicWrite } from '@am/engine/fsutil';
import { formatFixed } from '@am/engine/gofmt';
import { ExitError } from './cobra';
import { defineGroup } from './ops/cli';
import { num, projectRoot, str, strs } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['align'],
  summary: '由代码把强制对齐结果映射回终稿，产出字幕与短语时间轴',
  description: `对齐工具只认送进 TTS 的文本（年份写成逐位汉字、缩写拆成字母），输出的又是
丢了标点的逐字时间。把它对回终稿原文、再切字幕、给每个受保护短语算帧号，
几千个字靠人眼做不可靠：错一个字后面整串错位，而且错得悄无声息。这组操作
把这一步交给代码。

流程：
  align_text()                  从终稿导出朗读文本 tts-text.txt，送 TTS 与对齐工具
  （跑 TTS 与强制对齐，结果存为 production/audio/align.json）
  align_build({"fps": 30})     映射回终稿，写出 voice.srt、phrase-timeline.json 与报告

终稿 production/script-final.md 的标记：
  <显示|朗读>       显示与朗读不同：<2024年|二零二四年>、<API|A P I>
  <|嗯>             只朗读、不显示
  <显示|>           只显示、不朗读（没有自己的时间，随所在字幕）
  @{id}…@{/id}      受保护短语，写进 phrase-timeline.json；id 用小写字母、数字、_、-，
                    可以嵌套，不能交叉
  # 开头的行        标题，忽略
  空行              分段
  \\< \\> \\@ \\| \\\\    转义`,
});

const alignRoot = { ...projectRoot, description: '项目根目录，用于定位 production/ 下的默认文件' };

/** 参数为空时取项目里的缺省路径。 */
function inProject(root: string, value: unknown, fallback: string): string {
  return str(value) !== '' ? str(value) : path.join(root, fallback);
}

defineOp({
  name: 'align_text',
  cli: ['align', 'text'],
  summary: '从终稿导出送进 TTS 的朗读文本与交给对齐工具的对齐文本',
  description: `解析终稿标记，取朗读侧文本：<显示|朗读> 取朗读，# 开头的行丢掉，段与段之间换行，
标点保留（TTS 靠它断句）。写出两份：

  tts-text.txt     送进 TTS
  align-text.txt   交给强制对齐工具：与 tts-text.txt 相同，只是去掉了声音事件（<|[笑]> 这类）

声音事件发出的是笑声、叹气，不是字，留在对齐文本里会让对齐工具把它们当字硬塞进去。
没有声音事件时两份内容相同。TTS 与强制对齐都必须用这两份文本，align_build() 才能
逐字对回终稿。标记写错时报出行号与列号。`,
  examples: ['align_text()', 'align_text({"script": "production/script-final.md", "out": "production/audio/tts-text.txt"})'],
  params: {
    script: { type: 'string', description: '终稿，缺省为 <project_root>/production/script-final.md' },
    out: { type: 'string', description: '朗读文本输出，缺省为 <project_root>/production/audio/tts-text.txt' },
    align_out: { type: 'string', description: '对齐文本输出，缺省为朗读文本同目录的 align-text.txt' },
    project_root: alignRoot,
  },
  run: (p, { out: w }) => {
    const root = str(p.project_root);
    const script = align.loadScript(inProject(root, p.script, 'production/script-final.md'));
    const spoken = script.spokenText();
    if (spoken === '') throw new Error('终稿没有任何朗读内容');
    const out = inProject(root, p.out, 'production/audio/tts-text.txt');
    atomicWrite(out, spoken, 0o644);
    const alignOut = str(p.align_out) !== '' ? inProject(root, p.align_out, '') : path.join(path.dirname(out), 'align-text.txt');
    atomicWrite(alignOut, script.alignText(), 0o644);
    const events = script.hasVocalEvents() ? '，声音事件已从对齐文本里去掉' : '';
    w.write(`已写出朗读文本：${out}（${script.tokens.length} 个朗读单元，${script.phrases.length} 个受保护短语）\n已写出对齐文本：${alignOut}${events}\n`);
    return { data: { out, align_out: alignOut, tokens: script.tokens.length, phrases: script.phrases.length, vocal_events: script.hasVocalEvents() } };
  },
});

defineOp({
  name: 'align_build',
  cli: ['align', 'build'],
  summary: '把对齐结果映射回终稿，写出 voice.srt 与 phrase-timeline.json',
  description: `用动态规划把终稿朗读单元与对齐结果逐个配对（一个汉字、一个英文词或一个数是一个
单元），配对分组最多 4 对 4，每个单元带一个标签：
  exact               一对一，文本相同
  split / merge       分段不同但拼起来文本相同（例如 API 被对成 A、P、I）
  replacement         文本不同（读错、多音字、对齐工具认错）
  source-omission     终稿有、配音里找不到（TTS 漏读或对齐丢了），时间按前后插值
  evidence-insertion  配音里有、终稿没有（多读）

对齐结果（align，可给多个）：
  格式没有逐一实测，读取是宽容的。认得的形状：
    规范形状  ` +
      align.CanonicalShape +
      `
    funasr    [{"text":"空格 分隔 的 字","timestamp":[[起毫秒,止毫秒],...]}]
    其他      JSON 中第一个「每个元素都有 text/word/char/token 与数值起止」的对象数组，
              起止字段 start/end、start_time/end_time 按秒，start_ms/end_ms 按毫秒
  认不出时报出顶层结构，请转换成规范形状。
  分段对齐时写 文件@偏移秒数，偏移是该段在整条配音里的起点，各段按给出顺序首尾相接。

产物：
  voice.srt             显示文本的句级字幕，按 。！？!?；; 与分段断句，超过 32 个阅读单位
                        再在 ，、, 处切；起止取其中朗读单元的起止，毫秒精度，互不重叠
  phrase-timeline.json  {"schema":1,"fps":30,"phrases":[{"phrase_id","subtitle_index",
                        "source_text","semantic_order","start_ms","end_ms","start_frame",
                        "end_frame_exclusive","alignment_source","confidence","reviewed",
                        "visible_event_ids"}]}
                        帧号用与卡点同一个换算（秒 × fps 四舍五入），终点至少比起点多一帧。
                        已有文件里的 visible_event_ids 与 reviewed 按 phrase_id 保留；
                        终稿里已删掉的短语移除并列进提示。
  align-report.json     标签统计、匹配率、逐短语置信度、全部非精确匹配的位置，以及
                        problems / hints

修正层（adjust，缺省读 production/phrase-adjust.json，不存在则跳过）：
  {"schema":1,"adjustments":[{"phrase_id","edge":"start"|"end","frame":N,"reason":"…"}]}
  实测确实不对时用它改短语边界，不要手改 phrase-timeline.json——下次构建会被覆盖。
  未知短语、同一边界重复、帧号越界、改完起点不早于终点、reason 为空都直接报错。
  被修正的短语 alignment_source 为 adjusted，reviewed 为 true。

判为问题（仍写出全部产物，操作失败）：
  - 受保护短语里有字被判为 source-omission，或整个短语的时间都是插值
  - exact + split + merge 占全部朗读单元不到 85%（送进对齐的文本多半不是 align_text() 那份）
  - 对齐结果为空，或多段平移后前后重叠（偏移写错）
只进 hints：多读、读法不同、置信度低于 0.9 的短语。`,
  examples: [
    'align_build({"fps": 30})',
    '# 长配音分段对齐，第二段从 312.48 秒开始',
    'align_build({"fps": 30, "align": ["production/audio/align-01.json", "production/audio/align-02.json@312.48"]})',
  ],
  params: {
    fps: { type: 'integer', description: '帧率，必须与 frame.md 的 canvas.fps 一致' },
    script: { type: 'string', description: '终稿，缺省为 <project_root>/production/script-final.md' },
    align: { type: 'strings', description: '对齐结果 文件[@偏移秒数]，可给多个，按顺序拼接；缺省为 <project_root>/production/audio/align.json' },
    adjust: { type: 'string', description: '短语边界修正层，缺省为 <project_root>/production/phrase-adjust.json（不存在则跳过）' },
    srt_out: { type: 'string', description: '字幕输出，缺省为 <project_root>/production/audio/voice.srt' },
    phrases_out: { type: 'string', description: '短语时间轴输出，缺省为 <project_root>/production/phrase-timeline.json' },
    report_json: { type: 'string', description: '报告输出，缺省为 <project_root>/production/audio/align-report.json' },
    project_root: alignRoot,
  },
  run: (p, { out }) => {
    const root = str(p.project_root);
    const fps = num(p.fps);
    if (fps <= 0) throw new Error('fps 必须是正整数，与 frame.md 的 canvas.fps 一致');
    const script = align.loadScript(inProject(root, p.script, 'production/script-final.md'));
    const alignFlags = strs(p.align);
    const flags = alignFlags.length ? alignFlags : [path.join(root, 'production/audio/align.json')];
    const items = align.loadSegments(flags.map((value) => align.parseSegmentFlag(value)));
    const opts: align.Options = { fps };
    const explicitAdjust = str(p.adjust) !== '';
    const adjust = inProject(root, p.adjust, 'production/phrase-adjust.json');
    if (fs.existsSync(adjust) || explicitAdjust) opts.adjust = align.loadAdjust(adjust);
    const phrases = inProject(root, p.phrases_out, 'production/phrase-timeline.json');
    opts.existing = align.loadExistingTimeline(phrases);
    const result = align.build(script, items, opts);
    const srt = inProject(root, p.srt_out, 'production/audio/voice.srt');
    const report = inProject(root, p.report_json, 'production/audio/align-report.json');
    align.writeSRT(srt, result.cues);
    align.writeJSON(phrases, align.timelineToJSON(result.timeline));
    const reportJSON = align.reportToJSON(result.report);
    align.writeJSON(report, reportJSON);
    const r = result.report;
    const labels = align.sortedLabels(r).map((label) => `${label} ${r.labels[label]}`);
    out.write(`已写出 ${srt}（${result.cues.length} 条字幕）、${phrases}（${result.timeline.phrases?.length ?? 0} 个短语）、${report}\n`);
    out.write(`朗读单元 ${r.tokens} 个，匹配率 ${formatFixed(r.match_rate * 100, 1)}%（${labels.join('，')}），共 ${r.total_frames} 帧\n`);
    for (const hint of r.hints ?? []) out.write(`提示：${hint}\n`);
    if (!r.ok) throw new ExitError(1, `对齐映射未通过（产物已写出，详见 ${report}）：\n  - ${(r.problems ?? []).join('\n  - ')}`);
    return { data: { srt, phrases, report, cues: result.cues.length, match_rate: r.match_rate, total_frames: r.total_frames, hints: r.hints ?? [] } };
  },
});
