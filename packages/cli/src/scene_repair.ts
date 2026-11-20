import fs from 'node:fs';
import path from 'node:path';
import * as config from '@onset/engine/config';
import { isUnsafe } from '@onset/engine/envutil';
import { goRound } from '@onset/engine/gofmt';
import { rejectSymlinkPath } from '@onset/engine/project';
import * as scene from '@onset/engine/scene';
import { currentEnvironment, validateTolerance } from './cli';
import { num, str } from './ops/common';
import { defineOp } from './ops/op';

defineOp({
  name: 'scene_repair',
  cli: ['scene', 'repair'],
  summary: '按问题单局部返修已有镜头，逐帧保护区间外画面',
  description: `用 project 内的 JSON 问题单指定局部帧区间，例如
{"issues":[{"start_frame":40,"end_frame_exclusive":70,"problem":"标题被遮挡","acceptance":"两行完整可读","evidence_frame":54}]}。
区间左闭右开，evidence_frame 可省略，缺省取区间中点。片场从原产物抽证据图，给渲染器简短任务。
返修后正常验收并逐帧检查区间外画面，没通过或取消时恢复原源码、视频与渲染记录。需要重做整个镜头时用 scene_run()。`,
  examples: ['scene_repair({"scene":"scenes/scene-008","request":"production/repair-008.json"})'],
  params: {
    scene: { type: 'string', description: '要返修的镜头目录', required: true, positional: 0 },
    request: { type: 'string', description: '项目或工作目录内的返修问题单 JSON 路径', required: true },
    duration_tolerance: { type: 'number', description: '产物时长容差，单位秒', default: 0.05 },
  },
  run: async (p, { out, signal, unsafe }) => {
    const cwd = fs.realpathSync('.');
    const target = scene.contained(cwd, str(p.scene), '镜头目录');
    const s = scene.load(target);
    const root = scene.findProjectRoot(s.directory) || cwd;
    const request = scene.contained(cwd, str(p.request), '返修问题单');
    rejectSymlinkPath(cwd, path.resolve(cwd, str(p.request)));
    const stats = fs.statSync(request);
    if (!stats.isFile() || stats.size > 32 * 1024) throw new Error('返修问题单须为不超过 32 KiB 的普通 JSON 文件');
    const { fps } = scene.sceneCanvas(s);
    const issues = scene.parseRepairIssues(JSON.parse(fs.readFileSync(request, 'utf8')), goRound(s.duration_seconds * fps));
    const tolerance = num(p.duration_tolerance);
    validateTolerance(tolerance);
    const { evidence } = await scene.repairScene(s, issues, config.load(root, null), isUnsafe(unsafe), currentEnvironment(), out, tolerance, signal);
    return { data: { scene: s.id, output: scene.outputPath(s), evidence, issues: issues.length } };
  },
});
