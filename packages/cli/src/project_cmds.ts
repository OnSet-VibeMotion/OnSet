/**
 * init（命令行专用）、config_get、archive。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as archive from '@am/engine/archive';
import * as config from '@am/engine/config';
import * as filmstyle from '@am/engine/filmstyle';
import '@am/engine/filmstyle/sources';
import * as hyperframes from '@am/engine/hyperframes';
import * as preset from '@am/engine/preset';
import * as projectinit from '@am/engine/projectinit';
import * as toolinstall from '@am/engine/toolinstall';
import { canvasOptions, resolveCanvas } from './canvas';
import { currentEnvironment, hyperframesVersion, maxArgs, skillsProgressPrinter } from './cli';
import { Command, type Out, ref } from './cobra';
import { reportFilmStyle } from './filmstyle';
import { defineGroup } from './ops/cli';
import { bool, str } from './ops/common';
import { defineOp } from './ops/op';

const narrationSolo = projectinit.NarrationSolo;

export function newInitCommand(stdout: Out, stderr: Out): Command {
  const skipHyperframes = ref(false);
  const canvasID = ref('');
  const narration = ref('');
  const delivery = ref('');
  const filmStyleName = ref('');
  const initCmd = new Command({
    use: 'init [DIR]',
    short: '初始化一个可复现的视频项目',
    long:
      `在 DIR（省略则为当前目录）写入视频项目骨架。

画幅在初始化时一次性选定并写入 frame.md，之后不再更改；改画幅意味着重建项目。
可选画幅（均 30fps）：
` +
      canvasOptions() +
      `
非交互环境（CI、管道）必须显式传 --canvas，不会静默取默认值；不传且无法交互时报错退出。

视觉风格不属于初始化契约：画幅决定画布与安全区，配色、字体、版式、材质和动效
由模型根据本片内容与各镜头文案自由决定，或用 --film-style 选一种整片风格。

frame.md 只记画幅的技术信息：画布与帧率、安全区、烧录字幕的缺省样式与混音响度目标。

写入内容：
  article-to-motion.conf、.env.example、article-to-motion.flow.json（记下讲解形式对应的流程与画幅；
  制作提示词不写进项目，开工时按这份记录组合）
  frame.md（画幅技术信息）、assets/fonts/ 中文正文字体
  templates/project-rules.md（am run 据此派生 AGENTS.md / CLAUDE.md 等）
  .agents/skills/ 内置技能树（text-to-lottie、algorithmic-art），随二进制下发

不覆盖内容不同的已有文件：目标已存在且字节不同就整体失败并回滚，不做合并。
字节相同则视为已存在并跳过，因此对同一画幅重复执行是幂等的，可安全用于补齐缺失文件。

默认把固定版本 ` +
      hyperframesVersion +
      ` 的 HyperFrames 官方技能从本机缓存拷进项目的
.agents/skills/，与内置技能树同一个目录。am init 不联网：技能是前置资源，先运行一次
am setup 把它下载进缓存；缓存里没有时 am init 写完项目文件后报错，提示先 am setup
再重跑 am init 补齐。--skip-hyperframes 跳过这一步；它不影响内置技能树，那随二进制下发。

技能装进项目而不是装进 HOME，是因为项目之间互不覆盖只有这样才成立：上游
安装器只认 homedir，一台机器上只有一份技能，两个项目固定不同版本时谁后
初始化谁说了算。装进项目还让项目自包含——整个目录拷到另一台机器就能渲染。
安装不写任何 agent 的技能目录。校验过的技能树按 commit 缓存在
~/.local/share/am/hyperframes/（遵循 XDG_DATA_HOME），所有项目从这里拷贝。

技能不走上游安装器：它只克隆仓库默认分支，没有指定 tag 的口子，同一个版本号
隔几天装出来的技能可以不同。am 自己按 tag 浅克隆并校验 commit 与技能数量，
两次初始化的技能树逐字节一致。安装后在 .agents/skills/` +
      hyperframes.ManifestFile +
      `
里记下版本、上游 commit 与每个技能的内容摘要。

上游技能与内置技能重名时保留内置版本并告警，不会覆盖本仓库 fork 过的技能。

叙事模式由 --narration 一次性选定，默认 solo（单口播）。传 cast 会额外在
项目根写 cast.yaml 并建出空的 cast/ 目录，进入多角色对话叙事模式；此时
配音与时间线装配改为遵守制作提示词末尾的「附：多角色叙事作业规程」。cast.yaml 刚建出时 packs 为空
列表，这是预期状态：项目在第一次 am cast add / am cast new 之前本来就还
没有可用角色。

--film-style 给全片选一种整片风格（各风格来源的风格，am film-style list 查看），
等同于初始化后运行 am film-style use；不传时各镜头自主定视觉，之后也可以再选。
风格库同样是前置资源（am setup 下载），这里不联网，不受 --skip-hyperframes 影响。`,
    example: `  # 交互选择画幅
  am init my-video

  # 非交互环境必须显式指定画幅
  am init my-video --canvas vertical-9x16

  # 画幅之外不指定视觉风格，镜头由模型自由创作
  am init my-video --canvas vertical-9x16

  # 离线或 CI：跳过联网安装 HyperFrames 技能
  am init my-video --canvas vertical-3x4 --skip-hyperframes

  # 在当前目录补齐缺失的骨架文件（幂等）
  am init --canvas vertical-3x4

  # 多角色对话叙事：额外写出 cast.yaml 与 cast/
  am init my-story --canvas vertical-3x4 --narration cast

  # 全片用同一种风格（油画厚涂）
  am init my-video --canvas landscape-16x9 --film-style lemo-opuscar/impasto`,
    args: maxArgs(1, 'DIR'),
    runE: async (cmd, args) => {
      const modes = projectinit.narrations().map((n) => n.id);
      if (!modes.includes(narration.value)) throw new Error(`无效的 --narration: ${narration.value}（可选：${modes.join(' ')}）`);
      const target = path.resolve(args.length === 1 ? args[0] : '.');
      // 讲解形式就是项目的流程：可选值来自内置流程与内置插件登记的流程。
      const ids = projectinit.deliveryFlows().map((f) => f.id);
      if (!ids.includes(delivery.value)) throw new Error(`--delivery 必须为 ${ids.slice(0, -1).join('、')} 或 ${ids[ids.length - 1]}`);
      projectinit.validate({ target, canvas: '', delivery: delivery.value, narration: narration.value });
      const filmStyle = filmStyleName.value !== '' ? filmstyle.lookup(filmStyleName.value) : undefined;
      const chosen = await resolveCanvas(canvasID.value, process.stdin, stdout);
      const result = projectinit.create({ target, canvas: chosen.id, delivery: delivery.value, narration: narration.value });
      stdout.write(`项目已初始化：${target}（画幅 ${chosen.label}，新增 ${result.created}，未变 ${result.unchanged}）\n`);
      if (filmStyle) {
        let installed: filmstyle.InstallResult;
        try {
          installed = filmstyle.install({ projectDir: target, style: filmStyle, env: currentEnvironment() });
        } catch (err) {
          throw new Error(`项目文件已写入，但整片风格安装失败（之后可用 film_style_use({"style": "${filmstyle.styleKey(filmStyle)}"}) 重试）：${(err as Error).message}`);
        }
        reportFilmStyle(stdout, filmStyle, installed);
      }
      if (skipHyperframes.value) {
        stdout.write('警告：已跳过 HyperFrames 技能安装\n');
        return;
      }
      let installed: hyperframes.Result;
      try {
        installed = await projectinit.installSkills(target, currentEnvironment(), stderr, skillsProgressPrinter(stderr), cmd.context());
      } catch (err) {
        throw new Error(`项目文件已写入，但 HyperFrames 技能没装进项目（准备好后重跑 am init 补齐）：${(err as Error).message}`);
      }
      stdout.write(`HyperFrames ${hyperframesVersion} 技能已装入 ${hyperframes.SkillsSubdir}（${installed.installed.length} 个）\n`);
      try {
        hyperframes.requireCLI(currentEnvironment());
      } catch (cliErr) {
        stderr.write(`警告：${(cliErr as Error).message}\n`);
      }
      for (const name of installed.protected) stderr.write(`警告：上游技能 ${name} 与内置技能重名，已保留内置版本\n`);
    },
  });
  const flags = initCmd.flags();
  flags.boolVar(skipHyperframes, 'skip-hyperframes', false, '跳过从本机缓存拷入 HyperFrames 官方技能；不影响随二进制下发的内置技能树');
  flags.stringVar(canvasID, 'canvas', '', '画幅预设：' + preset.ids().join(' | ') + '；不传则在终端里交互选择');
  flags.stringVar(
    narration,
    'narration',
    narrationSolo,
    '叙事模式：' +
      projectinit
        .narrations()
        .map((n) => `${n.id}（${n.name}${n.id === narrationSolo ? '，默认' : ''}）`)
        .join(' | '),
  );
  flags.stringVar(filmStyleName, 'film-style', '', '整片风格：来源/目录名，或唯一的目录名、中文名、英文名（am film-style list）；不传则各镜头自主定视觉');
  flags.stringVar(
    delivery,
    'delivery',
    'speech',
    '讲解形式：' +
      projectinit
        .deliveryFlows()
        .map((f) => `${f.id}（${f.name}${f.id === 'speech' ? '，默认' : ''}）`)
        .join('、'),
  );
  return initCmd;
}

defineGroup({
  path: ['config'],
  summary: '读取解析后的配置',
  description: `读取 am 解析后的配置值。

不要自己去读 article-to-motion.conf 或 .env——解析涉及五层优先级
（环境变量 > 项目 .env > article-to-motion.conf > 客户端设置页的全局设置 > 内置默认），只有 config_get 的
结果等于 am 实际会用的值。`,
});

/**
 * config_set：改项目 article-to-motion.conf 里设置页管的那几项（客户端「设置」页的「这个项目」一栏）。
 * 只给命令行与客户端后端（scopes 只有 cli）：用哪个工具是用户的选择，不让编排工具自己改。
 * 原地改那一行、保留注释；值为空写成 KEY=，表示跟随全局设置。
 */
