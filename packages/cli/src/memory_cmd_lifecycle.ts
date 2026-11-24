/**
 * 渲染记忆的生命周期、状态、反馈、时间线与偏好记录操作。
 */
import { formatFixed, goTrimSpace } from '@onset/engine/gofmt';
import { compareBytes } from '@onset/engine/gojson';
import * as memory from '@onset/engine/memory';
import * as series from '@onset/engine/series';
import * as scene from '@onset/engine/scene';
import { currentEnvironment } from './cli';
import { jsonParam, loadMemoryConfig, writeReport } from './memory_cmd_shared';
import { bool, num, str } from './ops/common';
import { defineOp, ParamError } from './ops/op';
import { printJSON } from './usage_cmd';

defineOp({
  name: 'memory_promote',
  cli: ['memory', 'promote'],
  scopes: ['cli'],
  summary: '人工确认一条试用记忆生效',
  description:
    '偏好不参加考试，只能由人确认生效。经验通常由 memory_exam 转为生效；人工确认的经验会让快照标为「未经考试」。',
  examples: ['memory_promote({"name": "no-neon-overload"})'],
  params: { name: { type: 'string', description: '记忆名', required: true, positional: 0 } },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const snapshot = store.promote(str(p.name));
    out.write(`${str(p.name)} 已生效，快照 #${snapshot.id}\n`);
    return { data: { name: str(p.name), snapshot: snapshot.id } };
  },
});

defineOp({
  name: 'memory_reject',
  cli: ['memory', 'reject'],
  scopes: ['cli'],
  summary: '人工拒绝一条试用记忆',
  description:
    '把一条试用中的记忆记为被拒，原因写进它的 rejected_reason。被拒记忆保留文件、不再参加考试，也不会被召回。',
  examples: ['memory_reject({"name": "loop-forever", "reason": "无限循环会被确定性扫描判失败"})'],
  params: {
    name: { type: 'string', description: '记忆名', required: true, positional: 0 },
    reason: { type: 'string', description: '拒绝原因' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    store.reject(str(p.name), str(p.reason));
    out.write(`${str(p.name)} 已记为被拒\n`);
    return { data: { name: str(p.name) } };
  },
});

defineOp({
  name: 'memory_retire',
  cli: ['memory', 'retire'],
  scopes: ['cli'],
  summary: '让一条生效记忆转为沉睡',
  description:
    'memory_status() 会列出待沉睡候选（召回后一次通过率不高于基线）；确认后用它让一条记忆沉睡。用户收回一条偏好时也用它。',
  examples: ['memory_retire({"name": "font-local-block", "reason": "在两个渲染工具上都没有提升"})'],
  params: {
    name: { type: 'string', description: '记忆名', required: true, positional: 0 },
    reason: { type: 'string', description: '原因' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const snapshot = store.retire(str(p.name), str(p.reason));
    out.write(`${str(p.name)} 已转为沉睡，快照 #${snapshot.id}\n`);
    return { data: { name: str(p.name), snapshot: snapshot.id } };
  },
});

defineOp({
  name: 'memory_rollback',
  cli: ['memory', 'rollback'],
  scopes: ['cli'],
  summary: '回退到某个快照',
  description: '把快照 to 的生效记忆集合恢复成一个新快照，不删除任何历史。缺省回到最新快照的上一个。',
  examples: ['memory_rollback()', 'memory_rollback({"to": 3})'],
  params: { to: { type: 'integer', description: '目标快照号；缺省为最新快照的上一个' } },
  run: (p, { out }) => {
    const to = num(p.to);
    if (to < 0) throw new ParamError('to 必须是快照号');
    const { store } = loadMemoryConfig();
    const snapshot = store.rollback(to);
    out.write(
      `已回退到快照 #${snapshot.restored_from}，记为新快照 #${snapshot.id}（${(snapshot.entries ?? []).length} 条生效记忆）\n`,
    );
    return {
      data: { restored_from: snapshot.restored_from, snapshot: snapshot.id, active: (snapshot.entries ?? []).length },
    };
  },
});

defineOp({
  name: 'memory_status',
  cli: ['memory', 'status'],
  scopes: ['cli'],
  summary: '记忆库现状；发现人工编辑时记成新快照',
  description: `汇总记忆库：各状态的记忆数、最新快照、经历数、上次整理后新增的失败数，以及待沉睡候选。

召回只读快照。手改了记忆文件时，memory_status 会发现与最新快照不一致的生效记忆，
把当前状态记成一个新快照并标注「人工编辑，未经考试」；"no_record": true 只报告不记录。`,
  examples: ['memory_status()', 'memory_status({"report_json": "production/memory-status.json"})'],
  params: {
    report_json: { type: 'string', description: '把现状写成 JSON' },
    no_record: { type: 'boolean', description: '只报告人工编辑，不记成新快照' },
  },
  run: (p, { out }) => {
    const { cfg, store } = loadMemoryConfig();
    const report = store.status(!bool(p.no_record), (r) => store.currentModel(r, currentEnvironment()));
    const data = memory.statusReportToJSON(report);
    if (str(p.report_json) !== '') writeReport(str(p.report_json), data);
    const state = cfg.memory.enabled ? '打开' : '关闭';
    const pinned = cfg.memory.snapshot > 0 ? '钉住 #' + cfg.memory.snapshot : '跟随最新';
    out.write(
      `记忆库：${report.dir}\n本项目：记忆${state}，快照${pinned}，召回预算 ${cfg.memory.recallBudget} 字\n最新快照：#${report.snapshot}\n`,
    );
    for (const key of Object.keys(report.counts).sort(compareBytes)) out.write(`  ${key}：${report.counts[key]}\n`);
    out.write(`经历 ${report.episodes} 段，上次整理后新增失败 ${report.pending_failures} 段\n`);
    if ((report.drift ?? []).length > 0) {
      if (report.recorded_snapshot > 0)
        out.write(`发现人工编辑：${report.drift.join('、')}，已记为快照 #${report.recorded_snapshot}（未经考试）\n`);
      else out.write(`发现人工编辑：${report.drift.join('、')}（未记快照，召回不会用到）\n`);
    }
    for (const r of report.retest ?? []) {
      out.write(
        `需要重考：${r.name} 当初在 ${r.renderer} 上用 ${r.examined_models.join('、')} 考过，现在是 ${r.current_model}（memory_exam({"renderers": "${r.renderer}", "retest": "${r.name}"})）\n`,
      );
    }
    for (const x of report.suspect ?? []) {
      const renderer = x.renderer.split('/')[0];
      out.write(
        `可疑：${x.name} 在 ${x.renderer} 上召回 ${x.recalled} 次，其中 ${x.harmful} 次它要防的 ${(x.checks ?? []).join('、')} 照样判了失败（memory_exam({"renderers": "${renderer}", "retest": "${x.name}"})）\n`,
      );
    }
    for (const w of report.weak ?? []) {
      out.write(
        `待沉睡：${w.name} 在 ${w.renderer} 上召回 ${w.recalled} 次，一次通过率 ${formatFixed(w.rate * 100, 0)}%，不高于基线 ${formatFixed(w.baseline * 100, 0)}%\n`,
      );
    }
    // Go 版按 map 遍历（顺序随机）；这里按路径排序。
    for (const file of Object.keys(report.broken ?? {}).sort(compareBytes))
      out.write(`无法解析：${file}：${report.broken[file]}\n`);
    return { data };
  },
});

/** strconv.ParseFloat 能接受的十进制写法（含 inf / nan 等，与 Go 一致地判为数，再由范围检查拦下）。 */
function parseGoFloat(text: string): number | null {
  if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(text)) return Number(text);
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^nan$/i.test(text)) return NaN;
  return null;
}

