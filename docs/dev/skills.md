# 技能树

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

`assets/shared/.agents/skills/<name>/` 是随 `onset init` 下发到用户项目根 `.agents/skills/` 的技能树。`scene.resolveSkill` 从镜头目录逐级向上找 `.agents/skills`，落到项目根就能被发现，用户无需另行安装。

`hyperframes`、`hyperframes-cli` 等官方技能不在这棵树里，但**落点相同**：`onset init` 通过 `packages/engine/src/hyperframes` 把它们按固定版本装进同一个 `.agents/skills/`。这棵源树只放本仓库自带的技能。

官方技能不能直接跑 `npx hyperframes skills` 装——上游安装器只认 `homedir()`，没有任何选项能改落点（`skills update --dir` 的帮助原文写着 "scopes the prune, not the install"）。装在机器级会让项目之间互相覆盖：一台机器只有一份技能，项目 A 与项目 B 固定不同版本时谁后初始化谁说了算。

更要命的是上游安装器根本给不了可复现性：它 `git clone` 仓库默认分支取技能，没有指定 ref 的口子，技能内容随上游 `main` 漂移而版本号不变（实测 0.8.1 与 0.8.14 装出来逐字节相同）。所以 `hyperframes` 包不调用它，改为自己按 tag 浅克隆并校验 commit 与技能数量，见 `packages/engine/src/hyperframes/constants.ts` 里 `PinnedSkillsCommit` / `PinnedSkillsCount` 的注释；安装后写一份 `hyperframes-upstream.json` 记录 commit 与每个技能的内容摘要，见 `manifest.ts`。校验过的技能树按 commit 缓存在用户级目录（`defaultCacheDir`）；缓存只在调用方显式传 `Options.cacheDir` 时启用，测试里传临时 `HOME` 的用例因此仍能断言 HOME 一个字节都没动。缓存按技能数判可用。

**要联网的东西都是前置资源**（`packages/engine/src/prereq`）：HyperFrames 技能（`hyperframes.prepareSkills`）、HyperFrames CLI（`ensureCLI`）、内置插件登记的前置资源（`ctx.prereq`，例如卡点插件的节拍分析环境 `beat.ensureEnv`）、各整片风格来源的数据（`Source.prepare`，由登记来源的内置插件经 `ctx.prereq` 登记成 `styles:<来源>`；lemo-opuscar 含全部 demo、海报、core/assets 与 three.js 依赖）以及渲染用浏览器（`hyperframes.ensureBrowser`）、ffmpeg / ffprobe 与 uv（`toolinstall`）、项目选用的配音与对齐工具（`toolinstall.ensureTool`，按 `providers.ts` 里各家的 `install` 描述）只由 `onset setup` 或客户端的安装页（`studio/setup.ts`）下载——两边跑同一份清单（`prereqs.items`）、同一份日志，都能看进度、加代理、断了重来。其余路径只检查：`onset init` / 客户端新建用 `Options.cacheOnly` 从缓存拷技能，`onset hyperframes` 与 `scene.run` 用 `requireCLI`，`beat_analyze` / `beat_doctor` 用 `beat.requireEnv`，`onset film-style use` 与客户端用 `filmstyle.install` / `Source.check`，缺了一律抛 `prereq.MissingError`（文案统一指向 `onset setup`）。`scene.run` 渲染前还要 `requireBrowser`（不然 HyperFrames 会在第一次渲染时自己下 390 MB 的 chrome-headless-shell）。**不要再在这些路径里加自动下载**：以前建项目、渲染、打开菜单时各自现下载，网络一差就卡在半路，用户看不到卡在哪，渲染途中卡住还白花一次模型调用。`onset setup` 的界面（`packages/cli/src/setupview.ts`）每项一行、按显示宽度对齐，终端里原地重画，管道里每次状态变化打一行；git / npm 的原始输出一律写进 `<数据目录>/onset/setup.log`（`packages/cli/src/setup.ts`），失败时屏幕只给错误、日志最后几行与日志路径——别再把子进程输出直接接到终端，混进进度行就乱了。`onset setup --proxy` 用 `GIT_CONFIG_PARAMETERS` 只给 git 设代理：设成 `HTTPS_PROXY` 的话 npm 也走它，国内镜像经代理反而连不上（实测）。要从 GitHub release、Google 存储下载的（ffmpeg、uv、uv 的 Python、浏览器）经 `prereqs` 的 `withProxy` 设 `https_proxy`，curl 与 HyperFrames 都认；GitHub release 也可以设 `ONSET_GITHUB_MIRROR` 走镜像，文件都按钉死的 sha256 核对。

