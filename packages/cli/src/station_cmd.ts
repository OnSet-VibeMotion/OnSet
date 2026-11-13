/**
 * 第三方站：加进项目、去掉、列出、执行它的一条操作。设计见 docs/superpowers/specs/2026-11-11-流程插件-design.md。
 *
 * 全部只给命令行与客户端后端（scopes 只有 cli）：加不加第三方插件是用户的决定，编排工具不能自己装；
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
  summary: '第三方站：加进项目、去掉、列出与执行',
  description: `第三方站是用户自己添加的制作步骤（例如自动发布），am 不分发、不维护。
加进项目后，它的说明接在制作提示词后面，它的站点出现在制作路线上，编排工具能用的操作登记成 x_<站>_<操作> 工具。
这一组命令只给客户端与开发用：编排工具不能自己加或执行第三方站。`,
});

defineOp({
  name: 'station_add',
  cli: ['station', 'add'],
  summary: '把一个第三方站加进这个项目',
  description: `来源可以是 link:/绝对路径（本机目录，开发用，不核对内容）、github:owner/repo#ref 或 git 地址#ref。
git 来源按 ref 克隆、记下 commit 与内容摘要，存进用户级目录（${flow.StationsDirEnv} 可覆盖）；之后内容对不上就不再使用。
写进项目的 ${flow.LockFile}；同 id 的站换成新的。`,
  examples: ['station_add({"source": "github:someone/am-publisher#v0.1.0"})', 'station_add({"source": "link:/Users/me/dev/my-station"})'],
  scopes: ['cli'],
  params: {
    source: { type: 'string', description: '来源', required: true, positional: 0 },
    project_root: projectRoot,
  },
  run: (p, { out }) => {
    const root = path.resolve(str(p.project_root));
    const got = flow.fetchStation(str(p.source), process.env, (line) => out.write(line + '\n'));
    flow.addToProject(root, got.entry);
    const m = got.manifest;
    out.write(`已加入第三方站 ${m.name}（${m.id} ${m.version}）${got.entry.commit ? `，commit ${got.entry.commit.slice(0, 12)}` : ''}\n`);
    for (const op of m.ops) out.write(`  ${op.trigger === 'user' ? '[按钮]' : '[工具]'} ${op.trigger === 'user' ? op.name : flow.toolName(m.id, op.name)}：${op.summary}\n`);
    return { data: { entry: got.entry, name: m.name } };
  },
});

defineOp({
  name: 'station_remove',
  cli: ['station', 'remove'],
  summary: '把一个第三方站从这个项目里去掉',
  description: `只改项目的 ${flow.LockFile}，不删用户级目录里存的站，也不删它写过的文件。`,
  examples: ['station_remove({"id": "am-publisher"})'],
  scopes: ['cli'],
  params: {
    id: { type: 'string', description: '站的 id', required: true, positional: 0 },
    project_root: projectRoot,
  },
  run: (p, { out }) => {
    flow.removeFromProject(path.resolve(str(p.project_root)), str(p.id));
    out.write(`已从项目去掉第三方站 ${str(p.id)}\n`);
    return { data: { id: str(p.id) } };
  },
});

defineOp({
  name: 'station_list',
  cli: ['station', 'list'],
  summary: '列出这个项目加的第三方站',
  description: `列出 ${flow.LockFile} 里记的站：id、版本、名字、来源。读不出来（本机没有、内容被改过、清单写坏）的站单独列成问题，这些站不会进提示词与制作路线。`,
  examples: ['station_list({})'],
  scopes: ['cli'],
  params: { project_root: projectRoot },
  run: (p, { out }) => {
    const { stations, problems } = flow.loadProjectStations(path.resolve(str(p.project_root)));
    if (stations.length === 0 && problems.length === 0) out.write('这个项目没有加第三方站\n');
    for (const s of stations) out.write(`${s.manifest.id} ${s.manifest.version}  ${s.manifest.name}  ${s.entry.source}\n`);
    for (const problem of problems) out.write(`[问题] ${problem}\n`);
    return { data: { stations: stations.map((s) => ({ ...s.entry, name: s.manifest.name })), problems } };
  },
});

defineOp({
  name: 'station_run',
  cli: ['station', 'run'],
  summary: '执行第三方站的一条操作',
  description: '在子进程里执行，工作目录是项目根，只拿到最少的环境变量（不含项目 .env）。参数按站的清单校验。',
  examples: ['station_run({"station": "am-publisher", "op": "send", "params": "{\\"platform\\": \\"douyin\\"}"})'],
  scopes: ['cli'],
  params: {
    station: { type: 'string', description: '站的 id', required: true, positional: 0 },
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
    if (!result.ok) throw new Error(result.error ?? '第三方站的操作失败');
    return result.data === undefined ? undefined : { data: result.data };
  },
});

defineOp({
  name: 'station_flow',
  cli: ['station', 'flow'],
  summary: '让这个项目改用某个第三方站带来的流程（新片型），或回到自带的流程',
  description: `写进项目的 ${flow.LockFile}。改用之后，制作路线、顶栏第一步与制作提示词的各阶段都换成那套流程的；am 的公共约定照旧在前。
id 留空回到自带的流程（口播或卡点）。去掉那个站时也会自动回到自带的流程。`,
  examples: ['station_flow({"id": "podcast-clips"})', 'station_flow({"id": ""})'],
  scopes: ['cli'],
  params: {
    id: { type: 'string', description: '带流程的站的 id；留空回到自带的流程', default: '', positional: 0 },
    project_root: projectRoot,
  },
  run: (p, { out }) => {
    flow.setProjectFlow(path.resolve(str(p.project_root)), str(p.id));
    out.write(str(p.id) === '' ? '这个项目回到自带的流程\n' : `这个项目改用第三方站 ${str(p.id)} 的流程\n`);
    return { data: { flow: str(p.id) } };
  },
});
