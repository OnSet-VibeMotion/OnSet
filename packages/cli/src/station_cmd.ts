/**
 * 第三方插件：装上、去掉、更新、列出、执行它的一条操作。设计见 docs/superpowers/specs/2026-11-11-流程插件-design.md。
 * 插件装在用户级（<数据目录>/onset/stations/installed.json），对这台电脑上的所有项目生效。
 *
 * 全部只给命令行与客户端后端（scopes 只有 cli）：装不装第三方插件是用户的决定，编排工具不能自己装；
 * 只能由用户触发的操作（发布这类对外动作）也只有界面上的按钮经 station_run 执行。
 * 编排工具能用的那些操作由工具服务登记成 x_<站>_<操作>，执行时同样落到 station_run（toolsmcp.ts）。
 */
import path from 'node:path';
import * as config from '@onset/engine/config';
import * as flow from '@onset/engine/flow';
import { defineGroup } from './ops/cli';
import { defineOp, ParamError } from './ops/op';
import { projectRoot, str } from './ops/common';

/** 取插件用的环境：设置里的 NETWORK_PROXY 只给 git。 */
function fetchEnv(): Record<string, string | undefined> {
  return flow.withGitProxy(process.env, config.machineSetting(process.env, 'NETWORK_PROXY', config.parseConfFile));
}

const commitParam = { type: 'string' as const, description: '要求取回的 commit（从插件中心装时给，对不上就不装）' };

defineGroup({
  path: ['station'],
  summary: '第三方插件：装上、去掉、更新、列出与执行',
  description: `第三方插件是用户自己装的制作步骤（例如自动发布），onset 不分发、不维护。
装一次对这台电脑上的所有项目生效：它的说明接在制作提示词后面，它的站点出现在制作路线上，编排工具能用的操作登记成 x_<插件>_<操作> 工具，
它带来的做法（流程）在新建项目时能选。
这一组命令只给客户端与开发用：编排工具不能自己装或执行第三方插件。`,
});

type Out = { write: (text: string) => unknown };

/** 装上之前给用户看的实情（与设置页的确认同一份：flow.StationPreview）。 */
function writePreview(out: Out, p: flow.StationPreview): void {
  out.write(`第三方插件 ${p.name}（${p.id} ${p.version}）${p.commit ? `，commit ${p.commit.slice(0, 12)}` : p.linked ? '，本机目录' : ''}\n`);
  if (p.description) out.write(`  ${p.description}\n`);
  for (const op of p.ops) out.write(`  ${op.trigger === 'user' ? '[按钮]' : '[工具]'} ${op.trigger === 'user' ? op.name : op.tool}：${op.summary}\n`);
  // 页面在沙箱里，受清单的权限约束；操作不是：两者分开说，不混成一张「权限」表。
  if (p.ops_trust) out.write(`${p.ops_trust}\n`);
  if (p.page_permissions.length > 0) {
    out.write('它的页面在沙箱里运行，只能做清单里申请过的事：\n');
    for (const line of p.page_permissions) out.write(`  ${line}\n`);
  }
  for (const h of p.hooks) out.write(`  [自动执行] ${h.label}：${h.summary}\n`);
  for (const sc of p.schedules) out.write(`  [定时] 客户端开着时每 ${sc.every_minutes} 分钟：${sc.summary}\n`);
  for (const rs of p.renderer_skills) out.write(`  [渲染技能] ${rs.name}：${rs.summary}（${rs.scenes === 'all' ? '每个镜头都用' : 'AI 点名的镜头才用'}）\n`);
  if (p.rerender_all) out.write('  [渲染] 它给每个镜头都带上技能：装上后所有项目里已渲染的镜头都会标成要重渲染\n');
  if (p.flow) out.write(`  [做法] 新建项目时能选「${p.flow}」\n`);
  if (p.film_styles) out.write(`  [风格库] ${p.film_styles}\n`);
  if (p.replaces) out.write(`  [路线] 顶替自带的「${p.replaces}」这一站\n`);
  else if (p.nodes.length > 0) out.write(`  [路线] ${p.after ? `接在「${p.after}」后面` : p.flow ? '只在它自己的做法里' : '接在每个项目路线的最后'}：${p.nodes.join('、')}\n`);
  if (p.experimental.length > 0) out.write(`  [实验性] 用到了实验性能力：${p.experimental.join('、')}，以后的版本可能调整\n`);
  out.write('装上后对这台电脑上的所有项目生效。\n');
}