**开箱即用**：客户端用户的 Mac 上可以什么都没有（没有 Node、Python、Homebrew、Xcode 命令行工具），装好 .app、点一次安装页就能做片。约定如下，改动时别打破：

| 约定 | 原因 |
|---|---|
| 外部工具一律经 `packages/engine/src/toolpath` 找：随客户端下发的（`ONSET_BUNDLED_BIN`）→ `onset setup` 装的（`<数据目录>/onset/bin`，`ONSET_BIN_DIR`）→ PATH。`envutil.addExecutableLocation` 把 onset 的 bin 目录加在子进程 PATH **末尾** | 编排工具按名字调 `mmx`、`edge-tts` 时能找到，又不盖过用户自己装的同名工具 |
| 要 Node 的地方（HyperFrames CLI、npm、npm 类配音工具）用 onset 自己的运行时启动（`toolpath.nodeCommand`：客户端里是 Electron 带 `ELECTRON_RUN_AS_NODE=1`），**不往 PATH 前面塞 node**；只有 `npm install` 跑依赖的安装脚本时，经 `toolpath.withNode` 给那一个子进程补一个临时的 `node` | 塞进 PATH 的话编排工具这一轮里跑的 npx、用户自己的脚本都会换成 Electron。esbuild 的 postinstall 写的是 `node install.js` |
| 客户端自带 npm：`apps/desktop/scripts/vendor.mjs` 在打包前 `npm pack` 固定版本到 `vendor/npm`（不进版本库），`scripts/afterpack.cjs` 拷进 `.app/Contents/Resources/npm`，shim 经 `ONSET_NPM_CLI` 告诉 onset。**不能走 extraResources** | electron-builder 复制 extraResources 时一律丢掉 node_modules（filter 写进去也不行，实测），npm 一运行就缺 graceful-fs |
| 渲染用浏览器借客户端自带的 Chromium：`apps/desktop/src/main/browser.ts` 是浏览器模式（入口 `entry.ts` 按 `ONSET_BROWSER_MODE` 分流），包装脚本 `userData/bin/onset-browser`（`clishim.ts` 的 `browserScript`）经 `ONSET_BROWSER` → `HYPERFRAMES_BROWSER_PATH` 交给 HyperFrames。浏览器模式接管 puppeteer 的管道（fd 3/4），转给 Electron 自己的调试端口，只把 `Target.createTarget` / `closeTarget` 换成开、关隐藏窗口 | Electron 不支持 `Target.createTarget`（实测 Not supported），而 HyperFrames 每次都 `newPage()`。macOS 上 HyperFrames 用截图取帧，隐藏窗口截图与 headless-shell 逐字节相同（2D 画面；WebGL 因 Chromium 版本不同有几个像素差）。管道必须用 `net.Socket` 读写：fs 流阻塞读 fd 3，退出时互等，进程永远退不掉；内部 CDP 请求的 id 必须在 32 位以内，超出 Chromium 不回复（都实测过） |
| Windows 上同样借用，但不走包装脚本：HyperFrames 经引导脚本启动（`hyperframes/browserhook.ts`，`cliCommandFor` 在 `ONSET_BROWSER_HOOK=1` 时用它），`HYPERFRAMES_BROWSER_PATH` 是 CLI 目录里的替身 `onset-browser(.exe)`；引导脚本包住 `child_process` 的 spawn / spawnSync / execFile / execFileSync（再 `syncBuiltinESMExports`），启动替身时换成本应用（`ONSET_BOOT_APP_EXE`，只给这个进程去掉 `ELECTRON_RUN_AS_NODE`、加浏览器模式、去掉调试管道参数，`--version` 直接回答），管道模式不传 fd 3/4，改开一条本机命名管道（`ONSET_BROWSER_PIPE` 加口令），`stdio[3]`/`stdio[4]` 换成接到它上面的流。macOS 上预设 `ONSET_BROWSER_HOOK=1` 也走这条（验证用，与包装脚本出片逐帧相同）。`browserhook.test.ts` 用假的 HyperFrames 与假浏览器钉着 | puppeteer 不经 shell 启动浏览器，Node 修了 CVE-2024-27980 后不让这样起 `.cmd` / `.bat`，包装只能是 `.exe`；fd 3/4 在 Windows 上靠 C 运行时另一套机制传，接不接得住没验证过。用替身而不是本应用的 `.exe`：HyperFrames 的 `process.execPath` 就是它，看门狗、工作进程也用这个路径起，同一个路径会被当成启动浏览器（测试撞上过）。不写原生启动器，免得给 Windows 加编译工具链、多一个容易被杀毒软件误报的 `.exe` |
| 没有 git 时技能改从 GitHub 逐个文件下载（`hyperframes/download.ts`），按 git blob 摘要核对；`toolpath.usableGit` 用 `xcode-select -p` 判断 `/usr/bin/git` 是不是占位程序 | 整仓 tarball 144 MB，技能只有几 MB；占位 git 一运行就弹窗要装命令行工具。lemo 风格库与 `onset archive` 仍要 git，缺了提示 `xcode-select --install` |
| ffmpeg 不打进 .app，由 `onset setup` 下载 eugeneware/ffmpeg-static 的静态构建（`toolinstall.FFmpegRelease`）；系统里已有就直接就绪 | HyperFrames 与 `concat` 都写死 libx264（GPL），LGPL 构建渲染不了；随应用发布 GPL + x264 要背许可与专利义务 |
| Python 类工具（edge-tts、tccli、mlx-audio、funasr）与没有合适 Python 时的节拍环境都用 uv，Python 装在 `<数据目录>/onset/python`；uv 不读 pip.conf，`toolinstall.pipIndexURL` 把 pip.conf 的 `index-url` 转成 `UV_DEFAULT_INDEX`。节拍环境用 `uv venv --seed`，后面照旧 `python -m pip`（读 pip.conf） | 国内用户的镜像配在 pip.conf 里，不转过去 torch 会从境外直连 |
| 工具第一次运行才下的模型也是前置资源：对齐工具与配音工具的 `model`（`providers.ts` 的 `QwenForcedAligner`、`FunASRTimestampModel`、`BreezeTTS2`，文件与 sha256 钉死）由 `toolinstall.ensureModel` 下到 `<数据目录>/onset/models/`，先探 Hugging Face 通不通，不通就从魔搭下同名仓库；`align_run` 与内置配音直接定位本地模型 | huggingface.co 在国内常常连不上，hf-mirror 现在也 308 跳回 huggingface.co（2026-11 实测），不预先下好就是在对齐时现下载 1.27 GB |
| 测试的 testsupport 把 `ONSET_BROWSER` 指到假浏览器（`hftest.fakeBrowser`）、`ONSET_BIN_DIR` 指到空目录 | 开发机上 `~/.local/share/onset/bin` 里真实的 ffmpeg、mmx 不能混进测试 |


