import fs from 'node:fs';
import path from 'node:path';
import { load as loadConfig } from '@onset/engine/config';
import * as flow from '@onset/engine/flow';
import { atomicWrite } from '@onset/engine/fsutil';
import { marshalIndent } from '@onset/engine/gojson';
import { lockFile, PinnedVersion } from '@onset/engine/hyperframes';
import { initializeWithFiles, rejectSymlinkPath } from '@onset/engine/project';
import {
  ComponentPlanFile,
  contained,
  load,
  newScene,
  parseComponentPlan,
  parseMotionEffectsInput,
  sceneToJSON,
  verifyFilmStyleValue,
  verifySceneMotionEffects,
  verifySceneText,
} from '@onset/engine/scene';
import { projectRulesFilename, ValidRenderers } from '@onset/engine/tools';
import { projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

const rules = `# 镜头渲染规则

- HyperFrames 版本固定为 ${PinnedVersion}，由片场管理。用 \`hyperframes({"subcommand": "<子命令>"})\`；每条命令单独执行。禁止 npx、全局 HyperFrames 或改动技能。
- 只在本镜头目录工作。可读项目根的 .agents/skills/ 及镜头提示词点名的共享资源。
- 保留 scene.json 的执行契约，不读取 .env 或打印凭据。
`;

export function scenePrepare(
  root: string,
  manifest: string,
  srt: string,
): { created: number; existing: number; hint?: string } {
  root = fs.realpathSync(root);
  const readInput = (relative: string) => {
    // 输入与输出都从项目内普通文件取得，避免把链接目标复制进镜头。
    const file = path.resolve(root, relative);
    const parts = path.relative(root, file).split(path.sep);
    if (path.isAbsolute(relative) || parts.some((part) => part.startsWith('.')))
      throw new Error('镜头清单与字幕必须是项目内的非隐藏文件');
    rejectSymlinkPath(root, file);
    const source = contained(root, relative, '输入');
    if (!fs.statSync(source).isFile()) throw new Error(`输入必须是普通文件：${relative}`);
    return fs.readFileSync(source);
  };
  const document = JSON.parse(readInput(manifest).toString('utf8'));
  if (!Array.isArray(document?.scenes) || document.scenes.length === 0)
    throw new Error('镜头清单必须包含非空 scenes 数组');
  const subtitles = readInput(srt);
  const cfg = loadConfig(root, null);
  const ids = new Set<string>();
  const files = new Map<string, Uint8Array>();
  let motionSources: flow.MotionEffectSource[] | null = null;
  let motionAssigned = 0;
  let existing = 0;
  for (const entry of document.scenes) {
    const { id, text, prompt, renderer = '', film_style = '' } = entry ?? {};
    if (
      typeof id !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(id) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)
    ) {
      throw new Error('镜头 id 必须是可用的目录名');
    }
    if (ids.has(id.toLowerCase())) throw new Error(`镜头 id 重复：${id}`);
    ids.add(id.toLowerCase());
    if (typeof text !== 'string' || typeof prompt !== 'string' || !prompt.trim())
      throw new Error(`镜头 ${id} 缺少文案或任务书`);
    verifySceneText(text);
    if (typeof renderer !== 'string' || (renderer && !ValidRenderers.has(renderer)))
      throw new Error(`镜头 ${id} 的 renderer 不合法`);
    if (typeof film_style !== 'string') throw new Error(`镜头 ${id} 的 film_style 必须是字符串`);
    verifyFilmStyleValue(film_style);
    const motion_effects = parseMotionEffectsInput(entry?.motion_effects, `镜头 ${id} 的 motion_effects`);
    if (motion_effects.length > 0) {
      motionSources ??= flow.listMotionSources();
      verifySceneMotionEffects(motion_effects, motionSources, `镜头 ${id}`);
    }
    const directory = `scenes/${id}`;
    const sceneFile = path.join(root, directory, 'scene.json');
    rejectSymlinkPath(root, sceneFile);
    if (fs.existsSync(sceneFile)) {
      const existingScene = load(path.dirname(sceneFile));
      if (existingScene.id !== id) throw new Error(`已有镜头目录的 id 不符：${id}`);
      if (existingScene.motion_effects.length > 0) motionAssigned++;
      existing++;
      continue;
    }
    if (motion_effects.length > 0) motionAssigned++;
    const scene = newScene({
      id,
      text,
      renderer,
      film_style,
      motion_effects,
      duration_seconds: 1,
      output: 'out.mp4',
      transcript: 'transcription.srt',
    });
    files.set(`${directory}/scene.json`, Buffer.from(marshalIndent(sceneToJSON(scene)) + '\n'));
    files.set(`${directory}/prompt.md`, Buffer.from(prompt.trimEnd() + '\n'));
    files.set(`${directory}/transcription.srt`, subtitles);
    files.set(`${directory}/${projectRulesFilename(renderer || cfg.renderer)}`, Buffer.from(rules));
  }
  const plan =
    document.shared_components === undefined
      ? undefined
      : parseComponentPlan(
          document.shared_components,
          new Set(document.scenes.map((entry: { id: string }) => entry.id)),
        );
  const planFile = path.join(root, ComponentPlanFile);
  if (plan) rejectSymlinkPath(root, planFile);
  // Scaffolds are created before publishing the plan so it never refers to half-created scenes.
  initializeWithFiles(root, files);
  if (plan) {
    const body = marshalIndent({ schema: 1, shared_components: plan }) + '\n';
    if (!fs.existsSync(planFile) || fs.readFileSync(planFile, 'utf8') !== body) atomicWrite(planFile, body);
  }
  const hint =
    ids.size >= 5 && motionAssigned === 0
      ? `提示：全片 ${ids.size} 个镜头均未指定 motion_effects；如关键镜头需要标志性动效手法，请在分镜审核关卡与用户确认后再渲染。`
      : undefined;
  return { created: ids.size - existing, existing, ...(hint ? { hint } : {}) };
}