defineOp({
  name: 'station_add',
  cli: ['station', 'add'],
  summary: '取回一个第三方插件给你看，确认后再装（station_install）',
  description: `来源可以是 link:/绝对路径（本机目录，开发用，不核对内容）、github:owner/repo#ref 或 git 地址#ref。
只取回到用户级目录的暂存处（${flow.StationsDirEnv} 可覆盖）并校验清单，列出它的操作、页面权限、实验性能力、钩子、定时、渲染技能、带来的做法与风格库、
在路线上的位置；不写 ${flow.InstalledFile}，不参与任何项目。看过之后用 station_install 装上，或 station_discard 取消。`,
  examples: [
    'station_add({"source": "github:someone/onset-publisher#v0.1.0"})',
    'station_add({"source": "link:/Users/me/dev/my-station"})',
    'station_add({"source": "github:someone/onset-publisher#0123456789abcdef0123456789abcdef01234567", "expect_id": "onset-publisher", "expect_commit": "0123456789abcdef0123456789abcdef01234567"})',
  ],
  scopes: ['cli'],
  params: {
    source: { type: 'string', description: '来源', required: true, positional: 0 },
    expect_id: { type: 'string', description: '要求取回的插件 id（从插件中心装时给，对不上就不装）' },
    expect_commit: commitParam,
  },
  run: (p, { out }) => {
    const expect = { id: str(p.expect_id), commit: str(p.expect_commit) };
    const staged = flow.stageStation(str(p.source), fetchEnv(), (line) => out.write(line + '\n'), expect);
    writePreview(out, staged.preview);
    out.write(`还没有装上。确认装上：station_install({"staged": "${staged.token}"})；不装：station_discard({"staged": "${staged.token}"})\n`);
    return { data: { staged: staged.token, preview: staged.preview } };
  },
});

defineOp({
  name: 'station_update',
  cli: ['station', 'update'],
  summary: '取回一个第三方插件的新版本给你看，确认后再换上（station_install）',
  description: `按 ${flow.InstalledFile} 里记的来源（或给的 source，插件中心的新一版）重新取到暂存处：来源写的是分支时拿到它现在的 commit，写的是 tag 时 tag 被移动过才会变。
列出版本、commit、新申请的权限与新用到的实验性能力；已装的那一版不动，用 station_install 换上，或 station_discard 取消。
link: 来源是本机目录，改动立即生效，不需要更新。`,
  examples: [
    'station_update({"id": "onset-publisher"})',
    'station_update({"id": "onset-publisher", "source": "github:someone/onset-publisher#0123456789abcdef0123456789abcdef01234567", "expect_commit": "0123456789abcdef0123456789abcdef01234567"})',
  ],
  scopes: ['cli'],
  params: {
    id: { type: 'string', description: '插件的 id', required: true, positional: 0 },
    source: { type: 'string', description: '新一版的来源（插件中心给的 <仓库>#<commit>）；必须与已装的是同一个仓库，不写按已装时记的来源' },
    expect_commit: commitParam,
  },
  run: (p, { out }) => {
    const staged = flow.stageUpdate(str(p.id), fetchEnv(), (line) => out.write(line + '\n'), { source: str(p.source), expect: { commit: str(p.expect_commit) } });
    const d = staged.preview.update!;
    if (!d.changed) out.write(`第三方插件 ${d.id} 已是来源上的最新版本（${d.new_version}，commit ${d.commit_after.slice(0, 12)}）\n`);
    else {
      const from = d.old_version === '' ? '（本机已没有原来那一版）' : d.old_version;
      out.write(`第三方插件 ${d.id} 有新版本：${from} → ${d.new_version}，commit ${d.commit_before.slice(0, 12)} → ${d.commit_after.slice(0, 12)}\n`);
      for (const line of d.new_permissions) out.write(`  [新权限] ${line}\n`);
      if (d.new_experimental.length > 0) out.write(`  [新的实验性能力] ${d.new_experimental.join('、')}\n`);
    }
    writePreview(out, staged.preview);
    out.write(`还没有换上。确认换上：station_install({"staged": "${staged.token}"})；不换：station_discard({"staged": "${staged.token}"})\n`);
    return { data: { staged: staged.token, preview: staged.preview } };
  },
});