defineOp({
  name: 'memory_feedback',
  cli: ['memory', 'feedback'],
  summary: '为一个镜头补录人工反馈（👍 / 👎）',
  description:
    '把人工反馈写成一段经历。👎 会进入下一次整理；说明里的审美取向会被写成偏好，偏好由人确认后才生效。up 与 down 必须且只能给一个。',
  examples: [
    'memory_feedback({"scene": "scenes/scene-003", "down": true, "note": "满屏霓虹太刺眼", "at": 2.5})',
    'memory_feedback({"scene": "scenes/scene-003", "down": true, "region": "0.1,0.6,0.8,0.3", "note": "字幕压住了图表"})',
  ],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    up: { type: 'boolean', description: '👍' },
    down: { type: 'boolean', description: '👎' },
    note: { type: 'string', description: '说明' },
    at: { type: 'number', description: '画面在镜头内的时间点（秒）', default: -1 },
    region: { type: 'string', description: '框选区域，归一化坐标 x,y,w,h' },
    element: { type: 'string', description: '点选的元素' },
  },
  run: (p, { out }) => {
    if (bool(p.up) === bool(p.down)) throw new ParamError('必须且只能给出 up 或 down 之一');
    const feedback = memory.newFeedback({
      verdict: bool(p.down) ? 'down' : 'up',
      note: goTrimSpace(str(p.note)),
      seconds: num(p.at),
      element: str(p.element),
    });
    const region = str(p.region);
    if (region !== '') {
      const values: number[] = [];
      for (const part of region.split(',')) {
        const value = parseGoFloat(goTrimSpace(part));
        // NaN 在 Go 里同样过得了 value < 0 || value > 1 的检查。
        if (value === null || value < 0 || value > 1) throw new ParamError('region 必须是 4 个 0..1 之间的数：x,y,w,h');
        values.push(value);
      }
      if (values.length !== 4) throw new ParamError('region 必须是 4 个 0..1 之间的数：x,y,w,h');
      feedback.region = values;
    }
    const { store } = loadMemoryConfig();
    const s = scene.load(str(p.scene));
    const episode = store.recordFeedback(s, feedback);
    out.write(`已记录经历 ${episode.id}\n`);
    return { data: { episode: episode.id } };
  },
});