defineOp({
  name: 'scene_prepare',
  cli: ['scene', 'prepare'],
  summary: '从镜头任务清单批量创建契约、任务书、字幕副本与渲染规则',
  description: `清单为 JSON，例如 {"scenes":[{"id":"scene-001","text":"本镜头文案","prompt":"创意、交接和验收要求"}]}。
每个条目还可指定 renderer、film_style、motion_effects（单镜最多 3 条，支持简写如 "005" 或完整 "来源:id"）。统一生成到 scenes/<id>。已有 scene.json 的镜头保持原样；要修订已有镜头，直接更新对应任务书。
清单根部可加 shared_components，例如 [{"name":"dossier","source_scene":"scene-007","scenes":["scene-008"]}]。从同一份计划为产出镜头提示导出、为使用镜头自动挂载；省略此字段保留已有计划，传空数组清空计划。已有镜头也直接读取整片计划。
字幕用全片时间，允许空 SRT。新镜头时长为占位，随后调用 scene_cues() 或 beat_cues() 写入正式时长。`,
  examples: ['scene_prepare()', 'scene_prepare({"srt":"transcription.srt"})'],
  params: {
    project_root: projectRoot,
    manifest: { type: 'string', description: '镜头任务清单', default: 'production/scene-briefs.json' },
    srt: { type: 'string', description: '全片字幕', default: 'transcription-production.srt' },
  },
  run: async (p, { out, signal }) => {
    const root = fs.realpathSync(str(p.project_root));
    const lock = path.join(root, '.onset/scene-prepare.lock');
    rejectSymlinkPath(root, lock);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const unlock = await lockFile(lock, signal);
    try {
      signal.throwIfAborted();
      const result = scenePrepare(root, str(p.manifest), str(p.srt));
      out.write(`已创建 ${result.created} 个镜头，保留 ${result.existing} 个已有镜头\n`);
      if (result.hint) out.write(`${result.hint}\n`);
      return { data: result };
    } finally {
      unlock();
    }
  },
});