defineOp({
  name: 'config_set',
  cli: ['config', 'set'],
  summary: '改这个项目的一项设置；值为空表示跟随全局设置',
  description: `只改设置页管的几项：${config.GlobalKeys.join('、')}。
写进项目的 article-to-motion.conf，只对这个项目生效；值为空时写成 KEY=，这个项目改为跟随全局设置。`,
  examples: ['config_set({"key": "TTS_PROVIDER", "value": "breeze"})', 'config_set({"key": "TTS_PROVIDER", "value": ""})'],
  scopes: ['cli'],
  params: {
    key: { type: 'string', description: '设置项', required: true, positional: 0 },
    value: { type: 'string', description: '值；留空表示跟随全局设置', positional: 1 },
    project_root: { type: 'string', description: '项目根目录', default: '.' },
  },
  run: (p, { out }) => {
    const key = str(p.key);
    const value = str(p.value).trim();
    const problem = config.validateSetting(key, value);
    if (problem !== '') throw new Error(problem);
    const file = path.join(str(p.project_root), 'article-to-motion.conf');
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const lineOf = (k: string) => new RegExp(`^(\\s*(?:export\\s+)?)${k}\\s*=(.*)$`, 'm');
    const line = lineOf(key);
    // 换了工具：这个项目里给原来那家写的模型一起清掉，不然会交给新的那家（模型项本来就没写时不加行）。
    const modelKey = config.ToolModelKey[key];
    const previous = (line.exec(body)?.[2] ?? '').trim();
    if (modelKey && previous !== value && lineOf(modelKey).test(body)) body = body.replace(lineOf(modelKey), `$1${modelKey}=`);
    const next = line.test(body) ? body.replace(line, `$1${key}=${value}`) : body + (body === '' || body.endsWith('\n') ? '' : '\n') + `${key}=${value}\n`;
    fs.writeFileSync(file, next);
    out.write(value === '' ? `${key} 改为跟随全局设置\n` : `这个项目的 ${key} 改为 ${value}\n`);
    return { data: { key, value } };
  },
});

