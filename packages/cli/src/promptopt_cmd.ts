/**
 * scene_prompt_check / scene_prompt_apply：检查镜头的画面描述（prompt.md），采用改写稿。
 *
 * 检查调一次优化工具（OPTIMIZER，空则跟随编排工具），结果存成草稿，不改 prompt.md；
 * 用户在客户端看过差异点「采用」才走 scene_prompt_apply 写进去。只给命令行与客户端后端（scopes 只有 cli）：
 * prompt.md 本来就是编排工具写的，不让它再起一个自己来评自己。
 */
import path from 'node:path';
import * as config from '@onset/engine/config';
import * as envutil from '@onset/engine/envutil';
import * as ledger from '@onset/engine/ledger';
import * as promptopt from '@onset/engine/promptopt';
import * as scene from '@onset/engine/scene';
import * as studio from '@onset/engine/studio';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { bool, projectRoot, str } from './ops/common';
import { ParamError, defineOp } from './ops/op';

defineGroup({
  path: ['scene', 'prompt'],
  summary: '镜头画面描述：检查、采用改写稿',
  description: `检查镜头的 prompt.md 写得够不够具体、和口播与交接对不对得上，给出改写稿；采用之前不改项目文件。
检查用设置里的「润色与检查」工具（OPTIMIZER，留空跟随编排工具）。`,
});

/** 分镜里的一个镜头：按目录或编号找。 */
function findScene(board: studio.StoryboardResponse, root: string, want: string): number {
  const full = path.resolve(root, want);
  const byDir = board.scenes.findIndex((s) => path.resolve(root, s.dir) === full);
  if (byDir >= 0) return byDir;
  return board.scenes.findIndex((s) => s.id === want);
}

/** 交给模型的材料：这一镜的口播、时长、交接、前后几镜的说明、处理方案与画幅。 */
function evidenceOf(board: studio.StoryboardResponse, root: string, i: number, prompt: string): promptopt.SceneEvidence {
  const item = board.scenes[i]!;
  const e: promptopt.SceneEvidence = {
    scene: {
      id: item.id,
      ...(item.text ? { text: item.text } : {}),
      ...(item.seconds !== undefined ? { seconds: item.seconds } : {}),
      ...(item.chapter ? { chapter: item.chapter } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.visual_role ? { visual_role: item.visual_role } : {}),
      style: item.style.cn,
    },
    prompt,
  };
  const handoff = (h: studio.StoryboardScene['handoff'], peer: string): promptopt.HandoffEvidence | undefined =>
    h ? { peer, device: h.device_label || h.device, bridge: h.bridge, ...(h.style_shift ? { style_shift: h.style_shift_label || h.style_shift } : {}) } : undefined;
  const prev = board.scenes[i - 1];
  const next = board.scenes[i + 1];
  if (prev) e.handoff_in = handoff(item.handoff, prev.id);
  if (next) e.handoff_out = handoff(next.handoff, next.id);
  const neighbors: NonNullable<promptopt.SceneEvidence['neighbors']> = [];
  for (const [offset, position] of [[-2, '前两镜'], [-1, '上一镜'], [1, '下一镜'], [2, '后两镜']] as const) {
    const n = board.scenes[i + offset];
    if (n) neighbors.push({ id: n.id, position, ...(n.summary ? { summary: n.summary } : {}), ...(n.visual_role ? { visual_role: n.visual_role } : {}) });
  }
  if (neighbors.length > 0) e.neighbors = neighbors;
  if (board.treatment) e.treatment = board.treatment.content;
  try {
    const c = scene.sceneCanvas({ directory: path.resolve(root, item.dir) });
    e.canvas = { width: c.widthPx, height: c.heightPx, fps: c.fps };
  } catch {
    // 没有 frame.md：少一项材料，不拦检查。
  }
  return e;
}