HyperFrames **CLI** 与技能分开管理但同一个版本：`hyperframes.ensureCLI`（`packages/engine/src/hyperframes/cli.ts`）用 `npm install hyperframes@<PinnedVersion>` 装进用户级 `~/.local/share/onset/hyperframes/cli-<版本>`（`CLIDirEnv` 可覆盖），在临时目录里装好、跑过 `--version` 自检、写完成标记后整体改名进位，失败重试 3 次；npm 沿用用户自己的 `~/.npmrc`（国内镜像、代理、鉴权）。`onset init`（经 `projectinit.installSkills`）与 `scene.run`（启动渲染器之前）都会确保它在，所有调用一律写成 `onset hyperframes <子命令>`（`hyperframes.CLICommand`），提示词、锁定文件规则与安全模式放行列表用的是同一个字符串。不再让渲染器 `npx --yes hyperframes@<版本>`：版本一升级，第一次渲染就要在途中现下载，网络一差渲染器空等二十多分钟、白花一次模型调用，只留下「没有产物」（实测）。`config.childEnvironment` 显式传 `ONSET_HYPERFRAMES_CLI_DIR`，理由同风格库目录；`scene.run` 还把当前 `onset` 放进渲染器的 `PATH`。命令行测试的 `packages/cli/src/testutil.ts` 与 Studio 后端测试的 `packages/engine/src/studio/testsupport.ts` 用 `hyperframes/hftest` 的 `fakeCLI` 造一份假的已装 CLI。