defineOp({
  name: 'memory_timeline',
  cli: ['memory', 'timeline'],
  scopes: ['cli'],
  summary: '记忆库的事件时间线',
  description:
    '按发生顺序列出记忆库的事件：写经历、整理、试用、草稿被拒、考试、生效、被拒、沉睡、快照、人工编辑与回退。',
  examples: ['memory_timeline({"limit": 20})', 'memory_timeline({"json": true})'],
  params: {
    json: jsonParam,
    limit: { type: 'integer', description: '只显示最近若干条' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    let events = store.timeline();
    const limit = num(p.limit);
    if (limit > 0 && events.length > limit) events = events.slice(events.length - limit);
    const data = events.map(memory.eventToJSON);
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    for (const event of events) out.write(`${event.time}  ${event.type.padEnd(14)} ${event.summary}\n`);
    return { data };
  },
});

defineOp({
  name: 'memory_remember',
  cli: ['memory', 'remember'],
  summary: '记住用户亲口说的一条偏好',
  description: `把用户表达的长期取向直接记为生效的偏好，并生成快照。用户自己说出来的就是确认，
不需要再经人工确认或考试。

偏好会进入两处：编排工具每次开工前读到的「用户偏好」段（客户端的每一轮对话），
以及每个镜头渲染时的记忆召回。默认只对当前项目成立，"global": true 对所有项目成立。
用户收回一条偏好时用 memory_retire({"name": "<名字>"})。

"inferred": true 用于用户没有明说、由编排工具推测出来的取向：它进入试用，出现在偏好段的
「待确认」里，用户认可（memory_promote({"name": "<名字>"})）后才生效。`,
  examples: [
    'memory_remember({"text": "主色不超过两种高饱和色，背景用深色", "name": "calm-palette", "description": "配色克制"})',
    'memory_remember({"text": "画面里不要出现 emoji", "name": "no-emoji", "global": true})',
    'memory_remember({"text": "配色只用品牌色加一个强调色", "name": "calm-palette-v2", "revises": "calm-palette"})',
    'memory_remember({"text": "用户几次把节奏改慢，倾向每屏停留更久", "name": "slower-pacing", "inferred": true})',
  ],
  params: {
    text: { type: 'string', description: '偏好的完整说明', required: true, positional: 0 },
    name: { type: 'string', description: '偏好名，小写字母、数字与连字符；缺省按时间生成' },
    description: { type: 'string', description: '一句话概括；缺省取正文第一句' },
    global: { type: 'boolean', description: '对用户所有项目都成立' },
    scope: { type: 'string', description: '作用范围：project（仅本项目，默认）/ series（本专栏所有期数）/ global（所有项目）' },
    revises: { type: 'string', description: '替换的旧偏好名，旧偏好转为沉睡' },
    inferred: { type: 'boolean', description: '用户没有明说、由编排工具推测的取向：先进入试用，用户确认后才生效' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const root = process.cwd();
    const inferred = bool(p.inferred);
    const rawScope = str(p.scope);
    let scopeKind: 'project' | 'series' | 'global' | undefined;
    if (rawScope !== '') {
      if (rawScope !== 'project' && rawScope !== 'series' && rawScope !== 'global') {
        throw new Error(`无效的 scope：${rawScope}（可选：project、series、global）`);
      }
      scopeKind = rawScope;
    }
    let seriesId = '';
    try {
      seriesId = series.readBinding(root)?.series_id ?? '';
    } catch {
      seriesId = '';
    }
    const { memory: m, snapshot } = store.remember({
      name: str(p.name),
      description: str(p.description),
      body: str(p.text),
      project: memory.projectName(root),
      series: seriesId,
      scope: scopeKind,
      global: bool(p.global),
      revises: str(p.revises),
      inferred,
    });
    const seriesTag = memory.parseSeriesScope(m.scope);
    const scope =
      m.scope === '' ? '所有项目' : seriesTag !== '' ? `本专栏（${seriesTag}）` : '本项目（' + m.scope + '）';
    const data = {
      name: m.name,
      scope: m.scope,
      description: m.description,
      status: m.status,
      snapshot: snapshot?.id ?? 0,
    };
    if (inferred) {
      out.write(
        `推测的偏好 ${m.name}（${scope}）进入试用：${m.description}；用户确认后运行 memory_promote({"name": "${m.name}"})\n`,
      );
      return { data };
    }
    out.write(`已记住偏好 ${m.name}（${scope}）：${m.description}，快照 #${snapshot?.id ?? 0}\n`);
    return { data };
  },
});
