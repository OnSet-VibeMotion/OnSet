/**
 * 第三方插件：装上、去掉、更新、列出、执行它的一条操作。设计见 docs/superpowers/specs/2026-11-11-流程插件-design.md。
 * 插件装在用户级（<数据目录>/am/stations/installed.json），对这台电脑上的所有项目生效。
 *
 * 全部只给命令行与客户端后端（scopes 只有 cli）：装不装第三方插件是用户的决定，编排工具不能自己装；
 * 只能由用户触发的操作（发布这类对外动作）也只有界面上的按钮经 station_run 执行。
 * 编排工具能用的那些操作由工具服务登记成 x_<站>_<操作>，执行时同样落到 station_run（toolsmcp.ts）。
 */
import path from 'node:path';
import * as flow from '@am/engine/flow';
import { defineGroup } from './ops/cli';
import { defineOp, ParamError } from './ops/op';
import { projectRoot, str } from './ops/common';

defineGroup({
  path: ['station'],
  summary: '第三方插件：装上、去掉、更新、列出与执行',
  description: `第三方插件是用户自己装的制作步骤（例如自动发布），am 不分发、不维护。
装一次对这台电脑上的所有项目生效：它的说明接在制作提示词后面，它的站点出现在制作路线上，编排工具能用的操作登记成 x_<插件>_<操作> 工具，
它带来的做法（流程）在新建项目时能选。
这一组命令只给客户端与开发用：编排工具不能自己装或执行第三方插件。`,
});

defineOp({
  name: 'station_add',
  cli: ['station', 'add'],
  summary: '装上一个第三方插件（对所有项目生效）',
  description: `来源可以是 link:/绝对路径（本机目录，开发用，不核对内容）、github:owner/repo#ref 或 git 地址#ref。
git 来源按 ref 克隆、记下 commit 与内容摘要，存进用户级目录（${flow.StationsDirEnv} 可覆盖）；之后内容对不上就不再使用。
记进用户级的 ${flow.InstalledFile}，对这台电脑上的所有项目生效；同 id 的插件换成新的。`,
  examples: ['station_add({"source": "github:someone/am-publisher#v0.1.0"})', 'station_add({"source": "link:/Users/me/dev/my-station"})'],
  scopes: ['cli'],
  params: {
    source: { type: 'string', description: '来源', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    const got = flow.installStation(str(p.source), process.env, (line) => out.write(line + '\n'));
    const m = got.manifest;
    out.write(`已装上第三方插件 ${m.name}（${m.id} ${m.version}）${got.entry.commit ? `，commit ${got.entry.commit.slice(0, 12)}` : ''}，对所有项目生效\n`);
    for (const op of m.ops) out.write(`  ${op.trigger === 'user' ? '[按钮]' : '[工具]'} ${op.trigger === 'user' ? op.name : flow.toolName(m.id, op.name)}：${op.summary}\n`);
    // 页面在沙箱里，受清单的权限约束；操作不是：两者分开说，不混成一张「权限」表。
    if (m.ops.length > 0) out.write(`${flow.OpsTrustNotice}\n`);
    const pageLines = flow.pagePermissionLines(m);
    if (pageLines.length > 0) {
      out.write('它的页面在沙箱里运行，只能做清单里申请过的事：\n');
      for (const line of pageLines) out.write(`  ${line}\n`);
    }
    const allScenes = m.renderer_skills.filter((rs) => rs.scenes === 'all');
    if (allScenes.length > 0) out.write(`  [渲染] 它给每个镜头都带上技能（${allScenes.map((rs) => rs.name).join('、')}）：所有项目里已渲染的镜头都会标成要重渲染\n`);
    const experimental = flow.experimentalFields(m);
    writeExperimental(out, experimental);
    return { data: { entry: got.entry, name: m.name, experimental } };
  },
});

/** 用到了实验性字段时照实告诉用户：这些能力以后的版本可能调整。 */
function writeExperimental(out: { write: (text: string) => unknown }, fields: readonly string[]): void {
  if (fields.length > 0) out.write(`  [实验性] 用到了实验性能力：${fields.join('、')}，以后的版本可能调整\n`);
}

defineOp({
  name: 'station_update',
  cli: ['station', 'update'],
  summary: '按添加时的来源重新取一个第三方插件，更新到来源现在的版本',
  description: `按 ${flow.InstalledFile} 里记的来源重新取：来源写的是分支时拿到它现在的 commit，写的是 tag 时 tag 被移动过才会变。
列出版本、commit、新申请的权限与新用到的实验性能力，写回 ${flow.InstalledFile}；用户级目录里存的旧版本不删。
link: 来源是本机目录，改动立即生效，不需要更新。`,
  examples: ['station_update({"id": "am-publisher"})'],
  scopes: ['cli'],
  params: {
    id: { type: 'string', description: '插件的 id', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    const up = flow.updateStation(str(p.id), process.env, (line) => out.write(line + '\n'));
    if (up.linked) {
      out.write(`第三方插件 ${up.id} 来自本机目录（${up.before.source}），改动立即生效，不需要更新\n`);
      return { data: up };
    }
    if (!up.changed) {
      out.write(`第三方插件 ${up.id} 已是来源上的最新版本（${up.new_version}，commit ${up.after.commit.slice(0, 12)}）\n`);
    } else {
      const from = up.old_version === '' ? '（本机已没有原来那一版）' : up.old_version;
      out.write(`已更新第三方插件 ${up.id}：${from} → ${up.new_version}，commit ${up.before.commit.slice(0, 12)} → ${up.after.commit.slice(0, 12)}\n`);
      for (const line of up.new_permissions) out.write(`  [新权限] ${line}\n`);
      if (up.new_experimental.length > 0) out.write(`  [新的实验性能力] ${up.new_experimental.join('、')}\n`);
    }
    writeExperimental(out, up.experimental);
    return { data: up };
  },
});

defineOp({
  name: 'station_remove',
  cli: ['station', 'remove'],
  summary: '去掉一个第三方插件（所有项目都不再用它）',
  description: `只改用户级的 ${flow.InstalledFile}，不删存着的插件目录，也不删它在各项目里写过的文件。
用它带来的做法新建的项目，去掉之后开不了工，直到重新装上。`,
  examples: ['station_remove({"id": "am-publisher"})'],
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
这不是沙箱：操作是电脑上的普通程序。执行前后各扫一遍项目，写了站声明范围之外的文件时在输出末尾列出来；写了 am 自己的文件（production/studio/、.agents/、.env 等）时按失败处理，文件已经写了，没法自动撤销。`,
  examples: ['station_run({"station": "am-publisher", "op": "send", "params": "{\\"platform\\": \\"douyin\\"}"})'],
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
    const result = await flow.runStationOp(path.resolve(str(p.project_root)), str(p.station), str(p.op), params as Record<string, unknown>, (t) => out.write(t), signal, process.env, event);
    if (!result.ok) throw new Error(result.error ?? '第三方插件的操作失败');
    return result.data === undefined ? undefined : { data: result.data };
  },
});