技能安装全程不碰用户 HOME：在项目外的临时目录里克隆、筛出含 `SKILL.md` 的目录，再整体搬进项目（`packages/engine/src/hyperframes/hyperframes.ts`）。早先的做法是在临时 HOME 里让上游安装器照常工作，那时有三个承重的细节；现在不调上游安装器了，但以后任何要在改写过 HOME 的环境里跑 npx / npm 的地方，这三条仍然成立：

| 细节 | 不这么做会怎样 |
|---|---|
| 用 `node -e process.execPath` 解析真实 npx | asdf / nvm / volta 的 shim 靠 HOME 找 node，改写 HOME 后直接报 `unknown command: npx` |
| 接回 `npm_config_cache` | 缓存写进临时 HOME，每个项目重新下载整包 |
| 接回 `npm_config_userconfig` | 读不到用户 `.npmrc`，私有 registry、代理和鉴权全丢，公司内网装不上 |

上游产物里出现符号链接时直接报错而不是照搬（`copyTree`）：那些链接指回临时目录，搬进项目后会成为静默失效的空技能。受保护技能名从内置资产树现读（`assets.builtinSkills()`，经 `Options.protectedSkills` 传入），新增内置技能自动受保护，不会被上游同名技能覆盖。

技能分两种来源，`SkillDescriptor.source`（`packages/engine/src/scene/skills.ts`）是它们的分水岭——不是元数据，而是契约：缺失补救、升级方式和守护测试全都不同。

| 来源 | 谁装 | 能否进内置资产树 |
|---|---|---|
| `SourceEmbedded` | 随客户端下发，`project.initialize` 写进项目 | **必须**在 `assets/shared/.agents/skills/` |
| `SourceUpstream` | `onset init` 按固定版本从上游装进项目 | **禁止**——那会留一份永远追不上上游的陈旧副本 |

两条门禁互为反面，都在 `packages/engine/src/project/skilltree.scene.test.ts`：「every registered skill is embedded」查前者在不在内置资产树，「upstream skills are not vendored into the embedded tree」查后者在不在。把上游技能拷进 `assets/` 能让第一条变绿，但会被第二条抓住。

新增一个**内置**技能要动的地方：

| 位置 | 作用 |
|---|---|
| `assets/shared/.agents/skills/<name>/SKILL.md` | 技能本体，`SKILL.md` 是必需文件 |
| `packages/engine/src/assets/index.ts` | 已含 `assets/shared/.agents`，新技能自动覆盖（名字别以 `.` 或 `_` 开头） |
| 描述符（`source: SourceEmbedded`）与 `<name>Prompt` 函数 | 属于某个功能的技能由那个内置插件在 `apply` 里 `ctx.skill(...)` 登记（例如 `plugins/cast/skill.ts` 的 character-rig），每个镜头都带；宿主自己的（scene-kit）追加在 `packages/engine/src/scene/skills.ts` 的 `registeredSkills`。提示词片段挂在描述符的 `promptSection` 上；不写 `promptSection` 的技能只解析目录，由别处按需引用（song-explainer 由 song 块引用） |
| `assets/shared/templates/project-rules.md` | 下发规则要点名它，有门禁强制（「builtin skills are documented in project rules」） |

