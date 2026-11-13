/**
 * 镜头操作：scene_run、scene_run_all（frames、cues、lint、usage 在各自的模块里）。
 * 移植自 internal/cli/cli.go 里内联定义的部分。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as beat from '@am/engine/beat';
import * as config from '@am/engine/config';
import * as envutil from '@am/engine/envutil';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import * as song from '@am/engine/song';
import * as srt from '@am/engine/srt';
import { newUsage, usageAdd, type Usage } from '@am/engine/tools';
import { beatCoverage } from './beat_cmd';
import { currentEnvironment, validateTolerance } from './cli';
import { ExitError } from './cobra';
import { attachMemory, newRunID } from './memory_cmd';
import { defineGroup } from './ops/cli';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';
import { reuseDecision } from './reuse';
import { songCoverage } from './song_cmd';
// 镜头组里的其余操作（frames、cues、lint、usage）在各自的模块里登记。
import './media';
import './review_cmd';
import './scene_cues';
import './usage_cmd';

const required = scene.requiredFields();
const optional = scene.optionalFields();

defineGroup({
  path: ['scene'],
  summary: '镜头相关操作',
  description: `渲染镜头。编排流程里调用，也可以单独对一个镜头用。

一个镜头是一个目录，至少包含：
  scene.json   执行契约，字段见下
  prompt.md    本镜头的创意方向（可选，缺失时使用内置的通用创意方向）
  transcript   完整字幕，供渲染工具理解上下文

scene.json 只接受 ${required.length} 个必填字段 ${required.join('、')}，
以及 ${optional.length} 个可选字段 ${optional.join('、')}（cast 是多角色叙事的角色配置，见 README「多角色叙事」一节）。
出现任何未知字段直接失败。这份字段清单与 scene.load 的校验逻辑同源，改字段集时两处不会漂移。
duration_seconds 保留毫秒精度写成小数秒（如 2.833），不得取整。
text 不得含 [[USER_MESSAGE]] 或 <scene-text> 定界标记，含则失败。

渲染工具由 scene.json 的 renderer 决定，未声明则取配置的 RENDERER；
解析不到直接报错，不存在静默回退。

渲染输出中只有以 [[USER_MESSAGE]] 开头的行会转给用户，其余进日志文件：
  render-<镜头编号>.stream.jsonl / .stderr.log / .user.log`,
});

const durationTolerance = { type: 'number', description: '产物时长与 duration_seconds 的允许偏差（秒），有限非负数', default: 0.15 } as const;

defineOp({
  name: 'scene_run',
  cli: ['scene', 'run'],
  summary: '执行单个镜头',
  description: `渲染这一个镜头，产出 scene.json 里 output 指定的 MP4。

无条件重新渲染：不做已有产物检查，也没有 force。需要跳过已完成镜头时用 scene_run_all()。

渲染完成后校验产物时长是否落在 duration_seconds ± duration_tolerance 内，
超出则失败。容差必须是有限非负数。

启动前解析技能目录并把绝对路径写进渲染提示词。动效技能未找到时打印警告并降级为
按技能名引用，不中断渲染——成片动效质量会下降，值得处理。`,
  examples: ['scene_run({"scene": "scenes/scene-001"})', '# 放宽产物时长容差到 0.3 秒', 'scene_run({"scene": "scenes/scene-001", "duration_tolerance": 0.3})'],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    duration_tolerance: durationTolerance,
  },
  run: async (p, { out, err, signal, unsafe }) => {
    const tolerance = num(p.duration_tolerance);
    validateTolerance(tolerance);
    const cfg = config.load('.', null);
    let s = scene.load(str(p.scene));
    s = attachMemory(s, cfg, err, newRunID());
    await scene.run(s, cfg, envutil.isUnsafe(unsafe), currentEnvironment(), out, tolerance, signal);
    return { data: { scene: s.id, output: scene.outputPath(s) } };
  },
});

defineOp({
  name: 'scene_run_all',
  cli: ['scene', 'run-all'],
  summary: '并行执行多个镜头',
  description: `并发渲染 scenes 下的所有镜头。镜头之间无创作依赖，跨镜头关系由各镜头的交接状态和 prompt.md 保证。

每个镜头开跑前先判定状态，判定结果直接决定要不要重渲染：
  已有合格产物   产物存在、通过校验，且输入指纹与产物的渲染记录一致 → 跳过
  Stale         产物合格但输入变了 → 不自动重渲染，标记为需要显式 "force": true，
                避免悄悄覆盖人工确认过的成片；报告里写明是哪几项输入变了
  其余           渲染

输入指纹覆盖组好的渲染提示词、scene.json、prompt.md、字幕、角色包、
渲染工具、技能内容与 am 版本，产物通过校验时记在镜头目录的 .am-render.json。
没有渲染记录的产物同样标 Stale。

force 跳过全部上述判定，无条件重渲染每个镜头。

jobs 取值 1..16，缺省读配置 SCENE_JOBS（其自身默认为 3）。retries 取值 0..5。
越界直接失败，不做截断。

重试只针对渲染器非零退出，退避 10 秒与 30 秒。产物规格校验失败不重试：
同样的提示词和渲染器重跑只会得到同样不合规的产物，而每次重试都是一次完整的
AI CLI 调用。这类失败要先改提示词或时长声明再重跑。

渲染开始前先做覆盖校验：镜头编号是否唯一，以及给了 srt 时，镜头总时长是否
等于字幕跨度（容差 coverage_tolerance，默认 0.1 秒）。默认只警告，
strict_coverage 让它在渲染前直接失败——漏掉一镜要等全部渲染完拼接时才发现，
那时每一镜都已经烧掉一次完整的 AI CLI 调用。

被取消时停止派发新任务、终止在飞进程组，并写出部分报告。

有镜头失败时调用失败；此时 report_json 写出的文件仍然完整，
应当读它来判断是哪些镜头失败，而不是解析人类可读的表格。`,
  examples: [
    'scene_run_all({"scenes": "scenes/"})',
    '# 并发 3、失败重试 2 次，并写出机器可读报告',
    'scene_run_all({"scenes": "scenes/", "jobs": 3, "retries": 2, "report_json": "production/run-report.json"})',
    '# 渲染前先核对镜头拆分是否完整覆盖字幕，不通过就不开工',
    'scene_run_all({"scenes": "scenes/", "srt": "transcription.srt", "strict_coverage": true})',
    '# 输入改过、镜头被判为 Stale 时，显式重渲染',
    'scene_run_all({"scenes": "scenes/", "force": true})',
  ],
  params: {
    scenes: { type: 'string', description: '镜头目录的上级目录', required: true, positional: 0 },
    jobs: { type: 'integer', description: '并发上限，取值 1..16；缺省读配置 SCENE_JOBS，其自身默认为 3', default: 0 },
    retries: { type: 'integer', description: '单个镜头失败后的最大重试次数，取值 0..5', default: 2 },
    duration_tolerance: durationTolerance,
    force: { type: 'boolean', description: '跳过「已有合格产物」与 Stale 判定，无条件重渲染每个镜头' },
    report_json: { type: 'string', description: '把逐镜头结果写成 JSON 报告到该路径；镜头失败时应读它' },
    song_timeline: { type: 'string', description: '歌曲覆盖基准，与 srt 互斥；包含前奏至尾奏' },
    srt: { type: 'string', description: '定稿字幕路径；给了就核对镜头总时长是否等于字幕跨度' },
    coverage_tolerance: { type: 'number', description: '镜头总时长与字幕跨度的允许偏差（秒）', default: 0.1 },
    strict_coverage: { type: 'boolean', description: '覆盖校验不通过时直接失败，而不是只打印警告' },
  },
  run: async (p, { out, err, signal, unsafe }) => {
    const songTimelinePath = str(p.song_timeline);
    const srtPath = str(p.srt);
    const tolerance = num(p.duration_tolerance);
    let jobs = num(p.jobs);
    const retries = num(p.retries);
    const force = bool(p.force);
    const reportPath = str(p.report_json);
    if (songTimelinePath !== '' && srtPath !== '') throw new Error('song_timeline 与 srt 互斥');
    validateTolerance(tolerance);
    const cfg = config.load('.', null);
    if (jobs === 0) jobs = cfg.sceneJobs;
    if (jobs < 1 || jobs > 16 || retries < 0 || retries > 5) throw new Error('jobs 必须为 1..16，retries 必须为 0..5');
    const scenes = schedule.plan(str(p.scenes));
    // 覆盖校验在渲染之前跑：漏掉一镜或某镜时长写错，等全部渲染完
    // 拼接时才发现的话，每一镜都已经烧掉一次完整的 AI CLI 调用。
    let span = 0;
    if (songTimelinePath !== '') {
      const file = path.resolve(songTimelinePath);
      const songRoot = path.dirname(path.dirname(path.dirname(file)));
      if (file !== path.join(songRoot, song.Store, 'timeline.json')) throw new Error('song_timeline 必须指向 production/song/timeline.json');
      const t = song.loadTimeline(songRoot);
      songCoverage(songRoot, scenes, t, true);
    } else if (song.enabled('.')) {
      throw new Error('歌曲项目必须提供 song_timeline：production/song/timeline.json');
    }
    if (srtPath !== '') span = srt.readSpan(srtPath).seconds();
    const problems = schedule.coverageProblems(scenes, span, num(p.coverage_tolerance));
    if (problems.length > 0) {
      const message = `镜头覆盖校验未通过：\n  - ${problems.join('\n  - ')}`;
      if (bool(p.strict_coverage)) throw new Error(message);
      err.write(`警告：${message}\n用 "strict_coverage": true 让这类问题在渲染前直接失败。\n`);
    }
    // 非整数帧时长会让渲染器多出一帧，拼接时才暴露；渲染前一次列全。
    const misaligned: string[] = [];
    for (const s of scenes) {
      try {
        scene.verifyFrameAlignment(s);
      } catch (e) {
        misaligned.push((e as Error).message);
      }
    }
    if (misaligned.length > 0) throw new Error(`镜头时长未对齐整数帧：\n  - ${misaligned.join('\n  - ')}`);
    for (const s of scenes) {
      if (s.song != null && songTimelinePath === '') throw new Error('歌曲镜头必须提供 song_timeline：production/song/timeline.json');
      scene.verifySongInputs(s);
      scene.verifyBeatInputs(s);
      scene.verifyTimingInputs(s);
    }
    if (beat.enabled('.')) beatCoverage('.', scenes);
    // 召回在判定复用之前做：召回的记忆是输入指纹的一项，记忆变了镜头要能被判成 Stale。
    const run = newRunID();
    for (let i = 0; i < scenes.length; i++) {
      scenes[i] = attachMemory(scenes[i], cfg, err, run);
    }
    // 每个镜头这一批里全部尝试（含重试）的用量，渲染结束后填进报告。
    const usage = new Map<string, Usage>();
    for (let i = 0; i < scenes.length; i++) {
      const id = scenes[i].id;
      const next = scenes[i].afterAttempt;
      scenes[i] = {
        ...scenes[i],
        afterAttempt: (attempt) => {
          const total = usage.get(id) ?? newUsage();
          usageAdd(total, attempt.usage ?? newUsage());
          usage.set(id, total);
          next?.(attempt);
        },
      };
    }
    const initial = new Map<string, schedule.OutcomeError>();
    if (!force) {
      const env = currentEnvironment();
      for (const item of scenes) {
        if (!fs.existsSync(scene.outputPath(item))) continue;
        try {
          scene.verifyOutput(item, env, tolerance);
        } catch {
          continue;
        }
        const [status, reason] = reuseDecision(item, cfg, env);
        initial.set(item.id, schedule.outcome(status, reason));
      }
    }
    // 已跳过的镜头不占渲染并发，worker 按真正要渲染的镜头数分。
    // 并发镜头往同一个 out 写阶段消息：Node 单线程，每次 write 是整行，不会互相切开。
    const workers = schedule.renderWorkers(os.availableParallelism(), schedule.systemMemory(), Math.min(jobs, scenes.length - initial.size));
    const report = await schedule.runAll(signal, scenes, jobs, retries, async (sig, s) => {
      const outcome = initial.get(s.id);
      if (outcome) throw outcome;
      s = scene.withRenderWorkers(s, workers);
      try {
        await scene.run(s, cfg, envutil.isUnsafe(unsafe), currentEnvironment(), out, tolerance, sig);
      } catch (e) {
        // 产物规格不符是确定性的：同样的提示词和渲染器重跑只会得到同样的产物。
        // 不在这里截断的话，每个规格不符的镜头都要白烧 retries 次 AI CLI 调用。
        if (e instanceof scene.VerificationError) throw schedule.fatal(e);
        throw e;
      }
    });
    schedule.attachUsage(report, usage);
    out.write(schedule.renderReport(report) + '\n');
    if (reportPath !== '') schedule.writeReportJSON(report, reportPath);
    const code = schedule.reportExitCode(report);
    if (code !== 0) throw new ExitError(code, '镜头执行未全部成功');
    return { data: schedule.reportToJSON(report) };
  },
});