defineOp({
  name: 'config_get',
  cli: ['config', 'get'],
  summary: '读取单个配置键',
  description:
    `返回单个配置键的解析结果，只有值本身加一个换行。

可用键：
  ORCHESTRATOR   编排工具：codex | claude | qoder | codebuddy | opencode
  RENDERER       渲染工具：同上取值范围
  TTS_PROVIDER   语音合成：` +
    config.ttsProviderIDs().split(' ').join(' | ') +
    `
  TTS_MODEL      语音合成用的本机模型（目前只有 breeze）：客户端工具准备页下好的本地目录；
                 还没下好时返回模型的仓库名，请用户先在工具准备页安装配音；不用本机模型时为空
  ALIGN_PROVIDER 已知文本强制对齐：` +
    config.alignerIDs().split(' ').join(' | ') +
    `
                 auto 在 Apple Silicon 上解析为 mlx，其余平台为 funasr；
                 返回的是解析后的具体工具，不会是 auto
  ALIGN_MODEL    对齐工具用的模型：客户端工具准备页下好的本地目录；还没下好时返回模型的仓库名
                 （此时工具会在第一次运行时自己去下，网络不好会失败，请用户先在工具准备页安装字幕）

在项目根解析配置。键名未知或解析出的值非法时报错。`,
  examples: ['config_get({"key": "RENDERER"})', 'config_get({"key": "ALIGN_MODEL"})'],
  params: {
    key: { type: 'string', description: 'ORCHESTRATOR、RENDERER、TTS_PROVIDER、TTS_MODEL、ALIGN_PROVIDER 或 ALIGN_MODEL', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    const key = str(p.key);
    const cfg = config.load('.', null);
    const values: Record<string, string> = { ORCHESTRATOR: cfg.orchestrator, RENDERER: cfg.renderer, TTS_PROVIDER: cfg.ttsProvider, ALIGN_PROVIDER: cfg.alignProvider };
    const env = currentEnvironment();
    const local = (model: toolinstall.ModelSpec | undefined) =>
      !model ? '' : toolinstall.modelReady(model, env) ? toolinstall.modelDir(model, env) : model.repo;
    values.TTS_MODEL = local(config.TTSProviders.find((x) => x.id === cfg.ttsProvider)?.model);
    values.ALIGN_MODEL = local(config.Aligners.find((a) => a.id === cfg.alignProvider)?.model);
    if (!Object.hasOwn(values, key)) throw new Error(`未知配置键：${key}`);
    out.write(values[key] + '\n');
    return { data: { key, value: values[key] } };
  },
});

/** Go 的 time.Now().Format("20060102-150405")（本地时间）。 */
function archiveStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 从 stdin 读一行（Go 的 bufio.Reader.ReadString('\n')）；读不到返回空串。 */
function readLine(): string {
  const buf = Buffer.alloc(1);
  let line = '';
  try {
    while (fs.readSync(0, buf, 0, 1, null) === 1) {
      const ch = buf.toString('utf8');
      line += ch;
      if (ch === '\n') break;
    }
  } catch {
    // stdin 关闭或不可读：当作没有回答。
  }
  return line;
}

defineOp({
  name: 'archive',
  cli: ['archive'],
  summary: '归档当前项目并复位到 main',
  description: `把本片的单片文件连同 SHA-256 清单移出仓库，并把工作区复位到冻结的 main 提交。

破坏性操作，且不属于成片验收的一部分。未经用户明确确认不要执行：
先用 "dry_run": true 看计划，把结果原样汇报给用户，由用户决定是否继续。

会把相对 main 的改动分成三类，只有第一类会被归档：
  候选文件   main 提交里不存在的新增文件，以及全部未跟踪文件 → 移入归档目录
  共享修改   main 提交里已存在却被改动的文件 → 视为阻断
  ignored   被 .gitignore 忽略但存在于工作区的文件 → 视为阻断

存在共享修改或 ignored 文件时拒绝执行并报告。不要为了让它通过而删文件、移文件、
改 .gitignore 或重置工作区——那会掩盖问题。也不要删除项目分支或改写 Git 历史。

archive_name 缺省为 project-<年月日-时分秒>。成功后工作区 detach 到 main_ref
指向的提交。没有交互确认的地方（工具调用就是）必须在用户明确确认后传 "yes": true，否则取消。`,
  examples: [
    'archive({"dry_run": true})',
    '# 用户确认后执行',
    'archive({"yes": true})',
    'archive({"yes": true, "archive_root": "~/video-archive", "archive_name": "my-video-2026-08"})',
  ],
  params: {
    main_ref: { type: 'string', description: '冻结的 main ref，归档后工作区 detach 到它指向的提交', default: 'main' },
    archive_root: { type: 'string', description: '归档父目录，须在仓库之外' },
    archive_name: { type: 'string', description: '归档目录名，缺省为 project-<年月日-时分秒>' },
    yes: { type: 'boolean', description: '跳过交互确认；没有交互（工具调用）时执行归档必须传，且要用户先明确确认' },
    dry_run: { type: 'boolean', description: '只打印计划，不移动任何文件、不改动工作区' },
  },
  run: (p, { out }) => {
    const name = str(p.archive_name) || 'project-' + archiveStamp();
    const plan = archive.buildPlan('.', str(p.main_ref), str(p.archive_root), name);
    out.write(`归档目标：${plan.destination}\n候选文件：${plan.candidates.length}\n共享修改：${plan.shared.length}\nignored：${plan.ignored.length}\n`);
    const data = { destination: plan.destination, candidates: plan.candidates.length, shared: plan.shared, ignored: plan.ignored, archived: false };
    if (bool(p.dry_run)) return { data };
    if (!bool(p.yes)) {
      out.write('确认归档并复位到 main？[y/N] ');
      if (readLine().trim().toLowerCase() !== 'y') throw new Error('用户取消归档');
    }
    archive.execute(plan);
    return { data: { ...data, archived: true } };
  },
});