全部技能（宿主的加上内置插件登记的）是 `scene.allSkills()`，下面的技能树门禁按它查，插件登记的技能一条都不能松；每个镜头用的也是它（内置插件常开）。

新增一个**上游**技能只要在 `registeredSkills` 加一条 `source: SourceUpstream` 的描述符加提示词片段——它已经被 `onset init` 装进项目了，注册只是让 `onset` 把绝对路径和用法边界写进渲染提示词。

注册上游技能时要收窄范围，上游技能的职责范围通常比单镜头渲染大得多：

- `hyperframes` 是入口技能，0.8.185 起上游把 `hyperframes-animation`、`hyperframes-core`、`hyperframes-creative` 并进了它，组合契约（`SKILL.md` 的 Contract、`references/format.md`）与动效手法（`references/motion.md`）都只在这里。它的本职却是整片制作：故事线三选一、`SPEC.md`、分镜、配乐音效、预览审批、桌面应用交接与 `REVIEW.md`。分镜由上层决定并已写进 `scene.json`，不收窄的话渲染器会产出计划文件、给镜头配乐（产物必须无音轨），还会停下来等人审批。另有两处与本项目正面冲突，要点名覆盖：`references/look.md` 让渲染器把项目根的 `frame.md` 当作配色与字体规范，而本项目的 `frame.md` 不是视觉命令；`references/format.md` 允许 `local()` 引用本机字体，换一台机器渲染结果就不同。
- `hyperframes-cli` 覆盖 `cloud` / `cloudrun` / `lambda` / `publish` 远端渲染路径，`skills` / `upgrade` 这类改动已装技能的命令，以及 `preview` / `open` / `catch-up` / `history` / `feedback` / `usage` 这类交互、桌面应用与遥测命令。第一类绕开本机确定性前提，第二类会顶掉固定版本、影响同项目其他镜头，第三类在无头渲染里要么卡住等人，要么往外发数据。`timeline` 只放行只读的 `--json`，它的改写子命令与「时长由 `scene.json` 决定」冲突。CLI 的写法本身也由这一段教：`scene.hyperFramesCommand()` 返回 `hyperframes.CLICommand`（`onset hyperframes`），同时用于提示词和 `rendererAccess` 的放行列表，并要求每条命令单独执行、不拼 `cd …;` / `&&`。以前只有放行列表里有前缀，全靠编排工具写的渲染器锁定文件转告；锁定文件一缺，渲染器写成不带版本的 `npx hyperframes`，整场 lint、check、render 全被拦下，没有产物（实测）。

这些禁令只存在于我们自己写的提示词片段里，上游不会替我们守，所以 `packages/engine/src/scene/skills.test.ts` 有对应的门禁盯着。`hyperframes` 的 `requiredFiles` 包含提示词点名的 `references/*.md`：用 0.8.14 初始化的旧项目里入口技能只有一页路由说明，按缺失处理并在渲染前告警，比把渲染器指向不存在的文件强。

`packages/engine/src/project/skilltree.test.ts` 与 `skilltree.scene.test.ts` 守着这条链：注册了但没随客户端下发、下发了但镜头目录找不到、技能目录缺 `SKILL.md`，都会失败。**这些失败必须修，不能豁免**——`resolveSkill` 按设计在找不到技能时不报错只降级，没有这道门就会一路静默到成片质量变差才被发现。

fork 自外部项目的技能要带 `LICENSE` 和 `ATTRIBUTION.md`，后者记清上游 commit、保留了什么、丢了什么、改了哪几处，供日后同步上游时重做。`text-to-lottie` 的 `references/` 还有一道门禁止上游播放器契约（`Skottie`、`public/projects` 等）回流（`skilltree.test.ts` 的「forked skill carries no upstream player contract」）。