defineOp({
  name: 'station_install',
  cli: ['station', 'install'],
  summary: '装上（或换上）看过的第三方插件',
  description: `把 station_add / station_update 取回到暂存处的插件写进用户级的 ${flow.InstalledFile}，对这台电脑上的所有项目生效；同 id 的换成新的。
git 来源再核对一遍内容摘要，看过之后被改过的不装。`,
  examples: ['station_install({"staged": "0123456789abcdef"})'],
  scopes: ['cli'],
  params: {
    staged: { type: 'string', description: 'station_add 或 station_update 给出的待装编号', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    const entry = flow.installStaged(str(p.staged));
    out.write(`已装上第三方插件 ${entry.id} ${entry.version}${entry.commit ? `（commit ${entry.commit.slice(0, 12)}）` : ''}，对所有项目生效\n`);
    return { data: { entry } };
  },
});

defineOp({
  name: 'station_discard',
  cli: ['station', 'discard'],
  summary: '不装看过的第三方插件：清掉暂存',
  description: `清掉 station_add / station_update 取回的暂存，不碰 ${flow.InstalledFile}。`,
  examples: ['station_discard({"staged": "0123456789abcdef"})'],
  scopes: ['cli'],
  params: {
    staged: { type: 'string', description: '待装编号', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    flow.discardStaged(str(p.staged));
    out.write('没有装，暂存已清掉\n');
    return { data: { staged: str(p.staged) } };
  },
});

defineOp({
  name: 'station_remove',
  cli: ['station', 'remove'],
  summary: '去掉一个第三方插件（所有项目都不再用它）',
  description: `只改用户级的 ${flow.InstalledFile}，不删存着的插件目录，也不删它在各项目里写过的文件。
用它带来的做法新建的项目，去掉之后开不了工，直到重新装上。`,
  examples: ['station_remove({"id": "onset-publisher"})'],
  scopes: ['cli'],
  params: {
    id: { type: 'string', description: '插件的 id', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    flow.removeStation(str(p.id));
    out.write(`已去掉第三方插件 ${str(p.id)}\n`);
    return { data: { id: str(p.id) } };
  },
});

defineOp({
  name: 'station_list',
  cli: ['station', 'list'],
  summary: '列出装了的第三方插件',
  description: `列出用户级 ${flow.InstalledFile} 里记的插件：id、版本、名字、来源。读不出来（本机没有、内容被改过、清单写坏）的单独列成问题，这些插件不会进提示词与制作路线。`,
  examples: ['station_list({})'],
  scopes: ['cli'],
  params: {},
  run: (_p, { out }) => {
    const loaded = flow.loadStations();
    const stations = loaded.stations.filter((s) => !s.builtin);
    const problems = loaded.problems.map((p) => p.message);
    if (stations.length === 0 && problems.length === 0) out.write('没有装第三方插件\n');
    for (const s of stations) out.write(`${s.manifest.id} ${s.manifest.version}  ${s.manifest.name}  ${s.entry.source}\n`);
    for (const problem of problems) out.write(`[问题] ${problem}\n`);
    return { data: { stations: stations.map((s) => ({ ...s.entry, name: s.manifest.name })), problems } };
  },
});

defineOp({
  name: 'station_run',
  cli: ['station', 'run'],
  summary: '在这个项目里执行第三方插件的一条操作',
  description: `在子进程里执行，工作目录是项目根，只拿到最少的环境变量（不含项目 .env）。参数按站的清单校验。
这不是沙箱：操作是电脑上的普通程序。执行前后各扫一遍项目，写了站声明范围之外的文件时在输出末尾列出来；写了 onset 自己的文件（production/studio/、.agents/、.env 等）时按失败处理，文件已经写了，没法自动撤销。`,
  examples: ['station_run({"station": "onset-publisher", "op": "send", "params": "{\\"platform\\": \\"douyin\\"}"})'],
  scopes: ['cli'],
  params: {
    station: { type: 'string', description: '插件的 id', required: true, positional: 0 },
    op: { type: 'string', description: '操作名', required: true, positional: 1 },
    params: { type: 'string', description: '操作的参数（JSON 对象）', default: '{}' },
    event: { type: 'string', description: '事件钩子触发时的事件（JSON 对象），交给插件', default: '' },
    project_root: projectRoot,
  },
  run: async (p, { out, signal }) => {
    let event: Record<string, unknown> | undefined;
    if (str(p.event) !== '') {
      try {
        event = JSON.parse(str(p.event)) as Record<string, unknown>;
      } catch (err) {
        throw new ParamError(`event 不是合法的 JSON：${(err as Error).message}`);
      }
    }
    let params: unknown;
    try {
      params = JSON.parse(str(p.params) || '{}');
    } catch (err) {
      throw new ParamError(`params 不是合法的 JSON：${(err as Error).message}`);
    }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new ParamError('params 要是 JSON 对象');
    // 空的项目根表示没打开项目（设置里点的、清单写了 project: false 的操作），原样交下去；
    // 不能按当前目录解析，不然执行进程的工作目录（插件目录）会被当成项目扫、插件也会往里写项目文件。
    const root = str(p.project_root) === '' ? '' : path.resolve(str(p.project_root));
    const result = await flow.runStationOp(root, str(p.station), str(p.op), params as Record<string, unknown>, (t) => out.write(t), signal, process.env, event);
    if (!result.ok) throw new Error(result.error ?? '第三方插件的操作失败');
    return result.data === undefined ? undefined : { data: result.data };
  },
});
