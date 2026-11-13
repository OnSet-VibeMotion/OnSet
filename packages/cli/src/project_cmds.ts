/**
 * am init、am config、am archive。移植自 internal/cli/cli.go 里内联定义的这三个命令。
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
import { canvasOptions, resolveCanvas, resolveStyle, resolveStyleBrief, styleBriefDocument, styleBriefPath, styleOptions } from './canvas';
import { currentEnvironment, exactArgs, hyperframesVersion, maxArgs, noArgs, skillsProgressPrinter } from './cli';
import { Command, type Out, ref } from './cobra';
import { reportFilmStyle } from './filmstyle';

const narrationSolo = projectinit.NarrationSolo;
const narrationCast = projectinit.NarrationCast;

export function newInitCommand(stdout: Out, stderr: Out): Command {
  const skipHyperframes = ref(false);
  const canvasID = ref('');
  const styleID = ref('');
  const styleBrief = ref('');
  const styleBriefFile = ref('');
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
由模型根据本片内容与各镜头文案自由决定。旧版风格参数仍接受，但只为兼容旧脚本，
不会成为渲染提示词或渲染前置校验。
旧版 --style 可选值（仅用于兼容旧脚本）：
` +
      styleOptions() +
      `

frame.md 仅为旧项目保留，供画幅等技术信息读取；它不再规定镜头的视觉风格。

写入内容：
  PROMPT.md、PROMPT-PRODUCTION.md、article-to-motion.conf、.env.example
  frame.md（画幅技术信息；旧版风格参数会带出兼容文件）、assets/fonts/ 中文字体、assets/style-guide/ 示例
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
production 阶段的 TTS 与时间线装配规程改为遵守随项目下发的
PROMPT-CAST-ADDENDUM.md，具体规则见该文件。cast.yaml 刚建出时 packs 为空
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
      if (narration.value !== narrationSolo && narration.value !== narrationCast) {
        throw new Error(`无效的 --narration: ${narration.value}（可选：${narrationSolo} ${narrationCast}）`);
      }
      const target = path.resolve(args.length === 1 ? args[0] : '.');
      if (!['speech', 'song', 'beat'].includes(delivery.value)) throw new Error('--delivery 必须为 speech、song 或 beat');
      projectinit.validate({ target, canvas: '', style: preset.CustomStyle, delivery: delivery.value, narration: narration.value });
      const filmStyle = filmStyleName.value !== '' ? filmstyle.lookup(filmStyleName.value) : undefined;
      const chosen = await resolveCanvas(canvasID.value, process.stdin, stdout);
      const style = resolveStyle(styleID.value);
      const brief = resolveStyleBrief(style, styleBrief.value, styleBriefFile.value);
      const extra: Record<string, string> = {};
      if (brief !== '') extra[styleBriefPath] = styleBriefDocument(brief);
      const result = projectinit.create({ target, canvas: chosen.id, style, delivery: delivery.value, narration: narration.value, extra });
      stdout.write(`项目已初始化：${target}（画幅 ${chosen.label}，新增 ${result.created}，未变 ${result.unchanged}）\n`);
      // 风格文件只为旧项目和画幅读取保留，不再作为渲染前的定稿门禁。
      if (filmStyle) {
        let installed: filmstyle.InstallResult;
        try {
          installed = filmstyle.install({ projectDir: target, style: filmStyle, env: currentEnvironment() });
        } catch (err) {
          throw new Error(`项目文件已写入，但整片风格安装失败（之后可用 am film-style use ${filmstyle.styleKey(filmStyle)} 重试）：${(err as Error).message}`);
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
  flags.stringVar(styleID, 'style', '', '旧版视觉风格参数（仅兼容，不作为渲染要求）：' + [...preset.styleIDs(), preset.CustomStyleFlag].join(' | '));
  flags.stringVar(styleBrief, 'style-brief', '', '旧版自定义风格描述（仅兼容），只能与 --style ' + preset.CustomStyleFlag + ' 一起使用');
  flags.stringVar(styleBriefFile, 'style-brief-file', '', '从文件读取旧版自定义风格描述，与 --style-brief 二选一');
  flags.stringVar(narration, 'narration', narrationSolo, '叙事模式：' + narrationSolo + '（单口播，默认） | ' + narrationCast + '（多角色对话，额外写出 cast.yaml 与 cast/）');
  flags.stringVar(filmStyleName, 'film-style', '', '整片风格：来源/目录名，或唯一的目录名、中文名、英文名（am film-style list）；不传则各镜头自主定视觉');
  flags.stringVar(delivery, 'delivery', 'speech', '讲解形式：speech（默认）、song（单人整曲）或 beat（无配音卡点）');
  return initCmd;
}

export function newConfigCommand(stdout: Out): Command {
  const configCmd = new Command({
    use: 'config',
    short: '读取解析后的配置',
    long: `读取 am 解析后的配置值。

不要自己去读 article-to-motion.conf 或 .env——解析涉及四层优先级
（环境变量 > 项目 .env > article-to-motion.conf > 内置默认），只有本命令的
输出等于 am 实际会用的值。`,
  });
  configCmd.addCommand(
    new Command({
      use: 'get ORCHESTRATOR|RENDERER|TTS_PROVIDER|ALIGN_PROVIDER',
      args: exactArgs(1, 'KEY'),
      short: '打印单个配置键',
      long:
        `把单个配置键的解析结果打印到 stdout，只有值本身加一个换行，便于直接捕获。

可用键：
  ORCHESTRATOR   编排工具：codex | claude | qoder | codebuddy | opencode
  RENDERER       渲染工具：同上取值范围
  TTS_PROVIDER   语音合成：` +
        config.ttsProviderIDs().split(' ').join(' | ') +
        `
  ALIGN_PROVIDER 已知文本强制对齐：` +
        config.alignerIDs().split(' ').join(' | ') +
        `
                 auto 在 Apple Silicon 上解析为 mlx，其余平台为 funasr；
                 本命令打印的是解析后的具体工具，不会是 auto

在当前工作目录解析配置，因此要在项目根运行。键名未知或解析出的值非法时退出码 1。`,
      example: `  # 捕获解析后的渲染工具
  renderer="$(am config get RENDERER)"

  # 环境变量优先级最高，可临时覆盖
  RENDERER=codex am config get RENDERER`,
      runE: (_cmd, args) => {
        const cfg = config.load('.', null);
        const values: Record<string, string> = { ORCHESTRATOR: cfg.orchestrator, RENDERER: cfg.renderer, TTS_PROVIDER: cfg.ttsProvider, ALIGN_PROVIDER: cfg.alignProvider };
        if (!Object.hasOwn(values, args[0])) throw new Error(`未知配置键：${args[0]}`);
        stdout.write(values[args[0]] + '\n');
      },
    }),
  );
  return configCmd;
}

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

export function newArchiveCommand(stdout: Out): Command {
  const mainRef = ref('');
  const archiveRoot = ref('');
  const archiveName = ref('');
  const yes = ref(false);
  const dryRun = ref(false);
  const archiveCmd = new Command({
    use: 'archive',
    short: '归档当前项目并复位到 main',
    long: `把本片的单片文件连同 SHA-256 清单移出仓库，并把工作区复位到冻结的 main 提交。

破坏性操作，且不属于成片验收的一部分。未经用户明确确认不要执行：
先跑 --dry-run 看计划，把结果原样汇报给用户，由用户决定是否继续。

会把相对 main 的改动分成三类，只有第一类会被归档：
  候选文件   main 提交里不存在的新增文件，以及全部未跟踪文件 → 移入归档目录
  共享修改   main 提交里已存在却被改动的文件 → 视为阻断
  ignored   被 .gitignore 忽略但存在于工作区的文件 → 视为阻断

存在共享修改或 ignored 文件时拒绝执行并报告。不要为了让它通过而删文件、移文件、
改 .gitignore 或重置工作区——那会掩盖问题。也不要删除项目分支或改写 Git 历史。

--archive-name 缺省为 project-<年月日-时分秒>。成功后工作区 detach 到 --main-ref
指向的提交。除非传 --yes，否则会在 stdin 上交互确认；非交互环境下没有 --yes 会取消。`,
    example: `  # 先看计划，不做任何改动
  am archive --dry-run

  # 用户确认后执行
  am archive

  # 非交互环境必须显式跳过确认
  am archive --yes --archive-root ~/video-archive --archive-name my-video-2026-08`,
    args: noArgs,
    runE: () => {
      const name = archiveName.value || 'project-' + archiveStamp();
      const plan = archive.buildPlan('.', mainRef.value, archiveRoot.value, name);
      stdout.write(`归档目标：${plan.destination}\n候选文件：${plan.candidates.length}\n共享修改：${plan.shared.length}\nignored：${plan.ignored.length}\n`);
      if (dryRun.value) return;
      if (!yes.value) {
        stdout.write('确认归档并复位到 main？[y/N] ');
        if (readLine().trim().toLowerCase() !== 'y') throw new Error('用户取消归档');
      }
      archive.execute(plan);
    },
  });
  const flags = archiveCmd.flags();
  flags.stringVar(mainRef, 'main-ref', 'main', '冻结的 main ref，归档后工作区 detach 到它指向的提交');
  flags.stringVar(archiveRoot, 'archive-root', '', '归档父目录，须在仓库之外');
  flags.stringVar(archiveName, 'archive-name', '', '归档目录名，缺省为 project-<年月日-时分秒>');
  flags.boolVar(yes, 'yes', false, '跳过交互确认；非交互环境执行归档时必须传');
  flags.boolVar(dryRun, 'dry-run', false, '只打印计划，不移动任何文件、不改动工作区');
  return archiveCmd;
}
