/**
 * cast 一组操作（new / add / validate / preview）、dialogue 一组操作（assemble / beats）与 validate_cast，
 * 由多角色对话插件在 apply 里登记（castOps）。移植自 internal/cli/cast.go。
 *
 * internal/cast 包只定义角色包格式与校验规则，不碰文件系统之外的东西
 * （怎么落地、怎么登记进项目班底）。这里是唯一把它接到操作表上的地方。
 */
import path from 'node:path';
import * as castbeats from '../../castbeats';
import * as config from '../../config';
import * as dialogue from '../../dialogue';
import { formatFixed } from '../../gofmt';
import { num, projectRoot, str, strs } from '../../opkit';
import type { PluginContext } from '../../plugin/types';
import { runCastAdd, runCastNew } from './pack_ops';
import { castProblems } from './validate';
import { resolveCastValidateProvider, runCastPreview, runCastValidate, runDialogueBeats } from './validate_ops';

export { copyTree } from './pack_ops';

/** dialogue_assemble 未传 plan 时的默认路径，与编排流程里 TTS 分段产物的落地位置一致。 */
const dialogueDefaultPlanPath = path.join('production', 'audio', 'plan.json');

/** 多角色对话插件的操作（cast_*、dialogue_*、validate_cast）。 */
export function castOps(ctx: PluginContext): void {
  ctx.opGroup({
    path: ['cast'],
    summary: '角色包相关操作',
    description: `管理角色包（character pack）：生成骨架、引入外部包、校验、生成预览图。

角色包是 cast/<id>/ 下的一个目录，至少包含 character.yaml（清单）与
rig.svg（骨架图）。项目根的 cast.yaml 登记了哪些角色包属于本项目的班底，
它存在与否就是叙事模式本身。

每次 cast_new / cast_add / cast_validate 成功后都会在角色包目录里重新生成 character.json：
它是 character.yaml 的等价 JSON，供驱动库 cast.js 在无头 Chrome 里用
JSON.parse 读取——渲染机的 CSP 环境下引不进 YAML 解析库。character.yaml
仍是人工编辑的唯一真相源，character.json 只是产物，不要手改。

⚠️ 手改 character.yaml 后不会自动同步：character.json 只在 cast_new / cast_add /
cast_validate 成功时重新生成，onset 不会比较两者的修改时间。手改完 yaml 却忘记调一次
cast_validate()，渲染机读到的仍是旧 json——不会报错、不会警告，成片里角色
的音色、姿势、关节范围仍是改动前的值，问题只会在肉眼比对渲染结果时才会
发现。改完 character.yaml，一律先调 cast_validate() 再渲染。`,
  });

  ctx.op({
    name: 'cast_new',
    cli: ['cast', 'new'],
    summary: '生成一个可自洽的角色包骨架',
    description: `在 cast/<id>/ 下写出 character.yaml、rig.svg、dna.md 三件套骨架，
并把 cast/<id> 登记进项目根的 cast.yaml（不存在则按约定默认值新建）。

骨架里的 voiceId 留空：真实音色由人工在 character.yaml 里补上，dna.md 会
提示这一点。写完立即用 cast.Load 自检，一旦不自洽就删除已写文件并报错——
不会在项目里留下半成品。自检通过后额外写出 character.json（见 cast 一组的说明）。

目标目录已存在且非空时拒绝执行，不会覆盖已有内容。`,
    examples: ['cast_new({"id": "heiwa"})'],
    params: { id: { type: 'string', description: '角色 id，角色包写到 cast/<id>/', required: true, positional: 0 } },
    run: (p, { out }) => {
      const dir = runCastNew(out, str(p.id));
      return { data: { dir } };
    },
  });

  ctx.op({
    name: 'cast_add',
    cli: ['cast', 'add'],
    summary: '引入一个外部角色包',
    description: `校验 dir 是一个自洽的角色包后，把它拷贝进 cast/<id>/ 并登记进
项目根的 cast.yaml。

先校验后拷贝，不是拷贝后回滚：dir 校验不通过时，项目里不会留下任何
新文件。拷贝会拒绝源目录里出现的任何符号链接——理由与新建项目时拒绝模板里的
符号链接一样：链接可能指向项目外，拷进项目后会被当成普通文件静默读取，是
一个隐蔽的路径逃逸口子。

cast.yaml 不存在时会新建，defaults 取 ground_y: 0.78、
gap_ms: {turn: 240, interject: 100}；已存在则在其 packs 列表里追加一条，
已登记过的角色包不会重复追加。

成功后会在 cast/<id>/ 里写出 character.json（见 cast 一组的说明）。`,
    examples: ['cast_add({"dir": "../shared-characters/heiwa"})'],
    params: { dir: { type: 'string', description: '外部角色包目录', required: true, positional: 0 } },
    run: (p, { out }) => {
      const dest = runCastAdd(out, str(p.dir));
      return { data: { dir: dest } };
    },
  });

  ctx.op({
    name: 'cast_validate',
    cli: ['cast', 'validate'],
    summary: '校验角色包',
    description: `校验角色包能否通过 cast.Load，并重新生成它们的 character.json。

不传 packs 时：
  - 项目根有 cast.yaml，则校验它 packs 列表里登记的全部角色包；
  - 没有 cast.yaml，则扫描 cast/ 目录下每一个含 character.yaml 的子目录；
  - 两者都没有则视为无事可做，不算失败。

传 packs 时，把每一项当成角色包目录，逐个 cast.Load，与是否登记进
cast.yaml 无关。

任一角色包 rig/schema 校验失败就报错；问题按包分组列出，一次看到
全部，不是修一个报一个。

校验通过顺带重新生成 character.json（渲染机实际读取的格式）。手改
character.yaml 后如果没调这个工具，character.json 就是旧的且不会有任何
报错或警告——渲染机会静默用回旧值。改完 yaml，渲染前一律先调一次。

顺带提醒当前 TTS_PROVIDER 是否缺音色（不影响成败，只在通过行后面追加
提醒）：这是做完角色包后第一个会调的工具，音色缺口应当在这时就被看到，
而不是等到 validate_cast() 在发布前才拦下——那条硬校验仍然存在，不受这里
影响。provider 缺省取 config_get({"key": "TTS_PROVIDER"})，解析不到完整项目配置
（比如还不是完整的项目、ORCHESTRATOR/RENDERER 尚未配置）就跳过这项提醒，
不连带让 rig 校验也失败——这里的音色检查是附带诊断，不是主职责。`,
    examples: [
      'cast_validate()',
      'cast_validate({"packs": ["cast/heiwa", "cast/xiaoming"]})',
      'cast_validate({"provider": "bailian"})',
    ],
    params: {
      packs: { type: 'strings', description: '角色包目录，缺省为 cast.yaml 登记的全部', positional: 'rest' },
      provider: { type: 'string', description: '校验音色缺口时按哪个 TTS provider，缺省取解析后的 TTS_PROVIDER' },
    },
    run: (p, { out }) => runCastValidate(out, strs(p.packs), resolveCastValidateProvider(str(p.provider))),
  });

  ctx.op({
    name: 'cast_preview',
    cli: ['cast', 'preview'],
    summary: '把角色包的每个命名姿势渲成一张验收图',
    description: `cast.Load 校验 pack 后，为它的每一个视图各自把声明的每个姿势渲成 PNG
并拼成一张 contact sheet，写到 production/cast-preview/，供人眼验收关节
角度是否合理。角色包只有默认视图时只会生成一张。

依赖 rsvg-convert（渲染单张姿势）和 ImageMagick 的 magick（拼图），
两者缺一都会失败并说明缺的是哪个命令。`,
    examples: ['cast_preview({"pack": "cast/heiwa"})'],
    params: { pack: { type: 'string', description: '角色包目录', required: true, positional: 0 } },
    run: (p, { out }) => ({ data: { sheets: runCastPreview(out, str(p.pack)) } }),
  });

  ctx.opGroup({
    path: ['dialogue'],
    summary: '多角色对白装配相关操作',
    description: `把分说话人合成的配音段装配成一条完整对白时间线。

分段 TTS 只给得到段内相对时间戳，拼成全局时间轴要逐段累加偏移、插入段间
静音、再拼接成一条完整音轨——这类机械计算算错了不会报错，只会让成片画面
正常、嘴和字却对不上，所以收进这一组工具而不是留给编排工具自己拼。`,
  });

  ctx.op({
    name: 'dialogue_beats',
    cli: ['dialogue', 'beats'],
    summary: '按 dialogue.json 重算各镜头 scene.json 的 cast.beats',
    description:
      `读取 ` +
      castbeats.DialogueRelPath +
      ` 与 scenes/*/scene.json，把每一行台词
按镜头切片、减去该镜头的全局起点，写回各镜头 cast 块的 beats。

镜头怎么切是创作判断（每个镜头的 duration_seconds 由你定），但"给定对白
时间线与已定的镜头时长，算出每个镜头的节拍"是纯机械计算——减错一个镜头
起点，成片画面正常、只是角色在不该说话的时候动嘴，什么都不会报错。所以
这一步收进这个工具，不要手写 beats。

行为：

  - 一行台词横跨镜头切点时按切点拆成多拍，各自落进自己的镜头
  - 有 cast 块但整段无人说话的镜头写出空数组（"算过了，确实没人说话"）
  - 没有 cast 块又没有台词盖过的镜头一个字节都不碰（老镜头零影响）
  - 只改 cast.beats：pack_dir / ground_y / on_stage 与其它字段原样保留
  - 既有 beats 一律忽略并整体重写：它是这个工具的输出，不是输入。改小过
    duration_seconds、旧节拍越界的镜头不需要先手工清理，直接重跑
  - 幂等：重复执行结果一致，内容没变的文件不重新落盘

项目根没有 cast.yaml（单口播项目）时直接报错：cast.beats 只在多角色
模式下存在。

有台词盖过、却没写 cast 块的镜头会报错而不是现编一个——这里不替你决定
角色站位。台词落在所有镜头覆盖范围之外时同样报错，那是镜头 duration_seconds
与配音对不上，先对齐时长再重算。任一检查不通过就一个文件都不写。`,
    examples: ['dialogue_beats()'],
    params: {},
    run: (_p, { out }) => ({ data: runDialogueBeats(out) }),
  });

  ctx.op({
    name: 'dialogue_assemble',
    cli: ['dialogue', 'assemble'],
    summary: '把 plan.json 里的分段配音装配成一条对白时间线',
    description: `读取 plan 指定的 plan.json，把里面登记的每一段配音统一格式、按需插入
段间静音后拼接成一条完整音轨，同时算出全局时间轴，产出三个文件：

  ${dialogue.VoiceRelPath}       拼接后的完整配音
  ${dialogue.SRTRelPath}     按全局时间轴生成的字幕
  ${dialogue.DialogueRelPath}         装配结果的结构化时间线（schema ${dialogue.SchemaVersion}）

装配过程内置两道漂移断言：逐段声明时长与实测时长的比对、总时长漂移
（容差 ${formatFixed(dialogue.DriftToleranceSeconds, 3)} 秒）比对，任一超出容差都会失败并点名具体是第几段、哪个文件、
声明多少、实测多少——这些错误原样透出，不额外包装。

expect_total 是可选的第三道校验：外部（通常是编排工具）期望的总时长，
用于额外核对；不传就只做上面两道内部一致性断言。`,
    examples: [
      'dialogue_assemble()',
      'dialogue_assemble({"plan": "production/audio/plan.json", "expect_total": 42.5})',
    ],
    params: {
      plan: { type: 'string', description: 'plan.json 路径', default: dialogueDefaultPlanPath },
      expect_total: { type: 'number', description: '外部期望总时长（秒），用于额外校验；可选，缺省不做这道校验' },
    },
    run: async (p, { out, signal }) => {
      const result = await dialogue.assemble(
        { root: '.', planPath: str(p.plan), expectTotalSeconds: num(p.expect_total) },
        signal,
      );
      out.write('对白已装配：\n');
      out.write(`  音频：${dialogue.VoiceRelPath}\n`);
      out.write(`  字幕：${dialogue.SRTRelPath}\n`);
      out.write(`  时间线：${dialogue.DialogueRelPath}\n`);
      out.write(`总时长：${formatFixed(dialogue.totalSeconds(result), 3)} 秒\n`);
      return {
        data: {
          voice: dialogue.VoiceRelPath,
          srt: dialogue.SRTRelPath,
          dialogue: dialogue.DialogueRelPath,
          total_seconds: dialogue.totalSeconds(result),
        },
      };
    },
  });

  ctx.op({
    name: 'validate_cast',
    cli: ['validate', 'cast'],
    summary: '校验多角色项目的项目级一致性',
    verb: '校验多角色项目',
    description: `校验班底、对白时间线与镜头节拍三者是否互相吻合：

  - cast.yaml 登记的角色包能否加载，班底是否为空
  - 每个角色是否声明了当前 TTS_PROVIDER 的音色
  - production/dialogue.json 是否存在、schema 正确，字幕行数与
    transcription-production.srt 是否一致，逐行时间是否连续不重叠
  - dialogue.json 里的说话人是否都在班底里
  - 所有 scenes/*/scene.json 的 cast.beats 换算回全局时间后，是否合并
    覆盖了 dialogue.json 的全部台词行，以及每个 on_stage 角色的 dna.md
    是否存在于渲染提示词会引用的路径

项目没有 cast.yaml（单口播模式）时视为无事可做，直接通过：这组检查
只对多角色项目生效，对老项目零影响。

TTS_PROVIDER 缺省按 config_get({"key": "TTS_PROVIDER"}) 的解析结果，provider
可显式覆盖。`,
    examples: ['validate_cast()', 'validate_cast({"provider": "bailian"})'],
    params: {
      project_root: { ...projectRoot, description: '项目根目录，缺省为当前目录' },
      provider: { type: 'string', description: 'TTS_PROVIDER，缺省取项目配置的解析结果' },
    },
    run: (p, { out }) => {
      const rootDir = str(p.project_root) !== '' ? str(p.project_root) : '.';
      const resolvedProvider = str(p.provider) !== '' ? str(p.provider) : config.load(rootDir, null).ttsProvider;
      const problems = castProblems(rootDir, resolvedProvider) ?? [];
      if (problems.length > 0) throw new Error(`多角色项目一致性校验未通过：\n  - ${problems.join('\n  - ')}`);
      out.write('多角色项目一致性校验通过\n');
      return { data: { ok: true } };
    },
  });
}
