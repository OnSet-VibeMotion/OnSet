/**
 * 双跑对照用例（写法见 cases.mjs 开头的说明）。由 cases.mjs 汇总。
 * 覆盖 am memory 整组命令：帮助、空记忆库、带样例记忆库的确定性子命令。
 * 记忆库两边各用一份同样内容的副本（memory: true，见 run.mjs），比对写出的文件树。
 * consolidate / exam 不调用真实的 AI CLI，只跑参数错误、无事可做与 --drafts 的路径。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const goAm = process.env.AM_GO || path.join(os.homedir(), '.local/bin/am');

/** 时间戳、经历编号、批次编号这类每次运行必然不同的部分。 */
const scrub = [
  [/ep-\d{8}-\d{6}-[0-9a-f]+/g, 'ep-ID'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, 'TIME'],
  [/run-\d{8}-\d{6}/g, 'run-ID'],
  [/pref-\d{8}-\d{6}/g, 'pref-ID'],
  [/episodes\/\d{4}-\d{2}\//g, 'episodes/MONTH/'],
];

const subcommands = [
  'list',
  'show',
  'recall',
  'consolidate',
  'exam',
  'promote',
  'reject',
  'retire',
  'rollback',
  'status',
  'feedback',
  'timeline',
  'remember',
  'report',
  'import',
];

function writeScene(root, id, text, attempts = []) {
  const dir = path.join(root, 'scenes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\n字幕\n');
  fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n');
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    JSON.stringify({ id, duration_seconds: 1, output: 'out.mp4', transcript: 'transcription.srt', text, style_guide: 'frame.md', renderer: 'codex' }),
  );
  // attempts 依次是更早的归档与当前这一次。
  attempts.forEach((attempt, i) => {
    const target = i === attempts.length - 1 ? dir : path.join(dir, 'attempts', `attempt-${String(i + 1).padStart(2, '0')}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `render-${id}.attempt.json`), JSON.stringify({ schema: 1, scene_id: id, ...attempt }));
  });
}

function attempt(outcome, start, extra = {}) {
  return {
    renderer: 'codex',
    model: 'gpt-5.1',
    fingerprint: '',
    started_at: `2026-10-0${start}T10:00:00Z`,
    ended_at: `2026-10-0${start}T10:02:00Z`,
    seconds: 120,
    outcome,
    exit_code: 0,
    error: '',
    retry: false,
    usage: { input_tokens: 1000, output_tokens: 100 },
    ...extra,
  };
}

const frameProblem = { problems: ['总帧数不符：期望 30 帧，实测 31 帧'], checks: ['output.frames'] };

/** 两个旧项目：old 一次失败一次通过，old2 两个镜头都一次通过。 */
function oldProjects(base) {
  for (const name of ['old', 'old2']) {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
  }
  writeScene(path.join(base, 'old'), 'scene-001', '中文字幕的第一段', [attempt('verification_failed', 1, frameProblem), attempt('succeeded', 2)]);
  writeScene(path.join(base, 'old'), 'scene-002', '中文字幕的第二段', [attempt('verification_failed', 1, frameProblem)]);
  writeScene(path.join(base, 'old2'), 'scene-001', '第二个项目', [attempt('succeeded', 3)]);
  writeScene(path.join(base, 'old2'), 'scene-002', '第二个项目的第二段', [attempt('succeeded', 3, { model: 'claude-x', renderer: 'claude' })]);
}

function lessonDraft(name, description, checkedBy, features, body, from) {
  const episodes = from.length ? `from_episodes: [${from.join(', ')}]\n` : '';
  return `---\nname: ${name}\ndescription: ${description}\nstatus: trial\napplies_when:\n  features: [${features.join(', ')}]\nchecked_by: [${checkedBy.join(', ')}]\n${episodes}---\n${body}\n`;
}

/** 记忆库里第一段经历的编号（按目录名排序），草稿的 from_episodes 用它。 */
function firstEpisode(memoryDir) {
  const root = path.join(memoryDir, 'episodes');
  const ids = fs.readdirSync(root).flatMap((month) => fs.readdirSync(path.join(root, month)));
  return ids.sort()[0];
}

function drafts(dir, from = []) {
  fs.mkdirSync(path.join(dir, 'lessons'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lessons', 'frame-count-exact.md'),
    lessonDraft('frame-count-exact', '时间轴按整数帧收尾', ['output.frames'], ['cjk_text'], '最后一个动画在总帧数之前结束。\n\n反例：\n    tl.to(el, {duration: 1.02})\n\n正例：\n    tl.to(el, {duration: 1})', from),
  );
  fs.writeFileSync(
    path.join(dir, 'lessons', 'reads-slow.md'),
    lessonDraft('reads-slow', '标题停留够久再走', ['reads.duration'], ['cjk_text'], '标题至少停留两秒。\n\n反例：\n    标题一闪而过\n\n正例：\n    标题停两秒再退场', from),
  );
  fs.writeFileSync(path.join(dir, 'lessons', 'bad-draft.md'), lessonDraft('bad-draft', '用 codex 渲染', ['nope.check'], ['cjk_text'], '短', []));
}

/** 带样例记忆库的项目：导入两个旧项目、几条偏好、一条反馈、两条试用经验（其中一条已生效）。 */
function memoryFixture(base, ctx) {
  fs.writeFileSync(path.join(base, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\nMEMORY=on\n');
  writeScene(base, 'scene-001', '中文内容，讲一个数字 42');
  writeScene(base, 'scene-002', '另一段中文');
  oldProjects(base);
  const go = (...args) => {
    const r = spawnSync(goAm, args, { cwd: base, env: ctx.env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`准备记忆库失败：am ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  };
  go('memory', 'import', 'old', 'old2');
  go('memory', 'remember', '--name', 'calm-palette', '--description', '配色克制', '主色不超过两种高饱和色，背景用深色');
  go('memory', 'remember', '--global', '--name', 'no-emoji', '画面里不要出现 emoji');
  go('memory', 'remember', '--inferred', '--name', 'slower-pacing', '用户几次把节奏改慢，倾向每屏停留更久');
  go('memory', 'feedback', 'scenes/scene-001', '--down', '--note', '颜色太刺眼', '--at', '0.5');
  drafts(path.join(base, 'drafts'), [firstEpisode(ctx.memory)]);
  go('memory', 'consolidate', '--drafts', 'drafts');
  go('memory', 'promote', 'frame-count-exact');
  // 第二份草稿目录：一条与已有经验重名的、一条格式不合格的。
  const more = path.join(base, 'drafts2');
  drafts(more);
  fs.rmSync(path.join(more, 'lessons', 'frame-count-exact.md'));
  fs.rmSync(path.join(more, 'lessons', 'reads-slow.md'));
}

/** 记忆库里只有导入的失败经历，项目外运行。 */
function failuresOnly(base, ctx) {
  oldProjects(base);
  const r = spawnSync(goAm, ['memory', 'import', 'old'], { cwd: base, env: ctx.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

export const cases = [
  {
    // 根帮助里有两行与 Go 版不同且不归 am memory 管：cobra 自动生成的 completion 命令 TS 版没有实现，
    // studio 在客户端改写里换成了只剩 show 的新命令（说明文字随之改了）。抹掉这两行，其余逐字节比对，
    // 确认 memory 一行的位置与说明和 Go 版一致。
    name: 'root help',
    scrub: [
      [/^  completion  .*\n/m, ''],
      [/^  studio      .*\n/m, '  studio\n'],
    ],
    commands: [['--help']],
  },
  {
    name: 'memory help',
    commands: [['memory'], ['memory', '--help'], ['memory', 'nope'], ...subcommands.map((name) => ['memory', name, '--help'])],
  },
  {
    name: 'memory empty store outside a project',
    memory: true,
    scrub,
    commands: [
      ['memory', 'list'],
      ['memory', 'list', '--json'],
      ['memory', 'list', '--status', 'bad'],
      ['memory', 'list', 'extra'],
      ['memory', 'show', 'nope'],
      ['memory', 'show'],
      ['memory', 'status'],
      ['memory', 'status', '--no-record', '--report-json', 'status.json'],
      ['memory', 'timeline'],
      ['memory', 'timeline', '--json'],
      ['memory', 'report'],
      ['memory', 'report', '--json'],
      ['memory', 'report', '--compare', 'a'],
      ['memory', 'report', '--compare', 'a,b'],
      ['memory', 'promote', 'nope'],
      ['memory', 'reject', 'nope', '--reason', 'x'],
      ['memory', 'retire', 'nope'],
      ['memory', 'rollback'],
      ['memory', 'rollback', '--to', '-1'],
      ['memory', 'rollback', '--to', '3'],
      ['memory', 'consolidate'],
      ['memory', 'consolidate', '--min-count', '5', '--json'],
      ['memory', 'exam'],
      ['memory', 'exam', '--renderers', 'nope'],
      ['memory', 'exam', '--renderers', 'codex'],
      ['memory', 'exam', '--duration-tolerance', '-1'],
      ['memory', 'feedback', 'scenes/scene-001'],
      ['memory', 'feedback', 'scenes/scene-001', '--up', '--down'],
      ['memory', 'feedback', 'scenes/scene-001', '--up', '--region', '0.1,2,0.3,0.4'],
      ['memory', 'feedback', 'scenes/scene-001', '--up', '--region', '0.1,0.2'],
      ['memory', 'feedback', 'scenes/scene-001', '--up'],
      ['memory', 'recall'],
      ['memory', 'recall', 'scenes/scene-001'],
      ['memory', 'remember', '   '],
      ['memory', 'remember', '--name', 'Bad_Name', '内容'],
      ['memory', 'import'],
      ['memory', 'import', 'missing'],
      ['memory', 'import', '.', '--duration-tolerance', '-1'],
    ],
  },
  {
    name: 'memory consolidate without an orchestrator',
    memory: true,
    scrub,
    prepare: failuresOnly,
    commands: [
      ['memory', 'consolidate', '--min-count', '1', '--all'],
      ['memory', 'consolidate', '--min-count', '3', '--all'],
      ['memory', 'list'],
      ['memory', 'report', '--all-projects'],
    ],
  },
  {
    name: 'memory with a seeded store',
    memory: true,
    scrub,
    prepare: memoryFixture,
    commands: [
      ['memory', 'list'],
      ['memory', 'list', '--json'],
      ['memory', 'list', '--status', 'trial'],
      ['memory', 'show', 'calm-palette'],
      ['memory', 'show', 'frame-count-exact'],
      ['memory', 'recall', 'scenes/scene-001'],
      ['memory', 'recall', 'scenes/scene-001', '--json'],
      ['memory', 'recall', 'scenes/scene-001', '--with-trial'],
      ['memory', 'recall', 'scenes/scene-002', '--renderer', 'claude', '--model', 'claude-x'],
      ['memory', 'recall', 'scenes/nope'],
      ['memory', 'status'],
      ['memory', 'status', '--report-json', 'production/status.json'],
      ['memory', 'timeline'],
      ['memory', 'timeline', '--limit', '3', '--json'],
      ['memory', 'report'],
      ['memory', 'report', '--all-projects'],
      ['memory', 'report', '--all-projects', '--json'],
      ['memory', 'report', '--all-projects', '--compare', 'import:old2,import:old'],
      ['memory', 'report', '--all-projects', '--compare', 'import:old,nope'],
      ['memory', 'report', '--all-projects', '--last', '1'],
      ['memory', 'promote', 'slower-pacing'],
      ['memory', 'promote', 'calm-palette'],
      ['memory', 'reject', 'reads-slow', '--reason', '要看整片'],
      ['memory', 'retire', 'calm-palette', '--reason', '用户改主意了'],
      ['memory', 'rollback'],
      ['memory', 'rollback', '--to', '1'],
      ['memory', 'rollback', '--to', '99'],
      ['memory', 'remember', '--name', 'calm-palette-v2', '--revises', 'calm-palette', '配色只用品牌色加一个强调色'],
      ['memory', 'remember', '--inferred', '--name', 'big-title', '标题字号再大一点'],
      ['memory', 'remember', '--name', 'calm-palette', '重名'],
      ['memory', 'feedback', 'scenes/scene-002', '--up', '--note', '  节奏刚好  ', '--at', '0.25', '--element', '#title'],
      ['memory', 'feedback', 'scenes/scene-002', '--down', '--region', '0.1,0.6,0.8,0.3', '--note', '字幕压住了图表'],
      ['memory', 'import', 'old'],
      ['memory', 'import', 'old', 'old2', '--json'],
      ['memory', 'consolidate', '--drafts', 'drafts2'],
      ['memory', 'consolidate', '--drafts', 'drafts2', '--json'],
      ['memory', 'consolidate', '--min-count', '99'],
      ['memory', 'exam', '--renderers', 'codex'],
      ['memory', 'exam', '--renderers', 'codex', '--trial', 'reads-slow'],
      ['memory', 'exam', '--renderers', 'codex', '--trial', 'calm-palette'],
      ['memory', 'exam', '--renderers', 'codex', '--retest', 'calm-palette'],
    ],
  },
];