defineOp({
  name: 'scene_prompt_check',
  cli: ['scene', 'prompt', 'check'],
  summary: '检查镜头的画面描述，给出评分、问题与改写稿（存成草稿，不改 prompt.md）',
  description: `读镜头的 prompt.md 与它的口播、时长、交接、前后镜头的说明和 production/treatment.md，
按文意对应、画面具体度、时长匹配、交接与连贯、歧义控制五项各打 0–100 分，列出最多 3 条问题，
判断不用改、小改还是重写，要改时给出改写稿。

改写稿要原样保留素材路径、引号里的文字与「不要 / 禁止 / 必须」这类要求，也不能凭空多出素材文件；
核对不过时重试一次，还不过就只给评估。结果存在 production/studio/prompt-checks/<镜头编号>.json，
用 scene_prompt_apply() 采用。all 为真时检查分镜里全部有 prompt.md 的镜头，按 SCENE_JOBS 并发。`,
  examples: ['scene_prompt_check({"scene": "scenes/scene-003"})', 'scene_prompt_check({"all": true})'],
  scopes: ['cli'],
  params: {
    scene: { type: 'string', description: '镜头目录或镜头编号', positional: 0 },
    all: { type: 'boolean', description: '检查分镜里全部有画面描述的镜头' },
    project_root: projectRoot,
  },
  run: async (p, { out, signal, unsafe }) => {
    const root = path.resolve(str(p.project_root));
    const board = studio.readStoryboard(root);
    let targets: number[];
    if (bool(p.all)) {
      targets = board.scenes.map((s, i) => (s.prompt ? i : -1)).filter((i) => i >= 0);
      if (targets.length === 0) throw new ParamError('分镜里还没有写好画面描述（prompt.md）的镜头');
    } else {
      if (str(p.scene) === '') throw new ParamError('要给 scene（镜头目录或编号），或者 all: true');
      const i = findScene(board, root, str(p.scene));
      if (i < 0) throw new ParamError(`分镜里找不到镜头 ${str(p.scene)}`);
      targets = [i];
    }
    const cfg = config.load(root, null);
    const { tool, model, options } = promptopt.optimizerOf(cfg);
    const isUnsafe = envutil.isUnsafe(unsafe);
    const env = config.childEnvironment(cfg, currentEnvironment(), isUnsafe, envutil.parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''));
    out.write(`检查工具: ${tool}${model ? `（${model}）` : ''}\n`);
    const call = (text: string) => promptopt.callOnce({ tool, model, options, prompt: text, env, unsafe: isUnsafe, signal, ledgerFile: ledger.projectFile(root), source: ledger.SourcePromptCheck });

    const results: Record<string, unknown>[] = [];
    const failures: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const i = targets[next++]!;
        const item = board.scenes[i]!;
        const prompt = promptopt.readPromptFile(path.resolve(root, item.dir));
        if (prompt === null || prompt.trim() === '') {
          failures.push(`${item.id}：还没有画面描述（prompt.md）`);
          continue;
        }
        try {
          const result = await promptopt.check(evidenceOf(board, root, i, prompt), call);
          const draft: promptopt.PromptCheck = {
            scene: item.id,
            dir: item.dir,
            base_sha256: promptopt.sha256(prompt),
            checked_at: new Date().toISOString(),
            tool,
            model,
            ...result,
          };
          promptopt.writeCheck(root, draft);
          results.push({ scene: item.id, decision: result.decision, issues: result.issues, has_rewrite: result.prompt !== undefined });
          out.write(`${item.id}：${decisionText(result)}${result.issues.length > 0 ? `\n  - ${result.issues.join('\n  - ')}` : ''}\n`);
        } catch (err) {
          if (signal.aborted) throw err;
          failures.push(`${item.id}：${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(cfg.sceneJobs, 1), targets.length) }, worker));
    for (const f of failures) out.write(`没检查成：${f}\n`);
    if (results.length === 0) throw new Error(failures.join('\n'));
    return { data: { checked: results, failed: failures } };
  },
});

function decisionText(r: promptopt.CheckResult): string {
  if (r.decision === 'skip') return '不用改';
  if (r.rejected) return `改写稿没有采用（${r.rejected.join('；')}）`;
  return r.decision === 'minor' ? '建议小改' : '建议重写';
}

defineOp({
  name: 'scene_prompt_apply',
  cli: ['scene', 'prompt', 'apply'],
  summary: '采用 scene_prompt_check 给出的改写稿，写进镜头的 prompt.md',
  description: `把草稿里的改写稿写进 prompt.md，然后删掉草稿。检查之后 prompt.md 又被改过时拒绝：
那份改写稿是对着旧稿写的，要重新检查。已经渲染过的镜头采用后输入变了，会被标成需要重新渲染。`,
  examples: ['scene_prompt_apply({"scene": "scene-003"})'],
  scopes: ['cli'],
  params: {
    scene: { type: 'string', description: '镜头编号', required: true, positional: 0 },
    project_root: projectRoot,
  },
  run: (p, { out }) => {
    const root = path.resolve(str(p.project_root));
    const id = path.basename(str(p.scene));
    const file = promptopt.applyCheck(root, id);
    out.write(`已写入 ${file}\n`);
    return { data: { file } };
  },
});
