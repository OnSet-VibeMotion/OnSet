# 仓库规则

本仓库是 ArticleToMotion 的工具本体，交付物是 macOS 桌面客户端（`apps/desktop`，Electron）。`am`（`packages/cli`，打成一个 JS 文件，由客户端自带的 Electron 当 Node 运行）只随客户端留在 .app 里给客户端自己用——后台任务直接调它，编排工具与渲染器经它的工具服务（MCP，见「am 的工具服务」）调用——**命令行不对外提供**：没有安装到终端的入口，README 不教终端用法，提示词不教 `am <命令>`。开发与 CI 照常在终端里用它。客户端与 am 共用一份 TypeScript 引擎 `packages/engine`。它**不是**视频项目：这里不制作视频，也不存放任何单片内容。给视频项目用的规则是 `assets/shared/templates/project-rules.md`，那份文件随项目骨架下发到用户项目的 `templates/project-rules.md`，不约束本仓库的开发。

| 目录 | 内容 |
|---|---|
| `packages/engine/src/<包>/` | 引擎。包的公开 API 从各自的 `index.ts` 导出，外部用 `@am/engine/<包>` 引用。编码约定见 `packages/engine/CONVENTIONS.md`——为了与用户已有的项目文件、记忆库和渲染指纹逐字节兼容，JSON、数字格式、正则都有固定写法 |
| `packages/cli/src/` | am：制作步骤是操作表里的操作（`ops/op.ts` 的 `defineOp`，各模块加载时登记，例如 `scene_cmd.ts`；内置插件的操作经 `plugin_ops.ts` 订阅登记表），工具服务、客户端后端与开发用的命令行都从这张表来；`cli.ts` 只另挂 setup、init 与两个 MCP 服务。esbuild 打成 `packages/cli/dist/am.cjs` |
| `apps/desktop/` | Electron 客户端：主进程 `src/main/`，React 19 界面 `src/renderer/`，端到端测试 `e2e/` |
| `assets/` | 随客户端下发的内置资产，运行时从磁盘读，见「内置资产」 |

## 命令

```bash
npm ci
npx tsc --noEmit -p packages/engine
npx tsc --noEmit -p packages/cli
npm run typecheck -w am-desktop
npx vitest run --root packages/engine
npx vitest run --root packages/cli
npm run build -w @am/cli          # → packages/cli/dist/am.cjs
npm run build -w am-desktop       # → apps/desktop/out/
npm run test:e2e -w am-desktop    # Playwright 的 Electron 模式，会先构建命令行与客户端
npm run dist -w am-desktop        # 本机出一份 .app（apps/desktop/release/）
npm run generate -w @am/engine    # 由画幅表与模板重新生成 assets/presets/<画幅>/frame.md
```

CI（`.github/workflows/ci.yml`）跑类型检查、两包的 Vitest、构建、生成器幂等与 e2e；发布（`.github/workflows/release.yml`）在推 `v*` tag 时出 arm64 与 x64 两份 dmg。

## 内置资产

项目骨架分两棵源树，`packages/engine/src/assets/index.ts` 是读取它们的唯一入口：

| 源树 | 内容 |
|---|---|
| `assets/shared/` | 与画幅无关，所有项目共用（配置模板、中文正文字体、`templates/`、`.agents/skills/`） |
| `assets/presets/<画幅>/` | 只随画幅变化：`frame.md`（由生成器从画幅表写出） |

制作提示词不在任何一棵树里、不拷进项目：段落在 `assets/prompts/` 与 `assets/plugins/<id>/sections/`，开工时按项目记下的流程组合（见「Prompt 文件」）。

**每棵树的内部路径就是它在用户项目根下的目标路径**，`project.initialize`（`packages/engine/src/project/init.ts`）把选中的两棵树叠加拷贝，不做任何路径改写。所以 `assets/shared/assets/fonts/` 这层嵌套是刻意的——它对应项目里的 `assets/fonts/`。两棵树写入同一路径会直接报错，不静默覆盖：画幅树里不放与共用树同名的文件。

资产不打进 JS：开发时直接读仓库里的 `assets/`，打包时 `apps/desktop/package.json` 的 `extraResources` 把整棵 `assets/` 拷进应用资源目录，客户端与命令行的启动方经 `AM_ASSETS_DIR` 告诉引擎它在哪。遍历时有一条过滤规则：**目录里名字以 `.` 或 `_` 开头的条目一律跳过**（macOS 的 `.DS_Store` 就靠它挡住），只有 `explicitDotEntries` 里列出的 `assets/shared/.env.example` 与 `assets/shared/.agents` 两个入口例外。**新增一个需要随 `am init` 下发的点开头条目时，要把它加进 `explicitDotEntries`**——漏了不报错，只是那份内容静默到不了用户项目。`packages/engine/src/assets/index.test.ts` 的「skips dot and underscore entries except the explicit ones」与「includes the explicitly embedded dot entries」钉着这条规则；打包规则里的 `**/.*` 也要保留，否则点开头的文件在 .app 里根本不存在。

`am init` 不覆盖内容不同的已有文件：目标已存在且字节不同就整体失败并回滚，不做合并。

## 技能树

`assets/shared/.agents/skills/<name>/` 是随 `am init` 下发到用户项目根 `.agents/skills/` 的技能树。`scene.resolveSkill` 从镜头目录逐级向上找 `.agents/skills`，落到项目根就能被发现，用户无需另行安装。

`hyperframes`、`hyperframes-cli` 等官方技能不在这棵树里，但**落点相同**：`am init` 通过 `packages/engine/src/hyperframes` 把它们按固定版本装进同一个 `.agents/skills/`。这棵源树只放本仓库自带的技能。

官方技能不能直接跑 `npx hyperframes skills` 装——上游安装器只认 `homedir()`，没有任何选项能改落点（`skills update --dir` 的帮助原文写着 "scopes the prune, not the install"）。装在机器级会让项目之间互相覆盖：一台机器只有一份技能，项目 A 与项目 B 固定不同版本时谁后初始化谁说了算。

更要命的是上游安装器根本给不了可复现性：它 `git clone` 仓库默认分支取技能，没有指定 ref 的口子，技能内容随上游 `main` 漂移而版本号不变（实测 0.8.1 与 0.8.14 装出来逐字节相同）。所以 `hyperframes` 包不调用它，改为自己按 tag 浅克隆并校验 commit 与技能数量，见 `packages/engine/src/hyperframes/constants.ts` 里 `PinnedSkillsCommit` / `PinnedSkillsCount` 的注释；安装后写一份 `hyperframes-upstream.json` 记录 commit 与每个技能的内容摘要，见 `manifest.ts`。校验过的技能树按 commit 缓存在用户级目录（`defaultCacheDir`）；缓存只在调用方显式传 `Options.cacheDir` 时启用，测试里传临时 `HOME` 的用例因此仍能断言 HOME 一个字节都没动。缓存按技能数判可用。

**要联网的东西都是前置资源**（`packages/engine/src/prereq`）：HyperFrames 技能（`hyperframes.prepareSkills`）、HyperFrames CLI（`ensureCLI`）、内置插件登记的前置资源（`ctx.prereq`，例如卡点插件的节拍分析环境 `beat.ensureEnv`）、各整片风格来源的数据（`Source.prepare`，由登记来源的内置插件经 `ctx.prereq` 登记成 `styles:<来源>`；lemo-opuscar 含全部 demo、海报、core/assets 与 three.js 依赖）以及渲染用浏览器（`hyperframes.ensureBrowser`）、ffmpeg / ffprobe 与 uv（`toolinstall`）、项目选用的配音与对齐工具（`toolinstall.ensureTool`，按 `providers.ts` 里各家的 `install` 描述）只由 `am setup` 或客户端的安装页（`studio/setup.ts`）下载——两边跑同一份清单（`prereqs.items`）、同一份日志，都能看进度、加代理、断了重来。其余路径只检查：`am init` / 客户端新建用 `Options.cacheOnly` 从缓存拷技能，`am hyperframes` 与 `scene.run` 用 `requireCLI`，`beat_analyze` / `beat_doctor` 用 `beat.requireEnv`，`am film-style use` 与客户端用 `filmstyle.install` / `Source.check`，缺了一律抛 `prereq.MissingError`（文案统一指向 `am setup`）。`scene.run` 渲染前还要 `requireBrowser`（不然 HyperFrames 会在第一次渲染时自己下 390 MB 的 chrome-headless-shell）。**不要再在这些路径里加自动下载**：以前建项目、渲染、打开菜单时各自现下载，网络一差就卡在半路，用户看不到卡在哪，渲染途中卡住还白花一次模型调用。`am setup` 的界面（`packages/cli/src/setupview.ts`）每项一行、按显示宽度对齐，终端里原地重画，管道里每次状态变化打一行；git / npm 的原始输出一律写进 `<数据目录>/am/setup.log`（`packages/cli/src/setup.ts`），失败时屏幕只给错误、日志最后几行与日志路径——别再把子进程输出直接接到终端，混进进度行就乱了。`am setup --proxy` 用 `GIT_CONFIG_PARAMETERS` 只给 git 设代理：设成 `HTTPS_PROXY` 的话 npm 也走它，国内镜像经代理反而连不上（实测）。要从 GitHub release、Google 存储下载的（ffmpeg、uv、uv 的 Python、浏览器）经 `prereqs` 的 `withProxy` 设 `https_proxy`，curl 与 HyperFrames 都认；GitHub release 也可以设 `AM_GITHUB_MIRROR` 走镜像，文件都按钉死的 sha256 核对。

**开箱即用**：客户端用户的 Mac 上可以什么都没有（没有 Node、Python、Homebrew、Xcode 命令行工具），装好 .app、点一次安装页就能做片。约定如下，改动时别打破：

| 约定 | 原因 |
|---|---|
| 外部工具一律经 `packages/engine/src/toolpath` 找：随客户端下发的（`AM_BUNDLED_BIN`）→ `am setup` 装的（`<数据目录>/am/bin`，`AM_BIN_DIR`）→ PATH。`envutil.addExecutableLocation` 把 am 的 bin 目录加在子进程 PATH **末尾** | 编排工具按名字调 `mmx`、`edge-tts` 时能找到，又不盖过用户自己装的同名工具 |
| 要 Node 的地方（HyperFrames CLI、npm、npm 类配音工具）用 am 自己的运行时启动（`toolpath.nodeCommand`：客户端里是 Electron 带 `ELECTRON_RUN_AS_NODE=1`），**不往 PATH 前面塞 node**；只有 `npm install` 跑依赖的安装脚本时，经 `toolpath.withNode` 给那一个子进程补一个临时的 `node` | 塞进 PATH 的话编排工具这一轮里跑的 npx、用户自己的脚本都会换成 Electron。esbuild 的 postinstall 写的是 `node install.js` |
| 客户端自带 npm：`apps/desktop/scripts/vendor.mjs` 在打包前 `npm pack` 固定版本到 `vendor/npm`（不进版本库），`scripts/afterpack.cjs` 拷进 `.app/Contents/Resources/npm`，shim 经 `AM_NPM_CLI` 告诉 am。**不能走 extraResources** | electron-builder 复制 extraResources 时一律丢掉 node_modules（filter 写进去也不行，实测），npm 一运行就缺 graceful-fs |
| 渲染用浏览器借客户端自带的 Chromium：`apps/desktop/src/main/browser.ts` 是浏览器模式（入口 `entry.ts` 按 `AM_BROWSER_MODE` 分流），包装脚本 `userData/bin/am-browser`（`clishim.ts` 的 `browserScript`）经 `AM_BROWSER` → `HYPERFRAMES_BROWSER_PATH` 交给 HyperFrames。浏览器模式接管 puppeteer 的管道（fd 3/4），转给 Electron 自己的调试端口，只把 `Target.createTarget` / `closeTarget` 换成开、关隐藏窗口 | Electron 不支持 `Target.createTarget`（实测 Not supported），而 HyperFrames 每次都 `newPage()`。macOS 上 HyperFrames 用截图取帧，隐藏窗口截图与 headless-shell 逐字节相同（2D 画面；WebGL 因 Chromium 版本不同有几个像素差）。管道必须用 `net.Socket` 读写：fs 流阻塞读 fd 3，退出时互等，进程永远退不掉；内部 CDP 请求的 id 必须在 32 位以内，超出 Chromium 不回复（都实测过） |
| 没有 git 时技能改从 GitHub 逐个文件下载（`hyperframes/download.ts`），按 git blob 摘要核对；`toolpath.usableGit` 用 `xcode-select -p` 判断 `/usr/bin/git` 是不是占位程序 | 整仓 tarball 144 MB，技能只有几 MB；占位 git 一运行就弹窗要装命令行工具。lemo 风格库与 `am archive` 仍要 git，缺了提示 `xcode-select --install` |
| ffmpeg 不打进 .app，由 `am setup` 下载 eugeneware/ffmpeg-static 的静态构建（`toolinstall.FFmpegRelease`）；系统里已有就直接就绪 | HyperFrames 与 `concat` 都写死 libx264（GPL），LGPL 构建渲染不了；随应用发布 GPL + x264 要背许可与专利义务 |
| Python 类工具（edge-tts、tccli、mlx-audio、funasr）与没有合适 Python 时的节拍环境都用 uv，Python 装在 `<数据目录>/am/python`；uv 不读 pip.conf，`toolinstall.pipIndexURL` 把 pip.conf 的 `index-url` 转成 `UV_DEFAULT_INDEX`。节拍环境用 `uv venv --seed`，后面照旧 `python -m pip`（读 pip.conf） | 国内用户的镜像配在 pip.conf 里，不转过去 torch 会从境外直连 |
| 工具第一次运行才下的模型也是前置资源：对齐工具与配音工具的 `model`（`providers.ts` 的 `QwenForcedAligner`、`BreezeTTS2`，文件与 sha256 钉死）由 `toolinstall.ensureModel` 下到 `<数据目录>/am/models/`，先探 Hugging Face 通不通，不通就从魔搭下同名仓库；提示词用 `config_get({"key": "ALIGN_MODEL"})` / `TTS_MODEL` 拿本地目录 | huggingface.co 在国内常常连不上，hf-mirror 现在也 308 跳回 huggingface.co（2026-11 实测），不预先下好就是在对齐时现下载 1.27 GB |
| 测试的 testsupport 把 `AM_BROWSER` 指到假浏览器（`hftest.fakeBrowser`）、`AM_BIN_DIR` 指到空目录 | 开发机上 `~/.local/share/am/bin` 里真实的 ffmpeg、mmx 不能混进测试 |


HyperFrames **CLI** 与技能分开管理但同一个版本：`hyperframes.ensureCLI`（`packages/engine/src/hyperframes/cli.ts`）用 `npm install hyperframes@<PinnedVersion>` 装进用户级 `~/.local/share/am/hyperframes/cli-<版本>`（`CLIDirEnv` 可覆盖），在临时目录里装好、跑过 `--version` 自检、写完成标记后整体改名进位，失败重试 3 次；npm 沿用用户自己的 `~/.npmrc`（国内镜像、代理、鉴权）。`am init`（经 `projectinit.installSkills`）与 `scene.run`（启动渲染器之前）都会确保它在，所有调用一律写成 `am hyperframes <子命令>`（`hyperframes.CLICommand`），提示词、锁定文件规则与安全模式放行列表用的是同一个字符串。不再让渲染器 `npx --yes hyperframes@<版本>`：版本一升级，第一次渲染就要在途中现下载，网络一差渲染器空等二十多分钟、白花一次模型调用，只留下「没有产物」（实测）。`config.childEnvironment` 显式传 `AM_HYPERFRAMES_CLI_DIR`，理由同风格库目录；`scene.run` 还把当前 `am` 放进渲染器的 `PATH`。命令行测试的 `packages/cli/src/testutil.ts` 与 Studio 后端测试的 `packages/engine/src/studio/testsupport.ts` 用 `hyperframes/hftest` 的 `fakeCLI` 造一份假的已装 CLI。

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
| `SourceUpstream` | `am init` 按固定版本从上游装进项目 | **禁止**——那会留一份永远追不上上游的陈旧副本 |

两条门禁互为反面，都在 `packages/engine/src/project/skilltree.scene.test.ts`：「every registered skill is embedded」查前者在不在内置资产树，「upstream skills are not vendored into the embedded tree」查后者在不在。把上游技能拷进 `assets/` 能让第一条变绿，但会被第二条抓住。

新增一个**内置**技能要动的地方：

| 位置 | 作用 |
|---|---|
| `assets/shared/.agents/skills/<name>/SKILL.md` | 技能本体，`SKILL.md` 是必需文件 |
| `packages/engine/src/assets/index.ts` | 已含 `assets/shared/.agents`，新技能自动覆盖（名字别以 `.` 或 `_` 开头） |
| 描述符（`source: SourceEmbedded`）与 `<name>Prompt` 函数 | 属于某个功能的技能由那个内置插件在 `apply` 里 `ctx.skill(...)` 登记（例如 `plugins/cast/skill.ts` 的 character-rig），项目关掉插件时渲染器拿不到它、提示词里没有那一段；宿主自己的（scene-kit）追加在 `packages/engine/src/scene/skills.ts` 的 `registeredSkills`。提示词片段挂在描述符的 `promptSection` 上；不写 `promptSection` 的技能只解析目录，由别处按需引用（song-explainer 由 song 块引用） |
| `assets/shared/templates/project-rules.md` | 下发规则要点名它，有门禁强制（「builtin skills are documented in project rules」） |

全部技能（宿主的加上内置插件登记的）是 `scene.allSkills()`，下面的技能树门禁按它查，插件登记的技能一条都不能松；一个镜头实际用的是 `scene.sceneSkills(镜头目录)`（去掉项目关掉的插件的）。

新增一个**上游**技能只要在 `registeredSkills` 加一条 `source: SourceUpstream` 的描述符加提示词片段——它已经被 `am init` 装进项目了，注册只是让 `am` 把绝对路径和用法边界写进渲染提示词。

注册上游技能时要收窄范围，上游技能的职责范围通常比单镜头渲染大得多：

- `hyperframes` 是入口技能，0.8.185 起上游把 `hyperframes-animation`、`hyperframes-core`、`hyperframes-creative` 并进了它，组合契约（`SKILL.md` 的 Contract、`references/format.md`）与动效手法（`references/motion.md`）都只在这里。它的本职却是整片制作：故事线三选一、`SPEC.md`、分镜、配乐音效、预览审批、桌面应用交接与 `REVIEW.md`。分镜由上层决定并已写进 `scene.json`，不收窄的话渲染器会产出计划文件、给镜头配乐（产物必须无音轨），还会停下来等人审批。另有两处与本项目正面冲突，要点名覆盖：`references/look.md` 让渲染器把项目根的 `frame.md` 当作配色与字体规范，而本项目的 `frame.md` 不是视觉命令；`references/format.md` 允许 `local()` 引用本机字体，换一台机器渲染结果就不同。
- `hyperframes-cli` 覆盖 `cloud` / `cloudrun` / `lambda` / `publish` 远端渲染路径，`skills` / `upgrade` 这类改动已装技能的命令，以及 `preview` / `open` / `catch-up` / `history` / `feedback` / `usage` 这类交互、桌面应用与遥测命令。第一类绕开本机确定性前提，第二类会顶掉固定版本、影响同项目其他镜头，第三类在无头渲染里要么卡住等人，要么往外发数据。`timeline` 只放行只读的 `--json`，它的改写子命令与「时长由 `scene.json` 决定」冲突。CLI 的写法本身也由这一段教：`scene.hyperFramesCommand()` 返回 `hyperframes.CLICommand`（`am hyperframes`），同时用于提示词和 `rendererAccess` 的放行列表，并要求每条命令单独执行、不拼 `cd …;` / `&&`。以前只有放行列表里有前缀，全靠编排工具写的渲染器锁定文件转告；锁定文件一缺，渲染器写成不带版本的 `npx hyperframes`，整场 lint、check、render 全被拦下，没有产物（实测）。

这些禁令只存在于我们自己写的提示词片段里，上游不会替我们守，所以 `packages/engine/src/scene/skills.test.ts` 有对应的门禁盯着。`hyperframes` 的 `requiredFiles` 包含提示词点名的 `references/*.md`：用 0.8.14 初始化的旧项目里入口技能只有一页路由说明，按缺失处理并在渲染前告警，比把渲染器指向不存在的文件强。

`packages/engine/src/project/skilltree.test.ts` 与 `skilltree.scene.test.ts` 守着这条链：注册了但没随客户端下发、下发了但镜头目录找不到、技能目录缺 `SKILL.md`，都会失败。**这些失败必须修，不能豁免**——`resolveSkill` 按设计在找不到技能时不报错只降级，没有这道门就会一路静默到成片质量变差才被发现。

fork 自外部项目的技能要带 `LICENSE` 和 `ATTRIBUTION.md`，后者记清上游 commit、保留了什么、丢了什么、改了哪几处，供日后同步上游时重做。`text-to-lottie` 的 `references/` 还有一道门禁止上游播放器契约（`Skottie`、`public/projects` 等）回流（`skilltree.test.ts` 的「forked skill carries no upstream player contract」）。

## 画幅预设

画幅在 `am init` / 客户端新建时选一次（`--canvas`），之后不再改。它决定画布、帧率与安全区；配色、字体、版式、材质与动效不由项目文件规定，由各镜头自主决定或由「整片风格」统一。旧版的内置风格体系（风格表、风格说明书、示例图、自定义风格草稿、`--style` / `--style-brief`、`am validate style`、`am style fonts` / `add-font`、字体池）已整套删除。

项目根的 `frame.md` 是画幅的唯一落点，只有四块技术信息：`canvas`（宽高、帧率、朝向）、`safe_area`（五个安全区的像素内缩）、`subtitles`（烧录字幕的缺省样式，`scene-kit` 的 `SceneKit.captions` 读它）与 `audio`（混音与成片响度目标，`am review` 读 `final_*` 三项）。正文说明这些是技术信息、不是视觉命令。

镜头的画幅一律经 `scene.sceneCanvas` 取（`scene/scene.ts` 的 `frameSource`）：就近找 `frame.md`——镜头目录，再逐级向上到项目根（有 `article-to-motion.conf` 的那一层），找不到项目根时只看镜头目录。**哪儿都没有就报错，不回退任何默认画幅**：静默落到某个默认值的话，提示词、`am-scene.js` 与产物校验三处一起错，选了 9:16 的项目整片出成 3:4 还照样「通过」（2026-11 实测）。`scene.json` 没有画幅字段（旧的 `style_guide` 已删，写了会报未知字段）。`scene.test.ts` 的「reads the project frame.md」「fails without any frame.md」钉着。记忆的考试重放时，`freezeInput` 把镜头当时就近读到的 `frame.md` 一起冻结进输入，重放按当时的画幅。

`assets/presets/<画幅>/frame.md` **由 `npm run generate -w @am/engine` 生成，不要手改**。真相源是 `packages/engine/src/preset/table.ts` 的画幅表与 `packages/engine/src/preset/gen/templates/frame.md` 模板；生成器（`preset/gen/gen.ts`）整块替换 `canvas` 与 `safe_area`，再填占位符，不做 YAML 重序列化。安全区在画幅表里用 anchor 声明（贴顶 / 贴底 / 上下固定），构建期推导成绝对像素——anchor 不进项目文件，渲染工具读到的始终是现成像素值。`project.initialize` 把共用树与选中画幅的树叠加拷贝，`frame.md` 逐字节来自这里（`projectinit/index.test.ts` 的「writes the canvas frame.md and nothing of the old styles」）。

改完画幅表或模板后必须重跑生成器并提交产物，CI 的 `generated-assets` job 会校验二者一致（`gen.test.ts` 的「matches the committed assets byte-for-byte」在本地也能先拦下）。

模板里随画幅变化的东西一律写占位符，不写死：`{{SUBTITLE_MAX_WIDTH_PX}}` 等像素由生成器从安全区推导（可带整数偏移，如 `{{CONTENT_LEFT_PX+8}}`）；`{{ORIENTATION}}`、`{{PLATFORM_UI}}`、`{{AVOIDANCE_ZONES}}` 取自画幅表的 `platform`；`{{CANVAS}}` 是全角乘号写法的画幅。未知占位符会让生成器直接报错。同一个 `substituteCanvas` 也给运行期组合的制作提示词换画幅占位符。

新增画幅要动的地方：`packages/engine/src/preset/table.ts` 加一条（安全区、`platform` 平台措辞，必要时加 `layoutNotes` 构图要点，它接在 `frame.md` 正文末尾），跑生成器并提交 `assets/presets/<新画幅>/`。`scene.buildPrompt` 与产物校验只读 `frame.md` 的数字，不持有画幅常量。`assets/trees.test.ts` 查 `assets/presets/` 的目录与画幅表一一对应。

SVG 转 PNG（角色包预览，`packages/engine/src/svgimage`）必须走 `rsvg-convert`，**不能用 ImageMagick**：多数 ImageMagick 构建自带内置 XML SVG 渲染器，会抢在 rsvg 委托前接管 `.svg`，渲染不出文字也画不对背景填充，却返回退出码 0。

## 整片风格

整片风格分两层：`packages/engine/src/filmstyle` 是**与来源无关的通用部分**（`Source` 接口、来源表、风格目录查找、装进项目的契约、目录式风格库 `DirectorySource`），具体风格来源由内置插件在 `apply` 里 `ctx.filmStyleSource(...)` 登记，`filmstyle.sources()` 从插件登记表取（`plugin.pluginFilmStyleSources`）再并上当前项目的第三方来源。目前只有内置插件 `lemo-styles`（「LemoLab 风格库」，`packages/engine/src/plugins/lemo-styles`：来源 lemo-opuscar，LemoLab，MIT + demo CC BY 4.0）。`filmstyle` 与内核（prereqs、config、studio、cli）不 import 它。am 本身不锁定视觉；整片风格是可选的第三种技能来源，与 `SourceEmbedded` / `SourceUpstream` 并列但**不进 `registeredSkills`**：那张表要求解析不到时退回按名字引用，而整片风格解析不到的意思是「本片没有整片风格」。`scene.resolveFilmStyle` 只找项目级（不找家目录），只认契约，解析到就并进 `resolveAllSkills` 的结果，指纹与安全模式读取因此自动覆盖；`buildPrompt` 据此把「视觉自由度」段换成 `filmStyleSection`。

| 约定 | 原因 |
|---|---|
| 项目里的契约：`.agents/skills/am-film-style/` 下必须有 `STYLE.md`（不变量）与 `SKILL.md`（用法、技法参考在哪、来源特有的注意事项），`am-film-style.json` 记来源、风格、版本与内容摘要；其余文件由来源决定。`filmstyle.install`（`install.ts`）校验契约、负责换位与新旧目录，来源只实现 `fill` | 镜头提示词、制作提示词与客户端只依赖契约，接新来源不用改它们。目录名带 `am-` 前缀，免得撞上用户自己装的技能 |
| **镜头提示词与制作提示词不点名任何来源**：lemo 的页面契约、demo、`core/fonts`、真实素材类风格的先后顺序都写在 lemo 自己的 `SKILL.md` 模板里；`gen.test.ts` 的「carries the film style without naming a source」拦 `lemo`、`DEMO.md`、`core/fonts` 回流到制作提示词 | 来源特有的话写进通用提示词，下一个来源就得到一份错的说明 |
| 风格标识是「来源/目录名」（`styleKey`）；`filmstyle.lookup` 也认唯一的目录名、中文名、英文名，多个来源重名时要求写全 | 来源之间目录名会撞 |
| 各来源的数据放在 `filmstyle.rootDir`（`~/.local/share/am/film-styles`，`AM_FILM_STYLES_DIR` 覆盖）下以来源 ID 分目录；`childEnvironment` 显式传根目录，来源自己的覆盖变量（lemo 的 `AM_LEMO_OPUSCAR_LIBRARY`）由插件经 `ctx.childEnv` 登记、随 `pluginEnv` 传 | 默认目录由 `XDG_DATA_HOME` 推出而它不在白名单，子进程会算出另一个目录 |
| 来源数据是前置资源：只由 `am setup` 经 `Source.prepare` 下载（每个来源一项 `styles:<来源>`，插件用 `prereqs.filmStyleSourceItem(来源)` 造这一项再 `ctx.prereq` 登记，带 `later` 进安装页「以后可能用到」的「整片风格库」卡片），其余路径用 `Source.check` / `fill` 只读，缺了抛 `prereq.MissingError`。编排工具的可写范围里**没有**来源数据 | 见「技能树」一节前置资源的理由 |
| 新增来源：写一个内置插件（`plugins/<id>/` 加 `assets/plugins/<id>/am-station.json`、在 `plugins/index.ts` 排队），在 `apply` 里 `ctx.filmStyleSource(来源)`，要下载数据的另登记 `ctx.prereq`、有目录覆盖变量的另登记 `ctx.childEnv`；随插件下发的现成风格目录直接用 `new filmstyle.DirectorySource(...)`。来源 id 不能以 `x-` 开头（那是第三方的）。用到来源表的地方要导入 `plugin` 包（内置插件靠它登记）。`filmstyle/filmstyle.test.ts` 的假来源证明通用部分不依赖任何具体来源，`filmstyle/builtin.test.ts` 用测试里登记的假插件证明新增来源不用改 `filmstyle/`、`prereqs/`、`config/`、`studio/` | 与别的内置功能同一条登记路；以前来源在模块加载时 `register`、集中在一个 sources 模块 import，是第二套登记 |
| 一个项目可以装几种风格：默认风格在 `.agents/skills/am-film-style/`（`am film-style use`），个别镜头用的额外风格在 `.agents/am-film-styles/<来源>/<目录名>/`（`am film-style add`，`filmstyle.extraDir`），契约相同。**额外风格不能放进 `.agents/skills`** | 技能目录在指纹里是整棵算一份摘要（`resolveAllSkills` 给注册技能的值就是 `.agents/skills`），放进去的话给项目添一种风格，所有镜头都变 Stale |
| 镜头 `scene.json` 的 `film_style`：空是默认风格，「来源/目录名」是点名的风格，`none` 是不用整片风格。不写的镜头仍记在 `filmstyle.SkillName` 下、提示词仍是 `filmStyleSection`，与只有一种风格时逐字相同；点名的记在 `FilmStyleOwnKey`、提示词换成 `sceneFilmStyleSection`。点名了却没装时 `resolveSceneFilmStyle` 报错，不降级 | 升级 am 不让老镜头变 Stale；降级成「不用风格」会一路静默到成片 |
| 风格交界：相邻镜头实际用的风格不同时，分镜计划的 `handoff` 必须写 `style_shift`（`scene.StyleShifts`：`morph` / `window` / `sweep` / `match_cut`，每种只配几种 `device`），由 `am scene cues` 的 `verifyStyleBoundaries` 按项目当前的默认风格判定。cues 把它连同对方镜头 `film_style` 的**原值**（`peer_film_style`）写进两侧的 `timing.enter` / `exit`；`resolveAllSkills` 据此把对方风格解析进 `FilmStyleEnterKey` / `FilmStyleExitKey`，`styleShiftSection` 告诉每一侧手法、自己负责哪一段与对方的 STYLE.md 在哪 | 两侧分别渲染、互相看不到，画法要在画面里自然地换过去，只能靠同一份约定指定谁来换、换的那一侧能读到对方的风格。记原值而不是解析结果，是为了换默认风格后两侧跟着变、不用重跑 cues。改手法表要同步改制作提示词第五阶段「风格交界」的表格，`gen.test.ts` 的「carries style boundaries」逐行比对 |
| 去掉或换掉一种风格前看 `filmstyle.scenesNaming`：还有镜头点名它时 `am film-style remove` 拒绝（`--force` 才删），`use --replace` 把旧的默认风格留作额外风格（`keepReplaced`）。客户端里镜头的「换风格」不改文件，只把要求写进输入框交给编排工具 | 删了被点名的风格，那些镜头渲染时找不到它；哪个镜头用哪种风格要改分镜计划，是编排工具的事 |

lemo 来源（内置插件 `lemo-styles`，`packages/engine/src/plugins/lemo-styles`）自己的约定：

| 约定 | 原因 |
|---|---|
| `PinnedCommit`（`lemo.ts`）固定 commit，`catalog.json` 由 `gen/main.ts` 的 `generateCatalog(<检出目录>)` 从同一 commit 生成（生成器校验 HEAD，只在开发时调用），`PinnedStyleCount` 守条数 | STYLE.md 与 demo 引擎直接决定画面；跟随 main 的话同一项目两次安装得到不同风格 |
| 风格库在 `<风格根目录>/lemo-opuscar/<commit>`，`AM_LEMO_OPUSCAR_LIBRARY` 指向用户自己的检出；am 克隆的带 `.am-library` 标记，只有它的稀疏规则可以由 am 改 | 子进程总是经环境变量拿到风格库目录，不能用「是不是默认目录」判断归属 |
| 只接画面，不接风格库的 Python 配乐工具（`core/audio/`） | 要一套 Python 环境加约 1.4 GB 采样库，国内网络装不上时整条链路卡住；配乐仍走第九阶段的授权素材，Sound palette 只作参考 |
| git 子进程带 `GIT_HTTP_LOW_SPEED_LIMIT/TIME`（1 KB/s 持续 60 秒即放弃） | 连接被掐断时 `--filter=blob:none` 的按需取文件不报错只挂着，实测卡过半小时 |
| 下载可续传：克隆在固定的 `<目录>.partial` 里进行，失败保留；`prepareLibrary`（`prepare.ts`）先按 `libraryStages`（`library.ts`）取基础部分，再取海报、按 `demoBatch` 分批取 demo、取 core/assets，每段重试 5 次，最后 `npm ci` 装 three.js，全部完成写 `.git/am-complete` | 按需取文件一批里断一次整批白下；分段后已取回的留在本地，国内网络下重跑几次总能下完 |
| 技能目录不带 `demo/stills`、渲染产物与音频，不带 `core/render`；three.js 只带 demo 与 `core/` 实际 import 到的模块（`threeClosure`），`core/assets` 只带源码里出现过名字的模型与贴图（`referencedAssets`，按名字认是因为 demo 常拼接路径），两者都在 `select.ts` | 整棵带的话一种 three.js 风格进项目 34 MB，挑过之后几 MB；多余的文件还会让指纹随无关内容变化 |
| 风格库里的文件硬链接进项目，跨磁盘时退回复制；用户自己的检出只复制、不改权限。**不设只读** | 内容钉在 commit 上不会变，硬链接不占第二份磁盘。只读试过：渲染器 cp 出的副本继承只读，安全模式又不放行 chmod，真实渲染在这上面绕了好几轮 |
| `SKILL.md` 由 `skill.md.tmpl` 生成：给制作的说明（先 treatment 再看 demo、字体从 Google Fonts 取、`core/fonts` 中文只有约 200 字）与渲染规则（`window.render(t)` 怎么换成 HyperFrames 的 `hf-seek`、`/core/...` 路径为何拷进镜头目录后不用改、Sound palette 与胶片颗粒对镜头无效） | 上游写给它自己的渲染器，这些冲突上游不会替我们守 |

制作提示词「整片风格」一节由「carries the film style without naming a source」钉着。升级 `PinnedCommit` 时对比新旧 `core/lib.js` 与 `core/README.md` 的页面契约。

## Prompt 文件

制作提示词不是项目里的文件，也不是生成器的产物：它只有一条路——开工时按项目锁文件里记下的流程，把 `assets/prompts/<站>/<段>.md`（宿主的段落）与 `assets/plugins/<id>/sections/`（内置插件登记的段落，例如发布、歌曲讲解）组合起来（`project.runPrompt` → `flow.composeFlowPrompt`），客户端的「开始制作」把它直接喂给编排工具。改提示词就改段落；要看某个项目现在组合出的全文，用 cli-only 的 `prompt_show`（`am prompt show`）。`runPrompt` 的 `override`（显式指定一份提示词文件）原样读那份文件，不再组合。

对某个流程不成立的话不写成「如果是卡点则…」：把段落拆细，或给它一版按流程挑（插件流程自己的那一版放在插件名下，例如宿主的 `host/head`、`render/stage` 与卡点插件的 `beat-common/head`、`beat-common/render`），由流程的段落顺序决定用哪一版。`project/flowprompts.test.ts` 对每个内置流程的组合结果做内容门禁（哪条断言对哪些流程成立写在测试名里），并用 `testdata/flow-prompts.json` 钉住新建口播、卡点、歌曲项目的全文摘要与阶段标题序列（`AM_UPDATE_GOLDEN=1` 重写）；`boundary.test.ts` 的「prompts use installed CLI and do not expose executor identity」对每个流程 × 画幅 × 发布开关的组合结果检查。

### 流程与站

制作流程拆成「站」（`packages/engine/src/flow`）：一个站带一段或几段制作提示词（`assets/prompts/<站>/<段>.md`）、制作路线页上的站点（含审核关卡与绑定文件）和它会写的文件（`produces`）；流程（片型）是站的有序组合，既定路线（`Flow.stations`）也定提示词的段落顺序（`Flow.prompt`），写在同一个声明里。宿主只有口播（`speech`）；卡点（`beat`）与歌曲讲解（`song`）由各自的内置插件在 `apply` 里登记。项目用哪个流程：锁文件选了第三方流程 > 新建时记下的流程（`flow.detectFlow` / `flow.recordedFlow`）；没有记录的目录直接抛 `flow.MissingFlowRecordError`，说明锁文件里缺哪一段，不按 `beat.yaml`、`song.yaml` 这类功能自己的配置文件推断。设计稿是 `docs/superpowers/specs/2026-11-11-流程插件-design.md`（本地，不进公开树），以后第三方站也挂在这里。

| 约定 | 原因 |
|---|---|
| 段落正文里不写「第六阶段」，写 `{{STAGE:render}}`（只要数字写 `{{STAGE_N:render}}`），由 `flow.composePrompt` 按阶段在提示词里的先后编号；引用了没有的阶段直接报错。`flow.test.ts` 的「leaves no hard-coded stage numbers in the sections」拦着写死的编号 | 换了站或顺序，交叉引用跟着变，不会指错阶段 |
| 每个流程拼自己的提示词（`flow.flowPrompt(id)`：流程的顺序，插件段落按 `after` 插进去，`append` 段接在最后），`{{STAGE:…}}` 按各流程自己的阶段先后编号；流程可以声明 `stage_aliases`（卡点把两边共用段落里的 `sound` 指到自己的 `beat-sound`）。卡点的顺序（卡点插件的 `beatPrompt`）没有口播稿、TTS、对齐三个阶段，开自己的阶段「故事、音乐与节拍」「按小节拆分镜头」「音乐授权和音效」「音乐与音效的混合」；多角色对话的作业规程由多角色插件登记成站 `cast-rules` 的两段（口播稿阶段末尾一句指向附录、口播流程文末「附：多角色叙事作业规程」），关掉多角色对话时不组合。流程自己的配置由登记流程的插件经 `Flow.check(root)` 在组合前核对（歌曲讲解读一遍 `song.yaml`），`project/runprompt.ts` 不 import 任何功能包。内置流程引用了自己没有的阶段直接报错（`flowprompts.test.ts` 的「references only stages of its own flow」） | 每个流程的提示词只说对这个流程成立的话 |
| 流程记录：新建项目（`projectinit.create`，am init 与客户端共用）在 `article-to-motion.flow.json` 写 `production: {id, canvas}`（`flow.FlowRecord`）；`song_init` 给已有项目补歌曲资产时把记录换成 `song`。`runPrompt` 按它组合（`flow.composeFlowPrompt`）：关掉的内置插件的站不参与（编号连续），第三方站的 `inserts` 插在那个阶段末尾、`prompt` 接在最后，第三方流程（`x:<站>`）是公共约定（口播流程第一个阶段之前的几段：`host/head`、`host/work`、`host/renderer`）加 `stations` 里内置站的段落加本站 `flow.prompt`，内置段落引用了它没有的阶段时写成「<标题>」那一步（只有第三方流程有这条退路） | 提示词改了，项目下次开工就用上；没有按标记删段、按标题正则插入这类运行期修补 |
| 没有流程记录的目录：`runPrompt`、`/api/progress`（409 `no_flow_record`）照实报错；`/api/state` 不给 `flow` 与 `step`，改给 `flow_error`，路线页显示这句话 | 客户端还没发布，不为旧版建的项目留兼容路径 |
| 讲解形式（`am init --delivery`）就是流程：可选值来自有段落顺序的内置流程与内置插件流程（`projectinit.deliveryFlows`）；新建时写哪个标记文件（`Flow.marker`）、与什么互斥（`Flow.excludes`：插件、别的片型）由流程声明，`projectinit.validate` 不写死片型 | 新片型不用改 projectinit |
| 改过的文件归哪一站由各站 `produces` 决定（`flow.stationOfPath`）：整条路径 > 前缀加文件名 > 只有前缀，同级比前缀长短；只算当前流程里的站 | 不再维护一张按顺序匹配的手写表，新站声明自己的文件即可 |
| 宿主站点做没做的判断函数留在 `studio/progress.ts` 的 `judges`，内置插件的随站登记（`PluginStation.judges`），键都是「站:站点」；普通站漏了判断函数，`stationDefs` 直接报错（`progress.test.ts` 的「judges every station of every builtin flow」） | 引擎的 `flow` 只有声明，不依赖 `studio`；口播与卡点的「拆分镜头」都叫 `plan`，判断不同 |
| 新增一个宿主自己的站：在 `flow/builtin.ts` 加站与段落、在 `assets/prompts/<站>/` 写段落、在用到它的流程的 `prompt`（`speechPrompt`，插件流程在插件里）里排位置、在 `judges` 里加判断。可选功能不走这条路，写成内置插件在 `apply` 里登记（见下面「内置插件」） | `flow.test.ts` 的「has a template for every section and no orphan templates」查模板与声明一一对应、每一段都进了某个内置流程 |
| `flow/builtin.ts` 的 `builtinStations` / `builtinFlows` / `stageTitles` / `speechPrompt` 只有宿主自己的部分（另导出 `planRules`、`tailStations` 给卡点插件复用）；要「全部」时用 `flow/registered.ts` 的 `allStations` / `allFlows` / `allStageTitles` / `flowPrompt`，它们把内置插件登记的站、段落与流程并进来。路线、关卡、文件归站、清单校验、阶段补充都经它们 | 插件的站不写进宿主的表，新增内置功能不用改 `flow/builtin.ts` |

第三方站（`flow/` 下按职责分文件：`manifest.ts` 清单类型与字段分级、`parse.ts` 解析、`lock.ts` 锁文件、`fetch.ts` 来源与下载、`load.ts` 读出项目的站、`update.ts` 升级、`builtinplugins.ts` 内置插件、`promptparts.ts` 第三方站的阶段补充与说明、`skills.ts` 渲染技能；`external.ts` 只做转出，执行在 `run.ts`）是用户自己加的站，am 不分发、不维护，第一个用例是自动发布。写给插件作者的说明是 `docs/plugin-authoring.md`：

| 约定 | 原因 |
|---|---|
| 一个站是一个目录加 `am-station.json`，只能声明：提示词文本、站点（`outputs` / `stale_after` / `gate_files` / `state` / `guide` 声明式判断）、`produces`、操作。清单严格校验：路径只能是项目里的相对路径，不能声明 `production/studio/`、`.agents/`、`.env` 这类 am 自己的文件，id 不能与内置站重名 | 第三方代码不进 am 的进程，能做什么全写在清单里，添加时给用户看得见 |
| 清单有格式版本 `manifest_version`（缺省 1，`flow.ManifestVersion`）与可选的 `requires.am`（最低 am 版本，semver）：格式更新时先于「不认识的字段」报「要更新的 ArticleToMotion」；比较用的版本取 `version.compatVersion()`：客户端主进程启动时用 `app.getVersion()` 设的宿主版本（`setHostVersion`），没有再退回工具版本（`setToolVersion`，与 `am --version`、渲染指纹同源）；不是 x.y.z（本地构建 dev）时不查最低版本。版本存取在不依赖任何功能包的 `packages/engine/src/version`，`scene/record.ts` 只转出，flow 不 import scene。**客户端不调 `setToolVersion`** | 趁还没有第三方用户把兼容面收住；旧 am 读到新清单要说清楚该做什么，而不是列一串不认识的字段。客户端是主要交付物，进程内后端也得查；工具版本进渲染指纹，客户端改它会让进程内算的指纹变 |
| 顶层字段分「稳定 / 实验性」两档（内置插件与第三方站用同一份字段，没有内置专用的），唯一来源是 `flow.ManifestFields`：解析器的已知字段从它来，`experimentalFields` 按它报告一份清单用到了哪些实验性字段（设置页「详情与设置」与 `station_add` 输出照实写「以后的版本可能调整」，内置插件不标）。`docs/plugin-authoring.md` 的「顶层字段」表与它一一对应，`manifest.test.ts` 的「lists exactly the top-level fields the parser accepts」核对；加字段要同时改表、改文档 | 稳定字段承诺不改意思；实验性的先让作者与用户知道可能会变 |
| 站目录摘要（`treeDigest`，`digest.ts`）按目录缓存在进程里：每次先 stat 整棵树（路径、大小、mtime、ctime、inode），概要变了才重读重算 | `loadProjectStations` 到处都在调，每次全量读 git 来源的站太浪费；缓存只省读文件，不放过任何改动（`manifest.test.ts` 的「still refuses a station whose content changed」） |
| `station_update`（scopes 只有 cli，设置页第三方站的「更新」按钮走 `POST /api/stations/{id}/update`）按锁文件记的来源重新取，报版本、commit、新申请的权限与新用到的实验性字段，写回锁文件；`link:` 来源直接说明不需要更新 | 升级要让用户看见插件多要了什么 |
| 项目里的 `article-to-motion.flow.json`（`flow.LockFile`）记加了哪些站；git 来源按 ref 克隆、记 commit 与内容摘要，存进 `<数据目录>/am/stations/<id>/<commit>`（`AM_STATIONS_DIR` 覆盖，`childEnvironment` 在会算出另一个目录时显式传），摘要对不上就不用；`link:` 是开发用的本机目录，不核对。不接 npm | 同一项目两次制作要得到同样的说明；npm 包装一次就执行了 install 脚本 |
| 提示词：`runPrompt` 把各站说明接在最后（`flow.extraPrompt`），每站一节，声明「与上面的约定冲突时以上面为准」；加了却读不出来的站让「开始制作」直接报错 | 用户加了它，悄悄少一步更糟 |
| 操作在子进程里跑（`flow.runStationOp`）：工作目录是项目根，stdin 一行 JSON，最后一行 `am-result <JSON>` 是结构化结果；环境只给 PATH、HOME、语言、代理、证书与 `AM_STATION_DATA`（插件自己的数据目录，凭据放这里），项目 `.env` 一概不传 | 发布插件要读成片，但不能拿到配音、模型服务的凭据 |
| 操作**不是沙箱**：它是用户电脑上的普通程序，能读写用户的文件、能联网（HOME 照传，很多工具离了它不工作）。`runStationOp` 前后各扫一遍项目树（`flow/scope.ts`，只 stat；跳过的目录与轮次快照同一张表 `fsutil.ProjectSkippedDirs`，但项目根的 `.agents` 照扫，`production/studio` 里客户端自己边跑边写的状态不算），变了的文件不在 `produces` / 站点 `outputs` 里的算越界：写进操作输出末尾、结果的 `out_of_scope`（最多 20 条加 `out_of_scope_more`）；写到 am 自己的文件（`ReservedPrefixes`，与清单校验的 `reservedPrefixes` 同一份）时操作按失败处理，照实说文件已经写了、只能回退那一轮或用 git 恢复。客户端在调用点外再扫一遍拿结构化列表（执行进程的协议只回传插件的 data），记在任务的 `warning`、`last_run` 上，钩子与定时触发的另在最近的对话里发 notice。添加时（`station_add` 的输出、设置页的添加确认与详情）用 `flow.OpsTrustNotice` 这句话说清，页面的权限另列 | 设计稿承诺过越界写入要标出来；清单里的权限只管得住页面，混在一起写会让用户以为操作也受限。不做文件系统沙箱 |
| 运行时：`command` 第一个元素写 `{node}` 用 am 自己的运行时（`toolpath.nodeCommand`，客户端里是 Electron 带 `ELECTRON_RUN_AS_NODE=1`），写 `{python}` 用 am setup 经 uv 装进 `<数据目录>/am/python` 的 Python（`flow.managedPython`，没有就抛 `prereq.MissingError`，不现下载）；后面第一个参数是脚本，相对路径按站目录解析。裸写 `node` / `python3` 照旧按 PATH 找，找不到时报错提示改用占位符。站目录在 `"type": "module"` 的包里时脚本要用 `.cjs` 才能 `require`（假发布站就是这样） | 客户端用户的电脑上可以没有 Node 与 Python（见「开箱即用」） |
| `trigger: agent` 的操作由工具服务登记成 `x_<站>_<操作>` 工具（`toolsmcp.externalOps`，执行时落到 `station_run`）；`trigger: user` 的只在界面上出按钮（发布页的 `StationActions`，`POST /api/stations/{id}/ops/{操作}`）。`station_add` / `station_remove` / `station_list` / `station_run` / `station_update` 的 scopes 只有 cli | 发出去、上传这类对外且不能撤回的动作只能由用户点；加不加第三方插件是用户的决定，编排工具不能自己装 |
| 插件自己的页面（清单 `pages`：`entry` 是站目录里的 HTML，`reads` 是页面能读的项目文件）在画面面板里以 `sandbox="allow-scripts"` 的 iframe 打开（`Stations.tsx` 的 `StationPage`，页面 id `x:<站>:<页面>`，顶栏「更多页面」与 `studio_show` 都认）。`/station-ui/<站>/…` 只给 entry 所在目录，响应带 `pageCSP`：`default-src 'none'`、`connect-src 'none'`，脚本、样式、图片只能来自本站目录与 `/station-ui/_sdk.js`；后端另拒 `Origin: null` 的 `/api` 请求 | 页面是第三方代码，又和界面同在 `am://app/` 下：不隔离的话它能调任何接口、读项目文件。不许连网是为了宿主交给它的数据传不出去 |
| 页面要的东西都经 `postMessage` 请宿主转交（`window.am`：`info`、`read`、`run`、`ask`、`onRefresh`）：`read` 只给 `reads`、`produces` 与站点 `outputs` 里的文件（`flow.pageMayRead`，后端 `/api/stations/{id}/read` 再查一遍），图片给 data URL；`run` 先在页面上方弹确认条，用户点「执行」才跑；`ask` 只填进对话输入框，不发送 | 页面里的按钮可以被脚本自己点，不算用户同意；要对外的动作必须是用户在宿主界面上点的 |
| 页面桥的时序（`StationFrame` 与 `studio/stations.ts` 的 `pageSDK`）：宿主用 `useLayoutEffect` 挂监听，与 iframe 在同一次提交里出现；执行类请求一弹确认条先回 `{ack: true}`，SDK 对每个请求计时 `pageHostTimeoutMs`（15 秒），既没回答也没 ack 就 reject 一句「没有回应」（`pagesdk.test.ts`）。确认条绝对定位盖在 iframe 上、越界提醒排在 iframe 下面，都不挪动 iframe | 偶发的「页面请求没回应」查下来不是消息丢了，是 iframe 刚挂上或刚被确认条推下去时，点击按合成器里还没更新的命中数据落在宿主的 iframe 元素上、页面根本没收到（后台窗口里更明显）。e2e 里点插件页面的按钮一律用 `stations.spec.mjs` 的 `clickInPage`，按宿主的反应重点 |
| 站点的声明式状态（`nodes[].state`，实验性，读文件在 `flow/state.ts`，接路线在 `studio/progress.ts` 的 `declaredJudge`）：读一个项目文件（只能是本站 `produces` / `outputs` / 页面 `reads` 里的，256 KB 上限，真实路径跑出项目算读不了）的一个字段（JSON 键路径或 Markdown frontmatter 键），值只做相等比较，落到 `cases` / `otherwise` / `missing` / `invalid` / `no_field` 之一，各给 `status`（todo / doing / done）、`detail`、`waiting`（等你 / 等 AI）与可选的 `guide`。`outputs` 有产物时直接算做完、不看 state；`doing` 不会被判成「跳过」（`NodeJudge.inProgress`）。`nodes[].guide` 是「接下来」卡片的说法与按钮（`say` / `draft` / `page` / `op`；`op` 只能是本站 `trigger: user`、没有必填参数的操作，界面先在卡片上确认再执行），经 `/api/progress` 的 `station.guide` 与内置插件的判断函数同一种形状给界面。`studio/declared.test.ts` 用假发布（`flow/testdata/fake-publisher/declared-state.json` 并进清单、顶替内置发布）对齐内置发布插件在各种发布状态下的状态、说明与等谁 | 发布这类站点做没做看的是文件里的字段，等不等你也随状态变；第三方站不能带代码，只能声明，所以给一套可列举、不是表达式的写法，读坏了各有确定结果，不拖垮整条路线 |
| 第三方站点的产物不参与「后面已经做了」的推断（`computeStations` 的 `laterDone` 跳过 `declared`） | 插件一写回执，前面所有自带的站就全成了「跳过」，顶栏全打勾 |
| 插件的扩展点都写在清单里，设置页「详情与设置」照实列出：`settings`（设置页按类型出表单；`secret` 存 `<站目录>/<id>/config/secrets.json`，0600，只经 stdin 的 `settings` 交给插件子进程，接口与页面只知道「填没填」）、`permissions.project`（页面 `am.project()` 拿镜头、路线、发布信息的摘要）、`permissions.network`（只许 https/wss 到域名，进页面 CSP 的 `connect-src`）、`permissions.uses`（页面 `am.call()` 请用户确认后调 am 自带的操作，经 `/api/stations/{id}/call/{op}`）、`hooks`（`turn.finished` / `task.finished` / `gate.confirmed` / `film.approved` 时自动跑本站的 agent 操作）、`slots`（页面嵌进口播稿、分镜、镜头、成片、发布、路线页，`am.info().context` 带上镜头编号等）、`commands`（对话框的斜杠命令）。操作打印 `am-progress <0–1> <说明>` 会显示成任务进度 | 插件能做的事要多，但每一项都要用户看得见：权限不写进清单就没有 |
| `am.call()` 的边界有两层：清单只能申请 `flow.pageCallableOp` 放行的操作（不含归档、记忆回滚与导入、节拍确认、`station_*`、`config_set` 等），执行时客户端给执行进程设 `AM_OP_SCOPE=orchestrator`，`ops/worker.ts` 拒绝不在这个范围里的操作 | 清单写错、宿主漏判，都越不过执行进程这一道 |
| 事件经 `studio/events.ts` 的小总线发（对话、任务、关卡、记忆各自 `emitStudioEvent`，`stations.ts` 订阅），钩子是写任务：项目正忙就这次不跑，不排队；`station.*` 任务结束不发 `task.finished`；一轮对话结束先开排队的下一轮再发事件 | 钩子是顺手做的事，不能挡住用户的下一句话，也不能互相触发、没完没了 |
| 插件页面收在顶栏的「插件」菜单（`PluginMenu`），只用来嵌小窗的页面不列；顶栏右侧的页面链接（`.more-pages`）挤不下时在自己里面横向滚动 | 几个插件一加，顶栏就把整个窗口撑宽（e2e 里断言了不溢出） |
| 页面 `am.send()` 替用户发一条消息给编排工具，与 `run` / `call` 一样先在宿主上确认；`ask()` 只填输入框 | 发消息会开一轮对话、花钱，算对外动作 |
| 定时（`schedules`，5–1440 分钟）：`Server` 构造时起一个每分钟的定时器（`unref`，`shutdown` 清掉），`tickStationSchedules` 到点起写任务，项目正忙就等下一次，不补跑；只限 agent 操作 | 客户端关着不跑，所以不是 cron；不补跑免得一开客户端连跑一串 |
| 阶段补充（`inserts`）：组合时插在那个阶段的段落末尾（按阶段 id 找）；这个流程没有那个阶段时接在最后，按 `flow.allStageTitles` 的标题注明原本要插在哪。`flow.test.ts` / `extensions.test.ts` 核对标题表与模板一致 | 阶段编号随流程变，阶段 id 与标题不变 |
| 整套流程（`flow`）：项目在设置页选用后锁文件写 `flow: <站 id>`，`detectFlow` 返回 `x:<站 id>`，路线按它的 `stations`（内置站 id 加本站 id）排，顶栏第一步换成 `first_page`。提示词：公共约定（口播流程第一个阶段之前的几段）在前，`stations` 里写的内置站复用内置站的段落，本站那一节是清单的 `flow.prompt`。去掉这个站自动回到项目记下的流程 | 新片型不用改 am；公共约定（工作边界、凭据、工具调用写法）不让插件换掉 |
| 配音、对齐（`provides`）：取值 `x:<站 id>` 在 `validTTSProvider` / `validAligner` 里只查写法；插件的配音是它的 agent 工具，不进编排工具命令白名单、不是前置资源（安装页不列）。制作提示词第三、四阶段各有一句指向末尾的插件说明 | 插件工具经 MCP 调用，本来就不需要命令白名单 |
| 渲染技能（`renderer_skills`）：`resolveAllSkills` 经 `flow.pluginSkillsFor` 加入 `plugin:<站>/<技能>`，于是指纹（`skill:` 摘要）、读取放行与 `pluginSkillSection` 提示词都自动覆盖；`scenes: all` 的每个镜头都带，`opt-in` 的只给 `scene.json` 的 `plugin_skills` 点名的镜头。点名了却没有直接报错。项目没加插件时提示词与指纹逐字不变（`scene/pluginskills.test.ts`） | 加一个对所有镜头生效的技能，已渲染的镜头标成 Stale 是对的：渲染输入确实变了；不想全变就用 opt-in |
| 整片风格库（`film_styles`）：`flow.pluginStyleSource` 用通用的 `filmstyle.DirectorySource`（与内置插件能登记的同一种来源），来源 id `x-<站 id>`；用到风格来源的地方先 `flow.syncStyleSources(项目根)`（`film_style_*` 操作、`/api/film-styles`、项目风格接口），`filmstyle.useProjectSources` 整组换掉这个项目的第三方来源；装进项目走同一份 `filmstyle.install` 契约，缺 SKILL.md 时补通用的。第三方风格库不是前置资源 | 插件来源只对加了它的项目可见；风格库随插件钉在 commit 上，不联网 |

内置插件：ArticleToMotion 自己的可选功能也写成插件，放在 `assets/plugins/<id>/`（随 `extraResources` 进 .app），用同一份 `am-station.json`。现在有音乐卡点（`beat`）、歌曲讲解（`song`）、多角色对话（`cast`）、发布（`publishing`）、生成式艺术（`algorithmic-art`）、Lottie 图层（`text-to-lottie`）与 LemoLab 风格库（`lemo-styles`，整片风格来源 lemo-opuscar）。插件也可以在 `apply` 里登记整套流程（`ctx.flow`：路线写 `stations` 或沿用 `base`、提示词段落顺序 `prompt`、`first_page`、`marker`、`excludes`）。

内置插件的代码一律在进程内登记（`apply(ctx)`）：代码放在 `packages/engine/src/plugins/<id>/`，在 `apply` 里登记站（站点、判断函数、「接下来」的说法与关卡确认的话、提示词段落）、流程、操作、页面、后端接口、网页命令、校验器、渲染技能、镜头扩展块、叙事模式、新建选项、在用判断、整批检查、命令组、前置资源、要传给子进程的环境变量与顶栏步骤，宿主各层从登记表里取，内核不按名字认识任何一个功能。清单（`assets/plugins/<id>/am-station.json`）只有名字与说明，作开关用。功能自己的引擎实现（`beat/`、`song/`、`cast/`、`dialogue/`、`castbeats/`）仍在原包里，由插件的 apply 引用。

| 约定（进程内登记） | 原因 |
|---|---|
| 登记表在 `packages/engine/src/plugin`（类型 `types.ts`、登记 `registry.ts`），只 import flow 与 scene 的**类型**，不依赖 studio 与 cli；全部内置插件在 `packages/engine/src/plugins/index.ts` 一处 `deferBuiltin`（排队，第一次取登记表时才 apply），`plugin` 包的入口 `index.ts` 导入它，scene 的包入口也导入它。凡是经 `../plugin` / `@am/engine/plugin` 取登记表的地方都拿得到 | 登记靠 import 副作用，散在各处就会漏。排队是因为插件要用 scene、flow 的常量，而这两个包又经登记表取插件的东西：模块加载期立刻 apply，从 scene 进来的那条加载链上 scene 还没执行完。插件模块的顶层也不要用 scene 的常量（技能描述符写成函数，在 apply 里造） |
| 谁用登记的东西：站 → `flow/registered.ts`（路线、关卡、文件归站、制作提示词顺序与段落正文、阶段标题）；判断函数 → `studio/progress.ts` 的 `stationDefs`（键「站:站点」，与宿主 `judges` 同一种 `plugin.NodeJudge`，另有 `waiting` 说「现在在这」时等谁）；操作 → cli 的 `plugin_ops.ts` 订阅（`plugin.onPluginOps`）后 `defineOp`，工具服务、`tool_help`、`runStudioOp` 与开发用命令行随之都有；页面 → `studioview.viewPages()`（`studio_show` 能切的页、`dedicatedPage` 的专门文件）；接口 → `studio.ts` 路由表末尾；校验器 → `/api/commands/<id>.check`（`api_sessions.ts` 的 `commandAPI`） | 新增内置功能不用改 `flow/builtin.ts`、`studio/progress.ts`、`toolsmcp.ts`：`plugin/registry.test.ts` 与 `packages/cli/src/plugin_ops.test.ts` 用只在测试里登记的假插件钉着 |
| 项目关掉插件时，它登记的东西都不在：站经 `flow.disabledPluginStations`（路线上用空站顶替、制作提示词里它的段落去掉），操作经 `flow.disabledPluginOps`（`toolsmcp.describeTools` 与导演的工具列表拿掉），渲染技能经 `scene.sceneSkills`（`resolveAllSkills` 不解析、`skillPromptSections` 不写，结果里不留占位），镜头扩展块经 `scene.activeSceneBlocks`（提示词里没有它那一段；scene.json 里的块照常解析）。`plugins/onoff.test.ts` 逐个插件钉着，cli 的 `plugin_ops.test.ts` 钉工具列表。`/api/stations` 的 `hidden_pages` 列出这个项目用不上的插件页面（插件关了、也没有第三方站在这一页或同名步骤上放站点），界面据此不显示那一页与顶栏同名的步骤。宿主（含 `app.tsx`）不再按名字判断「发布」 | 有没有一页、一步由插件登记的东西决定，不是特判 |
| 插件的提示词段落放在 `assets/plugins/<id>/sections/`，`PluginSection.after` 指定接在哪一段（`站/段`）后面，`flows` 限定只进哪些流程（发布的「发布配置生命周期」「刷新发布配置」口播与卡点各一版），开阶段的段落写 `stage` 与 `title`；组合时经 `flow.flowPrompt` 排进去。`plugin/registry.test.ts` 的「the shipped prompt sections of builtin plugins」查文件与声明一一对应、标题与正文第一行一致、不写死阶段编号 | 段落随插件下发在资产树里，组合时直接读 |
| 谁用登记的东西（再续）：前置资源 → `prereqs.items`（`am setup --only` 认它的 `group`，安装页按 `later` 的名字、说明、图标合成「以后可能用到」里的一张卡片；项目关掉插件时这个项目的清单不列它，`prereqs.selection` 带上项目根）；子进程环境变量 → `config.load` 算出 `Config.pluginEnv`，`childEnvironment` 照写，工具服务（`tools.amToolsServer`）放行这些键；顶栏步骤 → `studioview.steps()` / `stepIDs()`（`studio_step` 认的、`flowView` 排顶栏、编排工具看到的步骤说明，`flow` 写了只有哪个流程用得上的注明「X 项目的第一步」）；网页命令 → `/api/commands/<id>`（插件从请求体算出操作参数）；页面 → `/api/state` 的 `pages`，界面只列这里有的页，组件在 `apps/desktop/src/renderer/components/pageViews.tsx` 按页面 id 对上（含不在这一页时挂在面板顶上的提示条）；判断函数的 `guide.actions` / `guide.confirm` → 界面「接下来」的按钮与关卡确认时发给 AI 的话；操作的 `noPageCall` → 插件页面不能申请调它（`flow.pageCallableOp`）；整片风格来源 → `filmstyle.sources()`（风格目录、装进项目、风格选择器与海报，见「整片风格」） | 卡点是最后一个写在内核里的功能，它要的这几样以前散在 prereqs、config、studioview、progress、`api_sessions.ts` 与界面里按名字写死 |
| 音乐卡点（`plugins/beat`）登记：流程 `beat`（路线沿用口播的后半程 `tailStations`）、站 `beat-story` / `beat-music` / `beat-plan`（站点、判断函数、「接下来」的说法）与只带段落的站 `beat-common`（宿主段落的卡点版：`head`、`intake`、`render`、`sound`……，正文在 `assets/plugins/beat/sections/`）、`beat_*` 与 `validate_beat`（`ops.ts`）、渲染前的覆盖检查、`beat` 镜头块（`block.ts`）、节拍页与 `/api/beat`（`api.ts`）、网页命令 `beat.confirm` / `beat.regrid`、顶栏第一步 `beat`、前置资源 `beat`（节拍分析环境）、`AM_BEAT_ENV_DIR`、新建选项「音乐卡点」与在用判断（有 `beat.yaml` 不许关）。登记顺序排在发布之后、歌曲讲解之前，流程与新建选项的先后因此仍是口播、卡点、歌曲讲解。`plugins/beat/beat.test.ts` 钉着登记了什么、关掉时什么不在 | 卡点做成插件之后，`flow`、`studio`、`studioview`、`scene`、`config`、`prereqs`、`projectinit` 里没有一处按名字认识它 |
| 每个登记的内置插件在 `assets/plugins/<id>/` 都有清单（开关、名字、说明来自它）；`registerBuiltin` 拒收重复的插件、站、操作、页面、接口、校验器、渲染技能、镜头扩展块、叙事模式与新建选项，普通站点没有判断函数直接报错 | 开关只认清单与锁文件；漏一个判断函数，那一站就永远显示「没做」 |
| 谁用登记的东西（续）：渲染技能 → `scene.allSkills` / `sceneSkills`；镜头扩展块 → `scene.sceneBlocks()`（与宿主经 `registerBlock` 登记的合在一起按 `order` 排）；叙事模式 → `projectinit.narrations()`（`am init --narration` 的取值、新建时调用它的 `init` 写初始文件，选了它就算在用这个插件）；新建选项 → `projectinit.presets()` → `/api/styles` 的 `modes`（首页的做法与模板）；在用判断 → `flow.inUse`（设置页开关锁住、新建时的互斥）；整批检查 → `scene_run_all` 渲染前（`beforeRender`，它的 `params` 并进 `scene_run_all` 的参数，例如歌曲讲解的 `song_timeline`）与 `concat` 拼接前（`beforeConcat`）；命令组 → 开发用命令行。判断函数的 `guide` 是界面「接下来」卡片的说法（`/api/progress` 的 `station.guide`），操作的 `verb` 是对话里的说法（`/api/stations` 的 `contents.ops`）；`/api/stations` 给内置插件的 `contents` 列出它登记的站点、工具、技能、块、页面与流程，设置页「内置功能」的「详情」照实显示 | 新增一个带操作、渲染技能、镜头扩展块与初始文件的内置功能不用改 `scene/`、`projectinit/`、`toolsmcp.ts`、`studio/`：`plugin/registry.test.ts` 的「a builtin plugin with a skill, a scene block and a narration」用测试里登记的假插件钉着 |
| 内置插件的操作写在引擎里（`plugins/<id>/ops.ts`），共用零件（`projectRoot`、`timeout`、`withTimeoutSignal`、`ParamError`、`parseDuration`）在 `packages/engine/src/opkit`，cli 的 `ops/common.ts`、`ops/op.ts` 转出同一份；改 scene.json 的 Go RawMessage 写法在 `packages/engine/src/rawjson` | 引擎不能 import cli；两边各写一份，工具服务按 `instanceof ParamError` 判断参数错误就会认错 |
| 「发布」（`plugins/publishing`）：站 `publish`（排在 `review` 后、段落三段）、判断函数、`validate_publish`、发布页（排在复查后，`publish.md` 是它的专门文件）、`/api/publish` 与 `publish.check`；`publish.md` 的校验（原 `validate.publish` / `readPublish`）、平台封面规格与标题字数都在这个目录里。`plugins/publishing/golden.test.ts` 用搬家前记下的金样核对提示词、路线、制作路线、页面与接口逐字节不变 | 发布是第一个真搬的功能；金样证明搬家没有改变任何行为 |

| 约定（清单与开关） | 原因 |
|---|---|
| `flow.builtinPlugins()` 读 `assets/plugins/`，`loadProjectStations` 把它们排在第三方站前面，`LoadedStation.builtin` 为真；默认打开，项目在锁文件的 `disabled` 里关掉（`station_builtin` / `POST /api/stations/{id}/enabled`，设置页「内置功能」的开关）。清单坏了直接报错，不静默少一个功能 | 内置功能也能关：用不到的不占编排工具的工具列表和提示词 |
| 清单没有给内置插件专用的字段：操作、技能、站都在 apply 里登记。`station_cmd.test.ts` 的门禁：登记的操作都进了操作表、一个操作只归一个插件、`song_*` 全归歌曲讲解、`cast_*` / `dialogue_*` 全归多角色对话。第三方站不能与内置插件重名 | 归属与开关跟着插件走 |
| 在用判断（`ctx.inUse`）：项目里有 `song.yaml`（歌曲讲解）、`cast.yaml`（多角色对话）时不许关 | 关了正在做的片子就少了工具 |
| 登记了渲染技能或镜头扩展块的插件（歌曲讲解、多角色对话、生成式艺术、Lottie 图层），设置页的开关提醒「已渲染的镜头要重新渲染」；开关会改变渲染输入，已渲染的镜头标 Stale 是对的，不为避免它做特殊处理 | 技能段进每个镜头的渲染提示词 |
| 歌曲讲解（`plugins/song`）登记 `song_*` 与 `validate_song`（`ops.ts`）、song-explainer 技能（`skill.ts`，不写 `promptSection`：它的提示词由 song 块在歌曲镜头里引用）、song 块（`block.ts`）、整批检查（渲染前核对歌曲时间轴覆盖、拼接前核对歌曲镜头没过期）与新建选项；多角色对话（`plugins/cast`）登记 `cast_*` / `dialogue_*` / `validate_cast`、character-rig 技能、cast 块（考试重放带上角色包目录）、叙事模式 `cast`（写 `cast.yaml` 与 `cast/`）与新建选项；生成式艺术与 Lottie 图层各登记一条渲染技能。`PROMPT-SONG.md` 与技能本体仍在 `assets/shared`（`song_init` 从那里拷） | 内核（scene、projectinit、toolsmcp、memory、cli 的 scene_run_all / concat / scene_cues）不再按名字认识它们 |
| 歌曲讲解的流程（`plugins/song`）：站 `song-prompt`（站 id 不能与插件 id 同名）只有一段 `main`（`assets/plugins/song/sections/main.md`，歌曲讲解的完整制作说明）。流程 `song` 的路线沿用口播（`base: 'speech'`）；操作、技能、块在同一个 `apply` 里登记 | 歌曲项目的提示词只有歌曲讲解自己的规程，口播流程里也不再带「歌曲讲解分支」 |
| 歌曲讲解的引擎代码与 song-explainer 技能不动（技能仍是注册的内置技能）；`song_init` 给已有项目补 `song.yaml` 与技能，并把流程记录换成 `song` | 项目用哪个流程只看记录，不看 `song.yaml` |
| 插件 id 不能与站 id 相同（所以发布插件叫 `publishing`）。关掉内置插件时它登记的站不参与提示词组合，阶段编号连续；`projectExtras` 用一个没有站点的站顶替它（排在第三方站后面，第三方顶替同一个站时以第三方为准），制作路线上就没有它 | 发布的说明散在第一阶段、刷新发布配置与交付清单里，作为段落留在原位，关掉时整段不组合 |
| 发布插件不登记在用判断：首版 `publish.md` 在第一阶段就生成了，设了就再也关不掉。关掉后客户端顶栏不显示发布这一步与发布页，除非有第三方站在发布这一步放了站点（`/api/stations` 的 `hidden_pages`）。交付清单里发布的两行拆成 `assets/plugins/publishing/sections/deliverables.md` 归发布站 | 只做内部用的片子不必做封面与发布信息 |
| 测试用的假发布站在 `flow/testdata/fake-publisher`（只写回执、不联网）；vitest setup 与 e2e fixtures 把 `AM_STATIONS_DIR` 指到临时目录 | 测试不能往开发者真实的站目录写 |

- 要像直接写给人类操作者的任务说明，不暴露执行者是 agent、Codex 或 AI，也不使用「主控 agent」这类身份设定；但可以明确说明他需要操作其他 AI。
- 不得出现 `./am` —— 用户项目里没有这个可执行文件。
- 制作步骤写成 am 工具服务里的工具调用：`工具名({参数})`，参数一律按名字（例如 `scene_run({"scene": "scenes/scene-001"})`、`align_build({"fps": 30})`、`scene_frames({"scene": "…", "at": "0", "check_blank": true})`），不写 `--flag`。参数名以操作表为准（`tool_help` 里有）。不教 `am <命令>`，更不写 `$(am …)` 这样的命令替换——am 不在编排工具与渲染器的 PATH 里。前置资源缺了一律指向客户端的工具准备页，不写「在终端运行 am setup」。`gen.test.ts` 的「keeps the orchestrator out of am internals」「leaves voice tools to am setup」钉着。
- 这两条由 `packages/engine/src/project/boundary.test.ts` 的「prompts use installed CLI and do not expose executor identity」强制执行，违反会让测试失败。

## 媒体校验与拼接

`packages/engine/src/mediaprobe` 是所有 ffprobe / ffmpeg 调用的唯一入口，别在其他包里直接拼这两个命令。

| 类型 | 作用 |
|---|---|
| `Spec` | 期望规格。**零值字段表示不检查**，调用方只想查一件事时不必填满全部字段 |
| `checkSpec` | 返回**全部**不符项，不是第一条。每次只报一条会让调用方「修一条、重跑一次、再发现下一条」 |
| `Toolchain.verify` | 完整校验流程，返回 `Report`。抛错只表示「检查没跑成」，「跑了但不合格」是 `Report.ok === false` |
| `FrameStats` | 单帧灰度均值与标准差。`isBlank` 只看 `isFlat`，**不叠加 `isDark`** |

空白帧阈值（`flatStdDev = 2.0`）刻意取得极保守。不能凭「真实帧标准差通常很高」来定：深色背景上只有一行标题时亮部占比不到 1%，标准差会低到 20 出头，那是合法封面。误判它比漏判一个真空白帧更糟——前者会让人很快不再信任这个检查。`mediaprobe.test.ts` 的「frameStats does not flag sparse text on dark background」钉着这个上界。

`packages/engine/src/concat` **刻意不提供重定时能力**。PROMPT 第八阶段写着「禁止通过 `setpts` 或改变帧率让镜头追赶配音」——提示词里的禁令可以被忽略，不存在的能力不能。所以分辨率或帧率不符归入 `Plan.blocking` 要求重渲染，只有编码和像素格式差异走 `Plan.normalize`。**不要为了「方便」给它加缩放或变速参数。**

镜头产物校验（`scene.verifyOutput`，`scene/run.ts`）查画幅、帧率、时长、逐帧解码的总帧数、无音轨，不查编码和像素格式：PROMPT 第八阶段明确允许镜头产物规格不一致，由拼接前的规范化统一，在镜头层拦下会和那条既定流程打架。

校验失败抛 `VerificationError`（`scene/verification.ts`），命令行把它包成 `schedule.FatalError`（经 `schedule.fatal`）停止重试。规格不符是确定性的，重跑只会得到同样的产物，而每次重试都是一次完整的 AI CLI 调用。**新增确定性失败时记得走同一条路。**

`scene.verifyOutput` 还会跑 `packages/engine/src/determinism` 的源码扫描：从合成入口沿本地引用展开，只扫渲染真正加载的文件，命中同样抛 `VerificationError`。规则只收「上游禁令里有、HyperFrames lint 不查、几乎没有合法用途」的写法；`setTimeout` 刻意不收，等字体就绪的代码里太常见。新增规则前先拿内置技能与上游技能的示例跑一遍——`determinism/scan.test.ts` 的「embedded viewer template passes」钉着 algorithmic-art 的 viewer 模板，它的交互路径靠逐行 `am-allow-nondeterministic` 豁免。误判一次，这道门就没人信了。

`@font-face` 只判两种确定的错误：`src` 指向镜头目录里不存在的文件，以及 `font-display` 显式写成 `swap` / `fallback` / `optional`。没写 `font-display` 不判（Chrome 的 `auto` 按 `block` 处理），`local()` 不判（常见写法是 `local()` 后接 `url()` 兜底）。

成片级检查有两条：`am review` 比对音视频流时长、总帧数与镜头帧数之和、镜头交界帧并出联系表，并解码成片实测积分响度与真峰（只进 hints：平台响度规范各不相同，frame.md 的目标是缺省建议）；`am audio check` 用能量包络独立校验字幕时间轴。两者把切黑转场、字幕延长停留这类「机器分不清有意还是事故」的情况放进 hints，不改变退出码。

`am validate reads`（`packages/engine/src/reads`）读 `visible-event-inventory.json` 检查每个可读元素的停留时长、短语绑定与顺序。阈值取 Netflix 简体中文字幕规范（每秒 9 字、每条至少 5/6 秒），那是固定位置字幕的下限；画面元素还要先被找到，所以只能放宽不能收紧——收紧会把合法的快节奏镜头判死。字数按阅读单位算（一个英文词算一个），同理是为了不高估。两个 JSON 的字段名写死在制作提示词第四阶段，改字段要同步改那里。

`mediaprobe` / `concat` 的集成测试需要真实 ffmpeg，缺失时自行跳过。CI 装了 ffmpeg——不装的话测试仍然「通过」，真正跑外部命令的代码再没被验证过。

## 镜头时长、局部数据与复用

配音时间轴由 `am align`（`packages/engine/src/align`）从终稿与对齐器输出算出：终稿用 `<显示|朗读>` 与 `@{id}…@{/id}` 标记，`build` 逐字匹配（标签 exact / split / merge / replacement / source-omission / evidence-insertion），写 `voice.srt` 与 `phrase-timeline.json`。匹配代价刻意不照搬 HYPIT：它按整词匹配，按单字匹配时原样的代价会把漏读的几个字合并成一次「替换」藏起来，见 `align/match.ts` 的注释。对齐器 JSON 的结构没有逐版本实测，加载器按「找到第一组带 text/start/end 的对象数组」宽松解析，认不出时报出顶层结构并给出标准结构 `[{"text","start","end"}]`。人工修正只走 `phrase-adjust.json`，不改测量数据。

口播项目的镜头时长由 `am scene cues`（`packages/cli/src/scene_cues.ts`）从分镜计划 `production/scene-plan.json` 推出，与卡点插件的 `beat_cues` 同一个思路：计划只写锚点（`first_subtitle` / `first_phrase`）与切点规则（`cut`），帧号由代码算，写进 `scene.json` 的 `duration_seconds` 与 `timing` 块，`scene.verifyTimingInputs` 做精确比对。秒换帧沿用 `frames.frameOf`（`packages/engine/src/frames`），不要另写取整。计划严格解析，新增字段要在 `scene.PlanEntry`（`scene/timing.ts`）里登记，否则提示词里让编排工具写的键会让命令直接失败。

`scene.run` 在启动渲染器前写 `am-scene.js`（`window.AM_SCENE`）。它的字段名是 `scene-kit` 技能的契约：`packages/engine/src/scene/scenedata.ts` 与 `assets/shared/.agents/skills/scene-kit/scene-kit.js` 两边改一处就要改另一处，`packages/engine/src/project/scenekit.test.ts` 用真实扫描器把示例镜头跑一遍。没有 `timing` 块的老镜头照样写这份文件（`cues` / `phrases` 为空），提示词里不出现时间合同表。

镜头交接（`scene/timing.ts` 的 `PlanHandoff` / `Handoff`）是分镜计划里唯一跨镜头的约定。渲染器互相看不到，交界能接上只靠两侧拿到**同一份**约定，所以它由 `am scene cues` 从计划抄进两侧的 `timing.enter` / `timing.exit`，不让编排工具在两份 `prompt.md` 里各写一遍。手法表 `HandoffDevices` 刻意只收「靠画面里的东西接过去」的写法，不收通用擦除——章节交界套固定转场正是要消除的生硬；「相邻章节交界不得同手法」也是同一个理由。`am review` 用 `Toolchain.frameDifference`（32×32 RGB 均值绝对差）比对声明过交接的交界，阈值取得宽，只拦「两张不同的画面」：物件挪几像素就报的话，这道门很快没人信。改手法表要同步改制作提示词第五阶段「镜头交接」的表格，`gen.test.ts` 的「carries scene handoffs」钉着。

scene.json 里功能自己的块（多角色对话的 `cast`、歌曲讲解的 `song`、卡点的 `beat`）是**镜头扩展块**：`scene/block.ts` 是注册表（`SceneBlock`：字段名 `key`、先后 `order`、解码描述 `type`、`toJSON`、load 时的 `validate`、互斥 `excludes`、渲染前与复用前的 `verifyInputs`、与 timing 互斥的 `timeline`、提示词段 `promptSection`、指纹项 `fingerprintParts`、记忆特征 `feature`、考试要拷的目录 `extraInputDirs`）。块一律由功能插件在 apply 里 `ctx.sceneBlock(...)` 登记（`plugins/cast/block.ts`、`plugins/song/block.ts`、`plugins/beat/block.ts`），用 `declare module` 把自己的字段并进 `Scene`；`registerBlock` 只给测试登记假块。`scene.ts`、`record.ts`、`timing.ts`、memory 的特征与考场、cli 的 `scene_cues` / `beat_cues` 只遍历注册表，不按名字读 `s.cast` / `s.song`。

| 约定 | 原因 |
|---|---|
| 功能的块放在 `plugins/<id>/`，不放进 cast / song 包 | 块要用 scene 的 `contained`、`sceneCanvas`、`VerificationError`；放进功能包，功能包就反过来依赖 scene。`castbeats` 从 `plugins/cast/block.ts` 取 `Beat` 与重叠容差 |
| scene 的包入口导入 `../plugin`（登记全部内置插件）；engine 的 `vitest.setup.ts` 另导入一次，因为 scene/ 自己的测试直接 import `./scene` | 登记靠 import 副作用，散在各处 import 就会漏。漏了不静默——含这个块的 scene.json 报「未知字段」 |
| 字段、提示词段、校验、指纹项的先后都按 `order`（cast 10、song 20、beat 30），扩展块排在 `plugin_skills` 之后、`timing` 之前；timing 是 scene 自己的块，不进注册表 | 同一版本内 scene.json 写回、提示词与指纹要稳定，`scene/blocks.golden.test.ts` 用 `testdata/blocks-golden/` 钉着；`block.test.ts` 用只在测试里登记的假块证明加一种块不用改内核 |
| 全片唯一的秒换帧公式与总帧数在 `frames/`（`frameOf`、`totalFrames`），Go `encoding/json` 与 yaml.v3 解码的复刻在 `gojson/decode.ts`、`goyaml/decode.ts`；卡点、对齐、镜头时间合同、角色包都从那里取，`beat` 包转出 `frameOf` / `totalFrames` | 它们不属于任何一个功能；放在 beat、cast 包里时内核就得 import 功能包 |

镜头复用按输入指纹判定（`scene.fingerprint`，`scene/record.ts`，记录在镜头目录的 `.am-render.json`）。指纹只算**声明过的输入**，不扫整个镜头目录——渲染器自己会往目录里写合成代码，算进去的话渲染一结束指纹就变了。镜头新增一类输入文件时，要把它加进 `fingerprint` 的文件清单，否则改了它也不会触发 Stale。指纹一致只表示「这份已验收产物出自当前输入」，不表示可复现；指纹不一致仍只标 Stale、要 `--force` 才覆盖，不要改成自动重渲染。指纹的摘要按字节算，所以写进 `.am-render.json` 与提示词的文字要逐字稳定，见 `packages/engine/CONVENTIONS.md`。

每次渲染写 `render-<id>.attempt.json`，重渲染前 `scene.archiveAttempt`（`scene/attempt.ts`）先把上一次的产物、日志与尝试记录挪进 `attempts/`。调度层的重试与单镜头重跑走同一个归档函数，不要各写一份编号逻辑。token 用量按各工具流式事件尽力读取（`tools.accumulateUsage`），读不到就留空，不做估算。

用量口径统一（`tools/usage.ts` 的 `Usage`）：输入含缓存命中与写入，缓存是输入里命中的部分，输出含推理。codex 原样就是这个口径，claude 系与 opencode 要把缓存加回输入——不统一的话 claude 显示「输入 4、缓存 40437」，跨工具既不能比也不能相加。记录带 `basis: total-input`；新增一家工具时要按这个口径填，并在 `tools/usage.test.ts` 的「usage is comparable across tools」里加一行真实流。汇总一律用 `usageAdd`：有一次没读到用量就标 `partial`，数字只是下限。

用量账以尝试记录为准：`scene.attemptHistory` 读当前记录加 `attempts/` 归档，失败与重试照样计入（`am scene usage`、客户端镜头列表）。客户端后端把 `render-*.attempt.json` 当媒体只记 stat，回退一轮不会删掉它——那是已经花掉的钱。

编排工具的用量记在账本里（`packages/engine/src/ledger`，只追加的 JSONL）：客户端每一轮记进项目的 `production/usage/orchestrator.jsonl`，整理记忆记进记忆库的 `orchestrator-usage.jsonl`。每次调用一行，失败、取消、续接失败后重开的会话都各记一行；进程没起来（`agentrun` 的 `Result.started` 为 false）的不记。模型名取 `Result.model`（流里的 `system/init`），读不到再按 `tools.configuredModel` 补。客户端后端的 `scanTree` / `statTree` 跳过 `production/usage/`：账在一轮结束前写下，不跳过的话会算成这一轮的改动，回退时连账一起抹掉。`am usage` 合计渲染与编排两本账。

## 渲染记忆

`packages/engine/src/memory` 实现 `docs/superpowers/specs/2026-11-02-渲染记忆-design.md`（本地设计稿，不进公开树）：经历 → 整理成试用经验 → 回放考试 → 生效并按镜头召回。记忆库在用户级目录（`MemorySettings.dir`，`config/config.ts`），不在项目里。

| 约定 | 原因 |
|---|---|
| `scene` 不依赖 `memory`：召回结果经 `Scene.memory`（`MemoryRecall`，已渲染好的文本与摘要）挂进来，经历经 `Scene.afterAttempt` 回调写出；二者都不进 `scene.json`，`afterAttempt` 在 `fingerprint` 里清掉 | `memory` 要读 `scene` 抽特征、冻结输入；反过来依赖会成环。回调让经历拿到的正是 `scene.run` 写下的那份尝试记录，不靠事后读文件猜是不是本次的 |
| 召回段放在 `determinismSection` 之后，开头声明「与上面的强制要求冲突时以上面为准」；段落里不写快照号 | 手写约束优先于学来的约束。不写快照号是为了回退到内容相同的快照时召回段逐字不变，镜头不被误判 Stale |
| `MEMORY` 默认打开；没有召回条目时 `fingerprint` 不加 `memory` 项、提示词逐字不变 | 项目要随使用越来越懂用户，所以默认打开；空库时与关闭逐字相同，升级 am 不会让老镜头变成 Stale |
| 记忆打开时 `orchestratorAccess`（`config/providers.ts`）把记忆库放进 `OrchestratorAccess.writableDirs`，codex 安全模式据此加 `--add-dir`；`am run` 与客户端每轮开工前先建好记忆库目录 | 编排工具调用的 `am memory remember`、`am scene run` 要写用户级记忆库，codex 的 workspace-write 沙箱默认只放行工作目录，写不进去也不报错，只是经历和偏好静默丢失 |
| 命令行测试（`packages/cli/src/testutil.ts`）与客户端后端测试（`packages/engine/src/studio/testsupport.ts`）把 `AM_MEMORY_DIR` 指到临时目录；只读路径（偏好段）用 `memory.openReadOnly`，不建目录 | 记忆默认打开，测试不设它就会往开发者真实的 `~/.local/share/am/memory` 写经历 |
| 召回只读快照（`Snapshot.entries` 存完整文件内容），不读记忆文件；手改文件要经 `am memory status` 记成标注「未经考试」的新快照 | 同一快照 + 同一镜头输入永远同一召回；回退只需把快照内容写回 |
| 效果统计不写进记忆文件，由经历聚合（`computeStats`，`memory/stats.ts`），生成快照时冻结进 `Snapshot.stats` 供排序 | 并发镜头同时改一个文件会打架；统计写进文件会让规则摘要随每次渲染变化 |
| 统计只算正式渲染的首次尝试；考试经历（`SourceExam`）不进统计、不进整理；渲染工具崩溃不算失败经历 | 重试带着失败说明、考试是人为安排的对照，混进来统计就失真；崩溃不是写法问题，记忆帮不上 |
| 失败按校验器 ID 聚类：`VerificationError.checks` 与 `problems` 等长一一对应。产物校验的 ID 由 `scene.classifyOutputProblem`（`scene/checks.ts`）按 `mediaprobe` 的措辞前缀归类，确定性扫描的 ID 是 `determinism.` + 规则名 | 改了 `checkSpec` 的措辞要同步改归类，`scene/memory.test.ts` 的「verification checks align with problems」会抓住落进 `output.other` 的问题。新增确定性规则要登记进 `determinism.ruleIDs()`，`determinism/rules_ids.test.ts` 的「cover every emitted rule」守着——经验的 `checked_by` 只认这两处的 ID |
| 不同模型犯的错不一样：经验可以用 `applies_when.renderers`（渲染工具 ID）/ `models`（模型名前缀）限定范围，召回按当前渲染工具与模型硬过滤，专属经验排在通用经验前；模型未知时不召回限定了模型的经验 | 只在某个模型上成立的经验注入给别的模型，只会白占预算甚至误导；没写范围的经验仍对所有渲染工具成立 |
| 模型名只来自实测：claude / qoder / codebuddy 读输出流的 `system/init`（`tools.detectModel`），codex 读 `$CODEX_HOME/config.toml` 顶层 `model`（`tools.configuredModel`），opencode 记为未知。召回在渲染器启动前，用 `Store.currentModel`：配置声明的优先，否则取 `models.json` 里最近一次实测的 | 流里的模型名只有渲染开始后才有；换模型后的第一次渲染按旧模型召回，渲染完即更新 |
| 格式校验（`memory.lint`）拒收正文 / 描述 / 关键词里的工具名与模型名（范围只能写进 `applies_when`）、镜头编号、素材文件名、照抄镜头文案连续 8 字以上、与已有经验同校验器同特征同范围却不写 `revises` 的草稿 | 正文保持中性才能在范围放宽时直接复用；「矛盾」无法语义判定，用「同一组校验器 + 特征 + 范围」近似，只拦并列新增 |
| 偏好也交给编排工具：`Store.preferenceBrief` 的结果追加在 `am run` 的提示词后、客户端每轮对话前（偏好摘要没变且 CLI 会话还在时不重发，见 `SessionMeta.preference_digest`）。段落里总写着怎样用 `am memory remember` 记下新偏好；用户亲口说的偏好直接生效，不经人工确认或考试 | 用户随口一句话，是编排工具在理解、在定分镜和风格；渲染器只拿到展开后的镜头说明 |
| 事后检查也是校验器：`am validate reads`（`reads.<规则>`，来自 reads 报告的 `findings`）、`am review`（`review.handoff`，`review.handoffBroken`）、`am scene frames --check-blank`（`frames.blank`）查出的问题经 `Store.recordCheck` 记到镜头上，渲染工具 / 模型 / 召回继承该镜头最近一次渲染；同一份产物同一组问题不重复记。统计里，事后查出问题的产物不再算一次通过 | 产物校验与确定性扫描是渲染工具本来就很少犯的错（导入的 82 次真实渲染全部一次通过），决定观感的是阅读时间、交接与空白帧 |
| 只由 `reads.*` / `review.handoff` 判定的经验考不了（要看整片），`memory.examinable`（`memory/features.ts`）把它们排除在考试外，由人 `promote`；`frames.blank` 由考试在作答后补查第 0 帧（`ExamOptions.postCheck`），只补查试用经验引用的校验器 | 单镜头重放没有整片清单和相邻镜头；补查只看第 0 帧，是因为空白帧经验来自「第 0 帧当封面」，看末帧会把合法的淡出算进去 |
| 偏好信号（`memory.preferenceSignals`，`memory/conversation.ts`）：客户端每轮对话的话与回退经 `recordUtterance` 记为 `conversation` 经历，在不同轮次反复提的同一要求（字二元组 Jaccard ≥ 0.5 或重合占短句 ≥ 0.6）、被回退的一轮、带说明的 👍 / 👎 汇成 `human` 组交给整理者起草偏好；起草的偏好要确认，偏好段会让编排工具在对话里问用户 | 单独一句话大多只对这一次成立，反复与回退才说明默认做法不合心意 |
| 批次：每次 `am scene run` / `run-all` 生成一个 `run-…` 编号写进经历，`am memory report` 与客户端「运行对比」按批次、按渲染工具/模型比一次通过率、重试、问题数、耗时与 token | 评审要看到「第二次比第一次好」，混在一起的话换了渲染工具的变化会被算成记忆的功劳 |
| 统计键是「渲染工具/模型」（`statKey`）；召回排序只把当前模型自己的样本当强证据，别的模型的样本向 0.5 收缩一半。`am memory status` 报告的 `retest` 列出考试时用的模型与现在不同的生效经验，`am memory exam --retest` 对照组去掉它重考，通过补记考试编号，不通过只报告不改状态 | 换了模型，旧结论不再可信，但也不能自动作废 |
| `am memory import` 导入已有项目：只读尝试记录（当前的与 `attempts/` 归档里的）、review.json 的交接与阅读时间清单；没有尝试记录的归档不导入 | 没有尝试记录就说不清当时用的是哪个渲染工具、为什么失败，按现在的镜头重判会凭空制造失败 |
| 记忆设置经 `childEnvironment` 显式传给子进程（`AM_MEMORY_DIR`、`MEMORY`……） | 安全模式白名单里没有它们，编排工具调用的 `am memory remember` 会落到默认目录，codex 沙箱里直接写失败（实测） |
| 召回每个镜头最多注入 `DefaultMaxLessons`（3）条经验（`memory/recall.ts`），排在后面的记为 `limit`；偏好不占条数，只受字数预算 | SkillsBench（2026）里 1–3 条技能提升 18–19 个百分点，4 条以上只剩 10：条数多了指导互相冲突。字数预算拦不住「很多条短经验」。考试的试用组同样受这个上限，挤不进前 3 的试用经验就是在真实召回里也用不上 |
| 经验的修订（`revises`）要保留旧版全部 `checked_by`，正文不得短于旧版的一半（`lintRevision`） | ACE（ICLR 2026）记录过整体重写把上下文从 1.8 万 token 压成 122 token、准确率跌破基线；LLM 改写还倾向为简洁丢细节。偏好不查：用户换说法替换旧偏好，短一点正常 |
| 整理时每组失败最多附 `MaxContrasts` 组成败对照（`memory/consolidate.ts`；同一镜头后来改对的优先，其次同渲染工具、特征最接近的通过渲染）；通过那一版的源码在指纹仍一致时拷进整理工作目录的 `contrasts/` | 只看失败，整理者只能把报错改写成禁令；ExpeL、ReasoningBank 都从成败对比里提炼。拷进工作目录而不是给路径，是因为整理者在安全模式下未必能读工作目录之外 |
| `suspectMemories`（`memory/stats.ts`）：召回后它 `checked_by` 里的校验器照样判失败，有害 ≥ 2 次且不少于召回次数的一半，记为「可疑」，按渲染工具/模型分开；只给候选，不改状态 | 「待沉睡」要攒够样本比基线；可疑是更直接的负证据（借鉴 ExpeL 的增减投票、ACE 的 helpful/harmful 计数）。改状态要经重考或人 |
| `am memory remember --inferred`：编排工具推测（用户没明说）的偏好进入试用，出现在偏好段的「待确认」里，用户认可后才生效 | 没经确认就写进记忆的内容会被照着做、错了被放大（Xiong et al. 2025）；用户亲口说的不在此列 |
| 记忆探索（`MEMORY_EXPLORE`，默认 0.1）是一批渲染的决定，不是镜头的属性：`attachMemory`（`packages/cli/src/memory_cmd.ts`）按「批次编号 + 镜头目录」抽签，抽中就把注入的最后一条经验换成排在上限外、字数换得进去的第一条，倾向分数记进经历的 `explored`。`recallDigest` 仍返回不探索时的摘要，输入指纹不变；考试与 `am memory recall` 不探索 | 召回排序只统计「当时被召回」的经验，排在上限外的永远攒不到样本，排序会固化（日志 bandit 的选择偏差，Kiyohara et al. 2025）。探索要放在 agent 的运行里而不是镜头里：指纹带上探索结果的话，抽中的镜头下次会被判 Stale，没抽中的又永远不会被探索 |
| 镜头特征词表是 `FeatureDescriptions`（`memory/features.ts`），新增特征要同时改同文件 `features` 的抽取 | 整理说明与格式校验都只认这张表，抽不出来的特征写进经验永远匹配不上 |
| 考试的作答者由调用方注入（`ExamRunner`，`memory/exam.ts`），考场建在项目的 `production/memory-exams/` | 渲染器从镜头目录向上找 `.agents/skills`，建在记忆库里就找不到项目技能 |
| 整理的时机是用户确认成片可用：客户端成片页的「确认可用，去发布」发 `/api/memory/actions/consolidate`（`final: true`，已有整理任务在跑时复用它），对话里确认时由编排工具按制作提示词第十三阶段「整理这次制作的经验」运行 `am memory consolidate`（`gen.test.ts` 的「consolidates memory after the user approves the film」钉着）。不按次数、不在每轮结束时自动整理；考试仍只在用户点了之后做 | 片子还在修改时问题没记全，中途整理出的经验只覆盖一半；用户点头的那一刻是一部片子的自然终点。考试每场是好几次真实渲染，面板在有试用经验时把「考试」放在经验列表顶上 |
| 记忆面板（`apps/desktop/src/renderer/components/Memory.tsx`）页头用三步讲清记忆在做什么（记下的问题 → 整理成的提醒 → 渲染时用上，各带现在的数字），下面是等你确认的、还没整理的问题（`/api/memory` 的 `pending`，按校验器归组、带镜头，不是渲染日志）、你的要求、学到的经验、当前镜头会带上的几条；渲染记录、效果对比、考试、存档回退收进「高级」；校验器 ID、事件类型、镜头特征一律经 `/api/memory` 的 `labels` 换成大白话（`CheckerLabels` / `EventLabels` 在 `memory/labels.ts`，`FeatureDescriptions`），`memory/labels.test.ts` 的「TestEveryCheckerHasLabel」守着说法表与 `knownCheckers()` 一致 | 旧版把快照号、`reads.binding`、`episode` 和考试控件平铺在第一屏，用户看不懂记忆学到了什么；后来的版本库里只有失败经历时，整页是几段「还没有」加一串渲染日志，仍看不出记忆在干什么 |
| 门槛 `judge`（`memory/exam.ts`）是纯函数，五条门槛各有单测；渲染工具自身故障让整场无效，不按 0 分算 | 一次认证失效不能让一条好经验被拒 |

## 卡点模式

卡点是内置插件 `beat`（`packages/engine/src/plugins/beat`，见「内置插件」）；`packages/engine/src/beat` 是它用的无配音卡点时间契约，以项目根 `beat.yaml` 启用，与 `song.yaml`、`cast.yaml` 互斥。链路是「导入音乐 → 分析出草稿网格 → 试听确认 → 按小节的分镜计划 → `beat_cues` 写镜头时长」。

| 约定 | 原因 |
|---|---|
| 切点帧号只由 `frameOf`（秒 × fps 四舍五入）算出，总帧数只由 `totalFrames` 算出（都在 `frames/`，`beat` 包转出） | 两处取整方式不同，画面与音乐会慢慢错开，而且是那种看半天说不出哪里不对的错开 |
| 分镜计划 `plan.json` 只接受小节数，不接受秒数 | 能写秒数就能写出不在重拍上的切点；切点卡在重拍上要由结构保证，不靠事后对轴 |
| `beat_cues` 写 `duration_seconds`，`beat.verifyCue`（`beat/cue.ts`）对切点做**精确**比对 | 帧号只有一个来源，任何偏差都是有人手改了时长；成片里的 ±1 帧容差属于整片复查，不属于这里 |
| 草稿网格永远不直接生效，只有 `beat.confirm` 能把 `reviewed` 置为 true | 模型最常见的错是重拍整体错位或拍号判错，只有听过试听轨才知道 |
| 分析脚本把结果写进文件，不打印到 stdout | 首次运行下载模型权重，进度输出会污染标准输出，按 stdout 解析时结果直接丢失（实测过） |
| 节拍分析环境是卡点插件登记的前置资源（`ctx.prereq`，实现在 `beat/env.ts`）：`am setup --only beat` 在 `~/.local/share/am/beat/venv-<AnalyzerVersion>`（`AM_BEAT_ENV_DIR` 可覆盖，插件经 `ctx.childEnv` 登记，`childEnvironment` 显式传）里建 venv、`pip install beat-this==<版本>`、预下载默认 `final0` 权重，全部成功才写完成标记，失败整个删掉重来、重试 3 次。基础 Python 按 `basePythonCandidates` 找 3.10–3.14 的（`AM_BEAT_BASE_PYTHON` 可指定）；pip 用用户自己的 pip.conf，`--proxy` 只给权重下载。`beat.yaml` 的 `python` 可选，不写用共享环境，缺了抛 `prereq.MissingError`；卡点流程的制作提示词禁止编排工具自己建环境 | 以前 `beat.yaml` 默认 `python: python3`，系统 Python 里没有 beat-this，编排工具就在对话里自己建 venv、pip install，每个新项目都可能多一套约 800 MB 的 torch（实测两套并存，一套是客户端新建项目时现建的）。系统 `python3` 是 3.15 时 torch 装不上，所以按已知可用的版本挑 |
| 音乐由 ffmpeg 解码成单声道 WAV，脚本用标准库 `wave` 读，再调 `Audio2Beats` | 不走 beat-this 自带的 torchaudio 读文件：它的后端随版本变化，能不能读 MP3 取决于用户机器 |

节拍分析固定 `beat-this` `AnalyzerVersion`（`beat/store.ts`，代码与权重 MIT），不用 librosa（没有重拍）和 madmom（Python 3.12+ 兼容问题，DBN 后处理有专利、限非商用）。CI 不装 torch，真实分析的集成测试（`beat/analyze.test.ts`）只在设置 `AM_TEST_BEAT_PYTHON` 时运行，改动分析脚本后要在本机跑一遍：

```bash
AM_TEST_BEAT_PYTHON=/path/to/venv/bin/python npx vitest run --root packages/engine src/beat -t RealBeatThis
```

镜头的 `beat` 块与 `song` 块并列（卡点插件的 `block.ts`），它的 `verifyInputs` 在渲染前、复用已有产物前与 `run-all` 里都会执行；启用了卡点却没有 `beat` 块的镜头直接拒绝。`scene_run_all` 渲染前经插件的整批检查（`beatCoverage`）核对全部镜头与网格、分镜计划一致。

## 平台封面

`publish.md` 的 `cover.images` 登记上传用的平台封面，校验在 `packages/engine/src/plugins/publishing/cover_images.ts`（随「发布」搬进内置插件），平台规格只有一个来源：`coverSpecs`（抖音 4:3 + 3:4、小红书 3:4 / 1:1 / 4:3、视频号 3:4 / 16:9、B 站与知乎 16:10，以及各平台 `ready` 前必须备齐的比例）。平台规则变了改这张表，制作提示词第十二阶段「平台封面」的表格要同步改，`gen.test.ts` 的「requires platform covers」钉着那一节。

尺寸以文件实测为准、声明值只用来对账：手填宽高与实际不符，说明封面改过却没回填，发布时上传的就不是记录里那张。短边下限 1080，所以 B 站常见的 1146×717 不合格（它本身也不是精确的 16:10），用 1920×1200。模板里写封面尺寸时用「宽 1440、高 1080」，不要写成 `1440×1080` 这类乘号形式——`gen.test.ts` 的「substitutes the canvas label」会把它当成写死的画幅拦下。

`safeRelative`（`validate/validate.ts`）解析路径时找最近一层已存在的上级目录（`resolveExisting`），不只看直接父目录：目标在还没建出来的子目录里（例如还没出图的 `covers/`）时，只解析父目录会因为 macOS 临时目录的 `/var` → `/private/var` 符号链接而误判成逃出项目。

## 公开树边界

`packages/engine/src/project/boundary.test.ts` 的「public tree contains no private or legacy content」扫描 `git ls-files --cached --others --exclude-standard`，命中即失败。禁止出现的路径包括 `transcription.srt`、`final.mp4`、`publish.md`、`scenes/`、`production/`、`auto-test/`、`article_to_motion/`、`pyproject.toml`、`am`。

调试产生的单片内容留在仓库外，不要靠 `.gitignore` 遮掩——未跟踪文件同样会被这个测试扫到。

## 操作表

am 的每一条制作步骤是一条操作（`packages/cli/src/ops/op.ts`）：

| 字段 | 约定 |
|---|---|
| `name` | 工具名，小写加下划线（`beat_import`），重复登记直接报错 |
| `cli` | 开发用命令行里的路径（`['beat', 'import']`），由 `ops/cli.ts` 的 `mountOps` 挂进 cobra 命令树；命令组的说明用 `defineGroup` |
| `params` | 具名参数：`type`（string / boolean / integer / number / strings / duration）、`description`、`default`、`required`；`positional` 只影响命令行（位置参数的次序），工具服务一律按名字传 |
| `summary` / `description` / `examples` | 按工具写法写，见「am 的工具服务」 |
| `scopes` | 缺省只给编排工具；`hyperframes` 另给渲染器 |
| `run(params, ctx)` | 文字写进 `ctx.out`（工具输出、命令行屏幕都是它），结构化结果 `return { data }`；取消看 `ctx.signal`，`ctx.unsafe` 是根命令的 `--unsafe` |

新增一步制作：在对应模块里 `defineOp` 一条（模块要在 `cli.ts` 里 import，登记靠加载时的副作用），写好说明、参数与至少一个例子；工具、`tool_help`、客户端后端（`runStudioOp`）与开发用命令行自动都有。内置插件的操作在它的 `apply` 里 `ctx.op(...)`（字段与 `Op` 相同，可另写对话里的说法 `verb`），命令组用 `ctx.opGroup(...)`，由 `plugin_ops.ts` 照旧 `defineOp` / `defineGroup`。多条操作共用的参数（`project_root`、`timeout`）用 `ops/common.ts`（内置插件用 `@am/engine/opkit`，同一份）。

## am 的工具服务（MCP）

客户端里的编排工具与渲染器**只经 MCP 调用 am**：`am studio tools-mcp --profile orchestrator|renderer --workdir <目录>`（`packages/cli/src/toolsmcp.ts`，隐藏命令）。以前 am 在它们的 PATH 里，缺信息时它们会 `which am`、`strings "$(which am)"` 反推格式（实测两次），每次都撞白名单、弹审批卡片打断用户。

| 约定 | 原因 |
|---|---|
| 工具就是操作表（`ops/op.ts`）里 `scopes` 含这一档位的操作：工具名、具名参数（`params`，含类型、缺省值、必填）、一句话说明（`summary`）、完整说明与例子（`description` / `examples`，按工具写法写）都是操作自己定义的。`setup`、`init` 与两个 `*-mcp` 不是操作；`cliOnly` 的参数不进工具 | 以后加操作自动有工具，不会漏；参数按名字传，agent 不用记位置参数的顺序 |
| 工具列表里只放一句话说明（工具 75 个，列表约 3.6 万字），完整说明、参数与例子由 `tool_help` 按需取；参数说明只留第一句 | 每次请求都要把工具定义塞进上下文。claude、codebuddy 会按需加载（ToolSearch / DeferExecuteTool），opencode 经它的代码执行工具调 |
| `hyperframes` 单独一个工具（子命令枚举 + `args`），只放行本机渲染与只读检查；`snapshot` 自动加 `--describe false`，`timeline` 只放行 `--json`。renderer 档位只有它加 `job_wait` / `job_cancel` / `tool_help` | 与渲染提示词的禁令同一份：远端渲染、改动已装技能、交互与遥测命令一律不给 |
| 每次调用先经 `normalizeParams` 校验参数（未知参数、类型不对、缺必填直接回给 agent，不起进程），再起一个执行进程 `am.cjs __op <名字> <参数 JSON>`（`ops/worker.ts`，协议在 `@am/engine/opworker`：先是操作写下的文字，最后一行是结果 JSON），最多等 `wait_seconds`（缺省 50）；没跑完返回任务号，`job_wait` 接着等，MCP 进程退出时整组结束子进程。结果的 `data` 既附在文字后面（「结果：」一行），也放进 `structuredContent` | codex 的 MCP 调用默认 60 秒超时，而渲染、拼接动辄几分钟到几小时；单独的进程才能整组取消，崩了也不拖垮服务 |
| 执行进程经 `toolsmcp.opCommand`（`toolpath.nodeCommand`）起，客户端里补回 `ELECTRON_RUN_AS_NODE=1`；不要直接 `spawn(process.execPath, …, { env: process.env })` | `main.ts` 一启动就删掉这个变量（不能漏给 agent），照抄 `process.env` 起的是一个完整的 Electron 应用：操作跑完、结果打印了，进程却永远不退出，工具服务每次都报「还在运行」直到超时。只在客户端里出现，CI 的 Node 下复现不了（2026-11 实测，当时被误当成稿子里 `\#` 让 `align_text` 卡死），`toolsmcp.test.ts` 的「op worker command」钉着 |
| 挂法（`tools.ts`）：claude / qoder / codebuddy 用 `--mcp-config`（claude 与审批服务合在一份，放在 `--verbose` 前面免得吞掉提示词），claude 系 `--settings` 放行 `mcp__am`、拒绝 `Bash(am:*)`，qoder 加 `--allowed-tools mcp__am`；ACP（codebuddy、opencode 在客户端里）走 `session/new` 的 `mcpServers`；codex app-server 走 `thread/start` 的 `config.mcp_servers`，exec 走 `-c mcp_servers.am.*`；opencode run 走 `OPENCODE_CONFIG_CONTENT` 的 `mcp`，并且**必须** `--standalone` | opencode run 默认连后台常驻服务，这一次给的配置（MCP、模型）全被忽略（2.1.0 实测）。codex 在 untrusted 策略下给每次 MCP 调用发 `mcpServer/elicitation/request`，`codexapp.ts` 对 am 服务直接同意，别的服务照常问用户 |
| 服务的环境只挑 am 自己要的变量（`tools.amToolsServer`：`AM_*`、`HYPERFRAMES_*`、记忆与配置键、PATH、HOME……），不整份传 | MCP 配置会出现在命令行里，不安全模式下子进程环境里还有凭据 |
| agent 找不到能用的 am：`envutil.addToolsLocation` 把 am setup 的工具目录加在 PATH 末尾，最前面放一个只有 `am` 的目录（`agentBinDir`，`<数据目录>/am/agent-bin`，测试经 `AM_AGENT_BIN_DIR` 指到临时目录），那个 am 只打一句「请用工具服务」并以 127 退出；`orchestratorBaseCommands` 与 `rendererAccess` 都不含 am。**不要把有 am 的目录从 PATH 里拿掉** | 两边都靠白名单的话，换一家 CLI 就漏。拿掉目录试过：以前装 am 启动脚本的 `~/.local/bin` 里还有 claude，整个目录没了就报「缺少必需工具：claude」（实测） |
| 提示词、操作的说明与输出、引擎报错里的下一步都按工具写法写（`请重新运行 beat_cues()`），`toolsmcp.test.ts` 的「writes every description and example as tool calls」查每条操作的说明里没有 `am <命令>`、例子调的是它自己、参数名都存在。没有对应操作的 `am setup`、`am init`、`am run` 不写进说明与提示，改说工具准备页、新建项目。客户端显示报错时经 `forUser`（`apps/desktop/src/renderer/api.ts`）去掉这些给 agent 的下一步 | agent 拿到什么就照着调什么：报错里写 `am beat cues`，它就会去终端里找 am；用户则不会去调工具 |

改了任何一家挂 MCP 的方式，在本机用真实 CLI 跑一遍（答案放在 agent 读不到的 `.env` 里，答对说明真的调了工具）：

```bash
npm run build -w @am/cli
AM_TEST_TOOLS_MCP=claude,codex,qoder,codebuddy,opencode npx vitest run --root packages/engine src/agentrun -t RealToolsMCP
```

opencode 默认模型不可用时加 `AM_TEST_OPENCODE_MODEL`。

## 桌面客户端

`apps/desktop` 是唯一的界面：对话驱动的本地工作台，仿 OpenDesign。主进程（`src/main/`）在项目目录里启动编排工具，把 `packages/engine/src/agentrun` 的统一事件经 SSE 推给界面（`src/renderer/`，React 19），多轮续接同一个 CLI 会话。「开始制作」与 `am run` 共用 `project.runPrompt`。界面与文档里仍把这套工作台叫 Studio，后端在 `packages/engine/src/studio`。

### 外壳

| 约定 | 原因 |
|---|---|
| 客户端在 `apps/desktop`（npm workspaces，根目录 `package.json`）：`src/main` 是 Electron 主进程，`src/renderer` 是 React 19 界面 | 一个 workspace 一个交付物，引擎与命令行各自独立构建 |
| 界面从自定义协议 `am://app/` 加载，界面里的 `/api/…`、`EventSource`、媒体 `src`、预览 iframe、上传都落到主进程的 `handleRequest`（`src/main/main.ts`） | 界面代码按普通网页写请求，不用为 Electron 改一行；接口名就是后端路由名 |
| `/api`、`/preview` 由进程内的后端处理（`@am/engine/studio` 的 `Server.handle(Request)`）；它的写任务与编排工具调用的 `am` 是 `userData/bin/am` 这份私有 shim（`AM_SELF` 同指它）；退出前 `Server.shutdown()` 取消进行中的轮次与任务 | 不依赖用户是否安装了命令行、也不会调到 `~/.local/bin` 里别的版本；编排工具与子命令各成进程组，不显式取消会在客户端退出后继续跑 |
| am 是打进资源目录的 `cli/am.cjs`，由一段 shim（`src/main/clishim.ts` 的 `shimScript`，写在 `userData/bin/am`）以 `ELECTRON_RUN_AS_NODE=1` 用客户端自带的 Electron 运行，同时设 `AM_ASSETS_DIR`、`AM_BROWSER`、`AM_NPM_CLI`。**没有「安装命令行工具」**：命令行不对外，以前装到 `~/.local/bin/am` 的旧 shim 由 `envutil.addToolsLocation` 放在 PATH 最前面的 am 遮住 | 用户不必另装 Node；agent 只经工具服务调用 am，找不到也不会去翻它 |
| 主进程启动时从登录 shell 读 PATH（`shellpath.ts`） | 从 Finder 启动的应用只有系统 PATH，编排工具、ffmpeg、asdf 的 node 全都找不到 |
| 顶栏就是标题栏：`.desktop .topbar` 可拖动窗口，按钮 `no-drag`；macOS 左侧留 88px 给红绿灯 | `titleBarStyle: hiddenInset` 去掉了系统标题栏 |
| 在 Finder 中显示（`renderer/reveal.ts` → preload 的 `am.reveal` → 主进程 `am:reveal`）：后端 `Server.revealPath` 只认项目里的路径（含符号链接）、`.env` 不选中、还没生成的文件退到最近一层存在的目录；项目文件夹用 `shell.openPath` 打开，其余 `showItemInFolder` 选中。入口：顶栏项目名旁的文件夹按钮、菜单「文件 → 在 Finder 中显示项目」（⌥⌘R）、镜头与文件的右键菜单、镜头「⋯」菜单、文件页、成片页、首页最近项目。e2e（`reveal.spec.mjs`）把主进程的 `shell` 两个函数换成记录 | 界面拿不到 Node 与 Electron 接口，只能经 IPC 请主进程做；不限定在项目里的话，界面里跑的合成页面就能让主进程去开任意路径。测试不能真的弹 Finder |
| 静态文件（`serveStatic`）只把不带扩展名的路径回落到 `index.html`，带扩展名找不到直接 404；按扩展名设 MIME，一律 `no-cache` | 缺失的脚本拿到一份 HTML，浏览器只报模块 MIME 错误，看不出真正原因 |
| 界面产物文件名固定（`assets/app.js`，见 `vite.config.mjs`），不带 hash；`apps/desktop/out/` 与 `packages/cli/dist/` 是构建产物，不提交 | 主进程按路径直接取文件；产物每次由 `npm run build` / `npm run dist` 现做，CI 与发布都从源码构建 |
| 根目录 `package-lock.json` 的 `resolved` 必须是 `registry.npmjs.org` | 用镜像装完依赖要把 `resolved` 换回官方源再提交，CI 访问不到国内镜像 |
| 发布没有签名证书（`apps/desktop/package.json` 的 `build.mac.identity` 是 `null`）：dmg 只能「右键 → 打开」放行 | 有 Apple 开发者账号后在发布流程里接签名与公证 |

### 后端（`packages/engine/src/studio`）

| 约定 | 原因 |
|---|---|
| 客户端自己不写项目文件；改动只来自一轮对话，或 `studioCommands`（`api_sessions.ts`）/ 镜头渲染这类直接跑 am 操作的按钮：`runStudioOp`（`tasks.ts`）按名字与参数起执行进程，不拼命令行 | 旧版自造过一套 Operation 类型，镜头动作、相机写进 `production/studio/*.json` 再注入渲染提示词，等于绕开项目文件的第二条编辑通道。不要再加回来：要改什么就让编排工具改项目文件 |
| 每轮前后各扫一遍项目（`scanTree`，`turns.ts`），差异即本轮改动，回退按快照恢复 | 编排工具改了哪些文件只有事后比对才知道，工具调用事件并不可靠（Bash 里也能写文件） |
| 回退时任一文件在本轮之后又变过，整体拒绝（`ConflictError`），不做部分回退 | 部分回退会留下一半新一半旧的项目，比不回退更难收拾 |
| 文本按 sha256 存进 `production/studio/blobs/`；媒体扩展名、含 NUL、超过 2 MB 的只记 stat，列出但不回退 | 渲染产物每轮存一份不现实，重渲染即可 |
| 项目级写锁（`Server.acquire` / `release`）：一轮对话与渲染、拼接、复查等写任务互斥 | 否则任务写的文件会被算进那一轮的改动，回退时误删 |
| 预先指定或从流里读到会话 id 立刻落盘；续接失败且没有任何产出时，带对话记录开新会话 | 进程中途崩了也能续接；CLI 会话过期是常态，不能让对话就此断掉 |
| 会话、事件（`<id>.events.jsonl`，SSE 的 id 就是 seq）、轮次记录都在项目的 `production/studio/` 下 | 状态跟着项目走，`am archive` 一起归档；客户端重启后进行中的轮次标成 `interrupted` |
| 编排工具与渲染工具按会话选（`SessionMeta.tool` / `renderer`，`sessions.ts`），默认取项目配置；客户端不改 `article-to-motion.conf`，选择经 `sessionConfig` 覆盖后由 `childEnvironment` 写进子进程的 `ORCHESTRATOR` / `RENDERER` | 环境变量优先于项目配置，编排工具在这一轮里调用的 `am scene run` 因此也用会话选的渲染工具。换编排工具时清掉 CLI 会话 id，下一轮按续接失败的路子带上对话记录开新会话 |
| 镜头列表（`discoverScenes`，`studio/scenes.ts`）同一个 id 只留一份：分镜计划 `dir` 指向的 → 项目根 `scenes/` 下的 → 层级浅的；`scenes.test.ts` 钉着 | 重做分镜时编排工具会把旧的一套挪进 `production/v1/scenes/` 留底，id 与新的一套相同；不去重时镜头列表出现两组，镜头页按 id 先找到旧的那份，换了风格也一直显示旧画面（2026-11 实测） |
| 项目路径一律用 `Server.currentProject()` 返回的（登记时已 realpath） | macOS 的 `/var` 是 `/private/var` 的链接，两种写法会被当成两个项目，锁和会话都对不上 |
| 上传的文件存进 `production/studio/uploads/`（`uploads.ts`），附件带 `upload: true`，提示词里只给路径和种类，由编排工具在这一轮里复制或转换到项目里；`.env` 拒收 | 客户端不写项目文件。上传落在不进快照的状态目录，文件真正进项目的那一步是某一轮的改动，照常能看差异、能回退 |
| 一轮进行中发的消息排队（`enqueueTurn`，事件 `queued` 带 `queue_id`），这一轮结束后合并成下一轮（`drainQueue`）；`DELETE …/queue/{id}` 移除（事件 `unqueued`），`POST …/queue/{id}/steer` 把它提到最前并停掉当前这一轮；按停止会清掉排队 | 各家 CLI 在非交互模式下都不能中途注入输入，只能排到下一轮。按停止多半是不想让后面的要求接着跑 |
| 渲染器此刻在做什么（`studio/activity.ts` 的 `/api/scenes/{id}/activity`，界面 `RenderActivity.tsx`）：把镜头目录的 `render-<id>.stream.jsonl` 用 `agentrun.Parser` 按偏移增量译成步骤（文件被换掉就从头读，半行留到下次）；对话里有镜头在渲染时输入框上方挂卡片，镜头页显示完整过程。「渲染中」以 `scene.run` 写的进行中标记 `render-<id>.live.json`（`scene/live.ts`，记 pid、渲染工具、开始时间，结束即删）为准、看进程在不在，没有标记就不算渲染中 | 编排工具调了渲染就只能等，聊天页只有一个转圈的工具调用；渲染器跑 `hyperframes render` 的几分钟里流日志不动，按静默判断会在最该显示进度时把镜头判成没在渲染 |
| 待办清单统一成 `agentrun` 的 `KindPlan`（claude 的 TodoWrite、codex 的 `todo_list`、opencode 的 `todowrite`），每条是完整清单；镜头的「渲染中」只看进行中标记（`sceneRendering`，`scenes.ts`） | 整片制作要跑几个小时，只看一串工具调用不知道做到哪了。新增一家 CLI 时它的待办工具也要译成 plan 事件 |
| 建项目只走 `packages/engine/src/projectinit`：`am init` 与客户端的新建（`Server.createAPI`）共用 `create`（讲解形式、叙事模式、cast 骨架）与 `installSkills`（HyperFrames 官方技能）。客户端新建后在后台从本机缓存拷技能（`studio/skills.ts`，不联网；缓存是 `am setup` 准备的前置资源，缺了显示指向 `am setup` 的错误），顶栏在缺技能时给「安装」，安装中显示进度条（`hyperframes.Options.progress`，拷贝按技能计数；`am setup` 下载时克隆让 git `--progress` 并解析百分比，在终端里用一行回车刷新）；端到端测试用 `AM_STUDIO_SKIP_SKILL_INSTALL=1` 跳过 | 两边各写一份时界面漏了讲解形式、多角色对话，也不装官方技能，渲染器拿不到 hyperframes 入口技能 |
| `/api/files` 与 `/preview/scenes/` 经 `containedPath`（`sessions.ts`）解析（含符号链接），`.env` 一律不读 | 这两个接口按路径读文件，而预览 iframe 里跑的是渲染器写出的合成页面、与界面同在 `am://app/` 下；不限定在项目内的话，一段生成的 HTML 就能读到项目外的文件与 `.env` |
| 风格只展示整片风格（`studio/filmstyle.ts`）：首页、新建对话框、「风格」页与镜头页共用 `FilmStyles.tsx`（首页、换风格、添加风格用整体弹窗 `FilmStyleDialog`）；`/api/styles` 只给新建对话框的画幅与做法（旧版内置风格已删除）。装、换、添加、去掉都经 `am film-style` 写任务（`startFilmStyleTask` / `startAddFilmStyleTask`）；「风格」页列出默认风格与其他风格及各自在用的镜头，镜头页显示本镜头的风格，新建时 `/api/projects/create` 收 `film_style` 并返回 `film_style_task`，开机画面跟这个任务；顶栏显示的是 `metadata.film_style` | 旧风格 10 月 20 日起已不影响渲染，留在选择器里只会让人选一个不起作用的东西。风格改的是项目文件，走写任务才不会和一轮对话的快照打架 |
| 客户端不下载风格来源与海报（前置资源，`am setup` 准备）：来源没准备好时 `/api/film-styles` 的那个来源报 `ready: false` 并附指向 `am setup` 的说明，界面显示分类色占位块；`/api/film-styles/{来源}/{目录名}/poster.jpg` 默认给 480 宽的缩略图（`posterThumbWidth`，缓存在 `<风格根目录>/.thumbs/<来源>/`），`?size=full` 给原图 | 原图一张 1920×1080，菜单一屏几十张会卡 |
| 编排工具与界面互通（`studio/view.ts`、`packages/engine/src/studioview`）：编排工具调用 `studio_show` 工具（`am studio show <页面> [对象] [--note …]`）把界面切到要用户看的那一页——请求写进这一轮的收件目录（`AM_STUDIO_INBOX`，在 `production/studio/inbox/<轮次>/`，`runTurn` 经子进程环境传下去），后端每 300 毫秒取一次、译成 `view` 事件，界面只执行刚发生的（15 秒内，重放历史不切页），回复下面留一个可点的「↗ 页面」。反方向，界面每条消息带 `view`（当前页、镜头、文件），`describeView` 把它写进这一轮的提示词，不进对话显示。约定写在 `studioInteraction`（`viewInteraction`），宿主的页面表 `ViewPages` 加内置插件登记的页面（`viewPages()`）与 `Preview.tsx` 的 `tabs` 加 `pageViews.tsx` 一一对应。要看的文件有专门页面时（口播稿、分镜计划与处理方案、成片与配音合成版、发布信息、镜头目录里的文件），`validateViewRequest` 经 `dedicatedPage` 改切到那一页，不开文件页。编排每轮结束前调用 `studio_step`（只标步骤、不切页，请求里 `page` 为空、`step` 取 `stepIDs()`：宿主的步骤加内置插件登记的）标出整片制作在哪一步，后端记进 `production/studio/step.json`（`writeStepMark`），`/api/state` 的 `step` / `step_marked`（`stepOf`：标记比项目里最新的产物新时用标记，否则取制作路线当前一站所在的步骤）给顶栏：做过的步骤编号换成 ✓，当前一步是黄铜色小章 | 走文件不走 HTTP：codex 沙箱默认断网，项目目录总是可写，编排工具也不必知道客户端的任何地址。不在客户端里（`am run`）时 `am studio show` 静默跳过、页面写错照样报错，编排工具照提示词调用不会失败。实测 claude 在安全模式下能直接调用并切页 |
| 口播稿页（`studio/script.ts` 的 `/api/script`、`Script.tsx`）排在标签第一位：读 `production/script-final.md`，经 `align` 的 `view`（`align/view.ts`）排成标题、段落、读法（ruby）与受保护短语，附字数、估算时长（每秒 4.5 字）、`voice.srt` 的实际配音时长与 `script-change-log.md`；没有终稿时原样显示原稿，标记写错时给出位置并显示原文。有终稿、还没有镜头时自动切到这一页，稿子改过没看过时标签打点，聊天里点到终稿也打开这一页。「确认，开始配音」「提修改意见」「针对所选提意见」都只是往对话里发话或填输入框 | 稿件审核关卡要用户看稿，以前只能在聊天里翻；视图与 `am align` 共用一份解析器，读法与短语和配音、对齐看到的是同一份。客户端自己不改稿 |
| 制作路线（`studio/progress.ts` 的 `/api/progress`，`Progress.tsx`）：把制作拆成十几站（口播：盘点素材 → 口播稿 → 稿件审核 → 配音 → 配音审核 → 字幕时间轴 → 整片风格（可选）→ 拆分镜头 → 分镜审核 → 渲染 → 画面验收 → 拼接 → 配乐混音 → 复查 → 试听确认 → 发布；卡点项目换成故事、音乐、节拍那几站），按顶栏五步分组。每站做没做只看产物，上游产物比下游新时下游标「上游改过」（只用在由工具从上游生成的产物上：稿子比配音新不算，编排常在配音后改读法标记）；没留产物但后面已经做了的算跳过。审核关卡另记用户确认：界面的确认按钮（口播稿页、分镜页、路线页）先 `POST /api/progress/gates/{关卡}` 写 `production/studio/gates.json`（记下绑定文件的摘要，大文件记 stat），文件之后变了就是「确认后又改过」；没有记录但下游已做的算「已经过了」；试听确认读 `approval.json`，节拍读确认过的网格。「做了什么」读轮次记录（按修改时间缓存摘要），改过的文件经 `stationOfPath` 归站；同一份归站结果给对话里每轮结尾的「→ 站名」。入口：顶栏步骤左边的「路线」、对话顶上一行「现在 · 某站 · 等你确认 / AI 在做」，点轮次跳回对话那一轮。`studio_show progress` 也能打开 | 顶栏五步太粗，看不出做过什么、现在卡在哪、在等谁；不让编排汇报进度，是因为它会忘、会标错 |
| 分镜页（`studio/storyboard.ts` 的 `/api/storyboard`、`Storyboard.tsx`）是第二步，排在口播稿与镜头之间：读 `production/scene-plan.json`（经 `scene.parseTimingPlan`）、`treatment.md` 与每个镜头目录的 `scene.json`（口播 `text`、跑过 cues 才有的时长）和 `prompt.md`，按章节列出镜头的一句话说明、视觉角色、交接手法（`device_label` 取 `handoffGuide` 冒号前的中文名）与完整画面描述；计划缺失或写坏时按已有镜头目录列。计划里的 `dir` 跑出项目的一律不读。镜头页右栏的 `SceneBrief` 显示同一份说明。制作提示词第六阶段的「分镜审核关卡」让编排在 `scene_cues()` 之后、任何渲染之前 `studio_show storyboard` 并停下等确认（`gen.test.ts` 的「stops for storyboard review before rendering」）；「确认，开始渲染」只是往对话里发话。有分镜计划、镜头都没渲染、分镜有没看过的改动时，点镜头步骤会先落到分镜页 | 分镜和每个镜头的画面描述在渲染前就写好了，以前界面上看不到、编排也不停：用户第一次看到画面时每个镜头都已经渲染过一遍，发现想法不对只能整批重做 |
| 节拍页（`Beat.tsx`，卡点插件登记的页面与 `/api/beat`，界面经 `pageViews.tsx` 对上组件，组件自己读 `/api/beat`）在卡点项目里代替口播稿排第一步：顶栏的步骤、第一步、用不上的页与没有镜头时落在哪一页都来自 `/api/state` 的 `flow`（`studio/progress.ts` 的 `flowView`，按流程声明 `first_page` / `land_first` 算），界面里没有按片型写死的分支。页头六步（故事与文案 → 导入音乐 → 分析节拍 → 试听确认 → 分镜计划 → 做镜头）各自判断完成与否，下面一块「接下来」用一句话说清下一步、按钮把它交给对话；故事与文案读 `production/beat/story.md`（卡点流程的第二阶段让编排工具开工先写它，`flowprompts.test.ts` 的「tells the beat story before the music (beat)」钉着）（`BeatStoryFile`），还在定故事时展开全文、之后收成标题加梗概。其下画波形、每拍刻度、重拍与小节号、分镜计划的镜头条，播放时大字数拍；拍数与多数小节不同的小节标黄。音乐用 WebAudio 解码播放，咔嗒按当前网格在同一个 `AudioContext` 里现合成，所以在页面上换「每小节几拍 / 重拍是第几拍」（或播放中按 T 敲重拍）立刻能听到；只有动过这两个控件才进入预览，原网格（手改、拼接过的常常不规整）照原样显示。写回只走 `beat.regrid` / `beat.confirm` 两个网页命令（插件登记的写任务），客户端不改网格；`/api/beat` 不哈希音乐（每次刷新都要读），网格与音乐不符由 `beat_confirm` 拦下 | 卡点项目原先跑的是口播流程的制作提示词，没有任何卡点步骤，用户在听音乐之前不知道片子讲什么、接下来要做什么；以前也只有一条横幅放 `grid-click.wav`，重拍错位要回终端跑 `am beat regrid` 再重听整条试听轨，小节、拍数与切点只能看 `am beat bars` 的文字表 |
| 发布页（`Publish.tsx`）不贴 `publish.md` 原文：`/api/publish`（发布插件登记的接口，`plugins/publishing/api.ts`）经 `readPublish` 只解析 frontmatter（不校验）返回 `data`，页面按「状态 → 可复制的标题 / 简介 / 话题 → 登记的封面 → 还剩的人工检查」排，规格与证据收进折叠。客户端里任何地方都不显示它的 Markdown 原文：接口不回传正文，解析失败只给原因、让编排工具修；聊天、文件树、`am studio show file publish.md` 点到它都切到发布页（`app.tsx` 的 `pageForFile`，口播稿同理）。合格与否仍只看「发布校验」 | `publish.md` 是 `am run` 下给人看的发布助手；在客户端里发布页就是那份助手，再贴原文只是把几十行校验字段和重复的表格摆到用户面前 |
| 模型（`ORCHESTRATOR_MODEL` / `RENDERER_MODEL`，`Config.orchestratorModel` / `rendererModel`）：空是那家工具自己的默认。`config.load` 只在「写模型的那一层往下看，工具就是现在这一家」时用它（`modelFor`）；在同一层换工具时 `writeGlobal` 与 `config_set` 把那一层的模型一起清掉；`childEnvironment` 有模型才写、没有就删，`amToolsServer` 放行这两个键。会话也能选（`SessionMeta.model` / `renderer_model`，空串是跟随设置，换工具不给模型时回到跟随设置；同一家换模型不清 CLI 会话 id）。各家的参数在 `tools.modelArgs`（codex 用 `-c model=…`，exec 与 resume 都认；app-server 走 `thread/start` / `thread/resume` 的 `model`；opencode acp 没有参数，经 `OPENCODE_CONFIG_CONTENT` 的 `model`，`acp.ts` 的 `ensureModel` 开会话后按 `configOptions` / `models` 再核对一次）。下拉框的选项来自工具自己（`tools.modelListCommand` / `parseModelList`，`/api/agents/{工具}/models` 缓存 10 分钟），claude 没有列模型的命令，给帮助里写的别名；列不出时仍能手填。镜头 `scene.json` 换了渲染工具时不用设置里的渲染模型（`config.rendererModelFor`），记忆召回同样按它取模型 | 模型名只对一家工具有意义，opus 交给 codex 会让整轮失败；不跟着工具走的话，在设置里换一次工具就会撞上。各家能用的模型随登录账号与服务商变，am 维护一份表只会过期 |
| 设置页（`Settings.tsx`，后端 `studio/settings.ts`，顶栏齿轮或 ⌘,）管「什么用什么」：`config.GlobalKeys`（编排、渲染及各自的模型、配音、对齐、并发、记忆、自动批准）。全局值写用户级的 `settings.conf`（`config/global.ts`，`AM_SETTINGS_FILE` 覆盖，`childEnvironment` 显式传下去），在进程里直接写；「这个项目」一栏经 `config_set` 写任务改项目的 `article-to-motion.conf`（`config_set` 的 scopes 只有 cli，编排工具没有这个工具）。取值顺序：环境变量 > 项目 `.env` > 项目 conf > 全局设置 > `GlobalDefaults`；新项目模板里这几项留空，所以跟随全局。测试的 vitest setup 与 e2e fixtures 都把 `AM_SETTINGS_FILE` 指到临时文件 | 以前这几项只能手改每个项目的 conf，客户端里改不了配音、对齐与并发；全局为准、项目可单独改是用户选的方案。设置项被环境变量或 `.env` 盖住时页面照实说，不假装改了有用 |
| 前置资源的安装页（`studio/setup.ts` 的 `/api/setup`、`/api/setup/run`、`/api/setup/cancel`，`SetupGuide.tsx`）：清单与 `am setup` 同一份（`prereqs`，配音与对齐工具按当前项目配置挑）。界面把几项技术资源合成用户听得懂的「摄制组」——画面（技能 + CLI + 浏览器）、剪辑（ffmpeg）、配音、字幕——每组一张卡片、图标外一圈进度环；工具名、版本、路径只在悬停提示里，日志与终端命令收进「高级」；节拍环境、风格来源动辄上 GB，作为「以后可能用到」单独点装。安装在后台跑，同一时间一份，进度经 GET 轮询（安装中每秒一次）；暂停记成「已取消」，界面显示为暂停而不是失败。不占项目写锁（只写用户级目录）。必需项缺时「开始制作」不可点。`AM_STUDIO_SKIP_SKILL_INSTALL=1` 时当作全部就绪 | 以前只给一条要复制到终端的命令，客户端用户多半不会开终端，装好应用却用不了；列一排工具名用户看不懂在装什么 |

### 界面（`apps/desktop/src/renderer`）

| 约定 | 原因 |
|---|---|
| 编排工具要用户拍板时在回复末尾写 ` ```choices ` 代码块，界面渲染成按钮（`components/chat/model.ts` 的 `parseChoices`），点了把那一行原样发出；约定写在 `studioInteraction`，聊天开场、整片制作第一轮、续接失败补发时都带上 | 没有结构化的「提问」事件，这是三家都能做到的最小约定；改格式要两边一起改 |
| Markdown 渲染（`components/chat/Markdown.tsx`）用 marked（GFM：表格、任务列表、删除线、嵌套列表、自动链接）加 DOMPurify 清洗，再做对话里的处理：标题降两级、外链交给系统浏览器、项目文件路径（链接或行内代码）可点开文件页（`MarkdownContext` 由 `app.tsx` 提供文件树）、代码块带语言与复制、表格可横向滚动、图片只读项目文件或外链。另加两条内联规则 `cjkStrong` / `cjkDel`：CommonMark 的分隔符规则按英文标点设计，`**字体还没下载。**下载` 这种收尾符号前是中文标点、后面紧跟汉字的写法不算粗体，而中文回复里到处是 | 原来的手写解析只认段落、列表、代码与粗体，表格（编排工具最常用的对比格式）、嵌套列表都原样显示；回复里的 HTML 一律经 DOMPurify，事件属性与 `javascript:` 链接进不了页面，e2e 的「renders GitHub-flavored markdown safely」专门测这条 |
| 回复里提到的音频、图片、视频直接在对话里放（`Chat.tsx` 的 `MediaStrip`，查找在 `model.ts` 的 `findMedia`）：按项目文件树认，写全路径或只写文件名都行（同名多个时优先回复里提到过的目录），音频与视频给播放器、图片给缩略图，点文件名打开文件页；`studioInteraction` 要求编排工具写出项目内的相对路径 | 音色试听、配音片段、封面候选原来只是一串文件名，用户得自己去文件树里找；编排工具常把目录写在前文、表格里只写文件名，所以按文件名也要能认 |
| 推荐整片风格时写 ` ```film-styles ` 代码块，每行「来源/目录名 理由」（约定同在 `studioInteraction`）；界面按风格目录渲染成海报卡片（`StylePicks`，海报走 `/api/film-styles/…/poster.jpg`），「用这个风格」把「整片风格用「中文名」（标识）」作为下一条消息发出，由编排工具运行 `am film-style use`。没有代码块时，回复里写到的已知风格标识也显示海报（`parseStylePicks`）——制作提示词只要求「写明中文名、标识」，`am run` 下同一份提示词也得能用 | 用户选画风要看图，光看名字选不出来；装风格仍由编排工具做，客户端不绕过对话改项目文件 |
| 对话是主栏，画面是按需打开的面板（`app.tsx` 的 `panelOpen` / `showTab`）：工作区里对话占满，正文居中限宽 760px（`chat.css` 的 `--gutter`）；页面（口播稿、镜头、成片……）放在右侧面板里，默认收起成一条镜头进度细栏（`PanelRail`）。用户点步骤、更多页面、收起栏里的镜头、回复里的文件或「↗ 页面」，以及编排工具 `studio_show`，都经 `showTab` 打开面板；稿件审核、卡点这类自动切页只换页、不开面板。× 、Esc（输入框里、圈选与菜单开着时除外）与菜单「显示或收起画面」（⌘\）收起。面板宽度可拖动、双击复原，按「看画面 / 读文字」两类分别记在 localStorage，对话栏最窄 420px；1180px 以下面板变成盖在对话上的抽屉。面板收起时 `view.page` 为空，提示词里不写「用户开着哪一页」。e2e 的 `openProject` 只等收起栏，要看页面的用例先点步骤，`layout.spec.mjs` 钉着这些行为 | 用户整场制作的操作都在对话里，原先预览占 `1fr`、对话被限在 360–400px 的右栏，窄屏还被挤到画面下面；真正要看画面的只有审稿、看镜头、看成片、发布这几个节点 |
| 已经答过的选项收起（`Chat.tsx` 的 `AnsweredOptions`）：这一轮之后用户发的第一条消息与某个选项逐字相同（风格推荐按 `stylePickMessage`）就只留那一个，其余收进「另外 n 个选项」；自己打字回复时整组收成一行 | 历史里一排排不能再点的按钮只占地方 |
| 聊天面板的结构照 OpenDesign：一轮的过程（思考、工具、中间的话）收进一个折叠块，进行中展开、结束收起，结尾的话才是回复；进度是底部浮动的药丸，排队的消息叠在输入框上方。事件到界面的整理只在 `components/chat/model.ts`（`buildBlocks`） | 一轮动辄几十次工具调用，平铺会把回复淹没；整理逻辑放一处，渲染组件只管画 |
| 没有打开项目、或点左上角时显示首页（`Home.tsx`，照 OpenDesign 首页）：在输入框说要做什么、拖进文章，发送后进入「开机」画面（`Creation.tsx`）：场记板、按画幅的监视器、四段片段的时间线，依次 `projects/create` → `uploads` → 等 `/api/skills` 装完 → `production/start`（带 `attachments`），播放头按真实进度走，装技能可以「不等了」转后台，最后打板推进到项目。先装技能再开工，编排工具一开工就有 hyperframes 技能。项目名由第一句话或文件名推出，重名加 `-2`；「保存到」默认取上次新建时的父目录（项目登记里的 `last_parent`），最近项目带阶段与出片摘要（`ProjectSummary`） | 从一句话到开始制作不该要先填一张表；已经不存在的项目不混进最近列表，给一键清理 |
| 输入框的 `@` 与 `/`（`components/chat/complete.ts`）：`@` 在任意位置补全口播稿、镜头与项目文件，文字里留 `@编号` / `@路径`，发送时 `mentionAttachments` 把认得的 `@` 变成引用（与右键引用同一种附件）；`/` 只在开头，补全 Studio 命令：新对话、停止、开始制作、切页、渲染 / 校验镜头、拼接、复查在界面里直接执行（走已有接口，不经编排工具），确认口播稿、重做镜头、记偏好换成一句话交给编排工具。带参数的命令先选命令再选参数；认不出的 `/xxx` 照常发出 | 各家 CLI 都用 `@` 指文件、`/` 调命令，用户会照着习惯打；`@` 只留在文字里的话编排工具未必去读，变成引用才有明确的出处。新增命令改 `slashCommands` 与 `Chat.tsx` 的 `runCommand` 两处 |
| 右键菜单（`ContextMenu.tsx`）：工作台里右键按点到的东西给动作——选中的文字、口播稿的一段、镜头、文件树的文件、编排工具的回复，都能「引用到对话」或「引用并说哪里不满意」；输入框里与按住 Shift 时不拦截右键。页面元素用 `data-ctx-source` / `data-ctx-label` / `data-ctx-para` / `data-ctx-scene` / `data-ctx-file`（`data-ctx-whole` 表示没选文字时可整块引用）声明自己是什么，新页面要能右键引用就加这几个属性。引用是附件的一种（后端 `Attachment` 的 `quote` / `label` / `ref`），`attachmentText`（`studio/sessions.ts`）写成「用户引用的内容」一节，界面的 `splitAttachmentText`（`model.ts`）按这个标题把它从用户消息里拆出来，两边改一处要改另一处；引用上限 `maxQuoteRunes`，出处必须在项目里 | 用户对稿子、镜头不满意时，原来只能自己在输入框里描述是哪一段；引用让编排工具拿到原文与出处，不用猜。引用里去掉读法（ruby）与只读不显示的部分，用户看到什么就引用什么 |
| 视觉是「放映室」：`styles.css` 的 `:root` 是唯一的色板（暖黑底、象牙白字、只有一种黄铜色 `--accent`），标题用 `--serif`（本机宋体栈）、数字与小标签用 `--mono`；按钮默认是胶囊形描边。外框没有左侧栏：顶栏中间是五个编号步骤（`Preview.tsx` 的 `stepTabs`），其余页面小字列在右侧，文件树只在「文件」页；作品在画面面板里是主角，但工作区的主栏是对话（见「对话是主栏」那一条）。镜头页只留画面、名字与「重新渲染」，其余动作收进「⋯」菜单；时间线每格是那个镜头的画面，只在镜头、合成、成片三页出现。成片页与镜头页同版式（左画面、右信息），右栏是复查摘要（问题数、帧数、响度、真峰，读 `review.json` 的 `problems`）与「去发布」；口播稿是居中一栏的宋体文稿、段落编号挂在页边（`.para-no`，`readableText` 引用时去掉）；发布页封面在左（竖版在前）、文案在右 | 用户要「少即是多」和高级感：作品是主角，界面往后退。新页面沿用这套色板与字体，不要再引入第二种强调色 |
| 新组件的样式放进各自的 css（`chat.css`、`home.css`、`creation.css` 等），选择器挂在组件根类下（`.chat …`、`.home …`） | 全局 `styles.css` 里已有 `.legend`、`.style-thumb` 这类通用名，同名类后写的覆盖先写的，撞过两次：时间线图例被挤成一条、风格缩略图撑满整个菜单 |
| `src/renderer/types.ts` 与后端 JSON 字段一一对应 | 前后端之间没有生成代码，改字段两边一起改 |

### 端到端测试

`apps/desktop/e2e/` 用 Playwright 的 Electron 模式启动构建好的客户端（`playwright.config.mjs`、`e2e/fixtures.mjs`）。每个用例一套临时目录：HOME、userData（`AM_DESKTOP_USER_DATA`）、项目登记（`AM_STUDIO_CONFIG`）、记忆库（`AM_MEMORY_DIR`），并设 `AM_STUDIO_SKIP_SKILL_INSTALL=1` 与 `AM_DESKTOP_BACKGROUND=1`（客户端以辅助程序运行：不进 Dock、不激活、窗口不显示、系统通知默认不弹，见 `main.ts`；测通知的用例自己把 `Notification.prototype.show` 换成记录。否则每个用例都弹到最前面抢走开发者的焦点）——记忆默认打开，不设 `AM_MEMORY_DIR` 的话每次跑 e2e 都往用户真实记忆库写经历，记忆面板曾被几百条 `am-studio-e2e-*` 淹没。

`apps/desktop/e2e/fake-bin/claude` 是 e2e 用的假编排工具（同目录的 `codex` 只用来显示为「已安装」，被调用时直接失败），`fixtures.mjs` 把它放在 PATH 最前面，并设 `AM_DESKTOP_KEEP_PATH=1` 让主进程不再把登录 shell 的 PATH 并到前面（否则真实的 claude 会被先找到）；提示词里带「慢慢来」时它只回报会话然后挂起，供取消测试使用。单元测试里的假工具同理，子进程环境按安全模式白名单构造，测试开关要经 `AM_PASSTHROUGH_ENV` 透传。

## 新增一个 AI CLI

工具矩阵散落在六个文件，加一个工具必须九处同步改，漏一处会在运行期才炸（导演 `director` 不是外部 CLI，它的约定见「导演（自带的编排工具）」）：

| 位置 | 作用 |
|---|---|
| `packages/engine/src/tools/tools.ts` `rendererInvocation` | 单镜头渲染的命令行与非交互权限模式；该模式若拦截 Bash，要把 `RendererAccess` 译成该工具的放行配置（claude 用 `--settings`） |
| `packages/engine/src/tools/tools.ts` `orchestratorInvocation` | 编排调用的命令行、prompt 传递方式（stdin 还是参数）、结构化输出参数、会话参数（新会话 / 续接），以及把 `OrchestratorAccess` 译成该工具的白名单 |
| `packages/engine/src/tools/tools.ts` `presetSessionID` | 该工具能否由调用方预先指定新会话 id；不能的（codex、opencode）要从输出流的第一条事件里读 |
| `packages/engine/src/tools/tools.ts` `ValidTools` | `ORCHESTRATOR` / `RENDERER`（`config.load`）与 `scene.json` 的 `renderer` 字段（`scene.load`）都按这张表校验 |
| `packages/engine/src/agentrun/parse.ts` | 把该工具的结构化流译成统一事件；先录一份真实的两轮输出放进 `packages/engine/src/agentrun/testdata/`，`parse.test.ts` 的「recorded streams」加一行 |
| `packages/engine/src/scene/skills.ts` `rendererSkillDirs` | 该工具的技能目录约定（家目录级与项目级） |
| `packages/engine/src/studio/agents.ts` `agentOrder` | 客户端工具选择里的展示名与顺序，`agents.test.ts` 的「agentOrder covers valid tools」守着与 `ValidTools` 一致 |
| `packages/engine/src/tools/tools.ts` `modelArgs`、`packages/engine/src/tools/modellist.ts` | 指定模型的参数（双向协议另见 `interactiveInvocation`、`codexapp.ts`）与列出可选模型的命令及其输出解析，`modellist.test.ts` 加一行 |
| `tools.ts` 的 `rendererInvocation` / `orchestratorInvocation`（或 `acp.ts`、`codexapp.ts`） | 挂上 am 的工具服务（见「am 的工具服务」），并放行它的工具；`toolsmcp.integration.test.ts` 的 RealToolsMCP 加上这一家 |

同时更新 `assets/shared/article-to-motion.conf`、`assets/shared/.env.example`、`README.md`、`README.en.md` 里的可选值注释。

安全模式的权限模式必须实测能跑通渲染命令。claude 的 `acceptEdits` 只自动批准文件编辑、拦下所有 Bash，而 `-p` 下没人批准，渲染器会执行不了 `am hyperframes render`；`scene.rendererAccess` 列出要放行的最小命令集（`am hyperframes`、`ls`、`ffprobe`）与技能目录读取，`.env` 始终禁读。

客户端里的 claude 与 qoder 编排工具遇到白名单外的调用时不直接拒绝，而是问界面上的用户：`orchestratorInvocation` 给它们加 `--mcp-config`（`am studio permission-mcp`，`OrchestratorOptions.permissionPrompt`）与 `--permission-prompt-tool mcp__am_studio__ask`（claude 还要 `--permission-prompts host`；qoder 的这个参数帮助里没列，实测可用）；审批服务把请求写进这一轮收件目录的 `permissions/` 子目录（`studioview/permissions.ts`），后端轮询到就发 `permission` 事件、界面在输入框上方弹卡片，答复经 `POST /api/sessions/{id}/permissions/{请求}` 写回（`studio/permissions.ts`），这一轮结束时没答的一律答成 `expired`。「以后都允许」把命令前缀记进项目的 `production/studio/permissions.json`，下一轮并进白名单。设置里的「自动批准」（`AUTO_APPROVE`，全局或这个项目，卡片上的「以后都不用问」打开全局的）开着时，`pollPermissions` 收到请求直接答 allow、不发 permission 事件，只在这一轮里发一条「已自动允许：…」的 notice；五家的审批都落到同一个收件目录，所以只此一处。它只回答「要不要问」，工具自己的沙箱照旧（用户嫌审批太多次）。codebuddy 不认 `--permission-prompt-tool`、codex exec 不能中途审批、opencode 的 `run` 根本不拦命令，所以客户端里（`agentrun.Spec.ask` 给了、安全模式）它们改用双向协议：`tools.interactiveInvocation` 选 ACP（`codebuddy --acp` 沿用 acceptEdits 与白名单 `--settings`；`opencode acp` 经 `OPENCODE_CONFIG_CONTENT` 把 bash 设成 ask，合并用户自己的这个变量）或 `codex app-server`（`thread/start` 给 `approvalPolicy: untrusted`、workspace-write 沙箱、网络与可写目录），由 `agentrun/acp.ts`、`codexapp.ts` 在 `interactive.ts` 的进程外壳上跑。对方的审批请求先过白名单（`commandAllowed`，去掉 codex 的 `zsh -lc` 包装），白名单外的经 `spec.ask` 写进同一个收件目录，后面与审批 MCP 一模一样。约定：ACP 的「总是允许」只答 `allow_once`、codex 拒绝答 `decline`（不打断整轮），「以后都允许」只由客户端记；续接用 `session/load` / `thread/resume`，ACP 续接时对方重放的历史不当成这一轮的事件；opencode、codebuddy 被拒后会直接结束这一轮，`acp.ts` 在对话里补一句说明。三家用旧的一次性模式建的会话都能在新协议下续接（2026-11 实测），所以升级不会让已有会话断掉。`am run` 与 `--unsafe` 仍走一次性模式。离线测试用 `agentrun/testdata/fake-acp.mjs` 与 `fake-codex-app.mjs`，e2e 的 `fake-bin/opencode` 复用前者；`--mcp-config` 吃多个值，后面必须紧跟一个选项，不然会把提示词吞掉。改了这条链要用真实 CLI 跑一遍：claude 与 qoder 照下面的 RealCLI，三家双向协议用 `AM_TEST_INTERACTIVE_TOOLS=codex,opencode,codebuddy npx vitest run --root packages/engine src/agentrun -t RealInteractive`（opencode 默认模型不可用时加 `AM_TEST_OPENCODE_MODEL`）；fake 只模拟协议。

编排工具同理，`orchestratorAccess`（`config/providers.ts`）列出它要放行的命令：基础命令（`orchestratorBaseCommands`，**不含 `am`**——am 只经工具服务调用）加当前 TTS 与对齐工具各自的那一个命令（`TTSProviders` / `Aligners` 的 `command` 字段）。各家的权限模式实测结果不同，改之前先读 `orchestratorInvocation` 的注释：qoder 的 `dont_ask` 连写文件都拒；codex 没有命令白名单，靠沙箱，而沙箱默认断网会让 TTS 失败；opencode 2.x 只读项目目录里的 `opencode.json`，规则集拦不住命令，写成全拒时无头运行会直接挂起，所以 `opencode run`（`am run`）在安全模式下不加限制，README 里写明了；客户端里的 `opencode acp` 经 `OPENCODE_CONFIG_CONTENT` 把 bash 设成 ask，白名单外的命令照样会问（实测 2.1.0 有效）。

改了任何一家的调用参数或解析器，都要在本机跑一遍真实 CLI 集成测试（`packages/engine/src/agentrun/integration.test.ts`）：

```bash
AM_TEST_AGENT_TOOLS=claude,codex,qoder,codebuddy,opencode npx vitest run --root packages/engine src/agentrun -t RealCLI
```

它对每家跑两轮，第二轮续接后要答出第一轮让它记住的词。每次都是真实模型调用，CI 不跑。

## 导演（自带的编排工具）

`ORCHESTRATOR=director`（界面上叫「导演」）是客户端自带的编排工具：不要求用户另装 claude、codex 这类 CLI，在设置页填一家模型服务的 API key 就能做片。agent 循环用 pi（`@earendil-works/pi-coding-agent`，MIT，**钉死 1.4.0**，升级前对照它的 CHANGELOG 重跑 `packages/cli/src/agent/agent.test.ts`，并重新核对 `director.Providers` 里的推荐模型还在 pi 自带的模型目录里）。

| 约定 | 原因 |
|---|---|
| 引擎只有 `packages/engine/src/director`（工具名、请求格式、凭据文件、服务商表），pi 只在 `packages/cli/src/agent/pi.ts`，打成单独的 `dist/am-agent.cjs`；`am studio agent`（`agent/command.ts`）打包后 `require` 同目录的它，开发时 `import('./pi')`。构建在 `packages/cli/build.mjs`，发布流程用 `AM_VERSION=… npm run build -w @am/cli` | pi 连依赖十几 MB，打进 am.cjs 的话每次 `__op`、每个工具服务进程都要多解析一遍 |
| 子进程输出 claude 系的 stream-json（`agent/stream.ts`：system/init、assistant、user、result），`tools.claudeLikeStream` 与 agentrun 的解析、用量、模型识别都把 `director` 当 claude 系处理；会话 id 由子进程在 system/init 里报（`presetSessionID` 为 false） | 不再为它写一份解析器；用量口径与 claude 相同（input 不含缓存，命中与写入分开） |
| 请求经 stdin 一行 JSON（`director.Request`），模型、会话、白名单、凭据目录都在里面，不进命令行；凭据目录由父进程算好放进请求（`agent_dir`） | 命令行在 ps 里谁都看得见；子进程环境按安全模式白名单裁过，`XDG_DATA_HOME` 不在里面，自己算会算出另一个目录 |
| API key 只在 `<数据目录>/am/agent/auth.json`（`AM_AGENT_DIR` 覆盖，0600），由设置页经 `/api/agent-keys`（`studio/agentkeys.ts`）写，接口只回「填没填」；不进 settings.conf、项目文件与任何子进程的环境。vitest setup 与 e2e fixtures 都把 `AM_AGENT_DIR` 指到临时目录 | 编排工具能跑的命令里拿不到 key；测试不能读改开发者自己的 key |
| pi 会到处找东西，`pi.ts` 逐项关掉：设置用 `SettingsManager.inMemory`；`noExtensions` 只留权限闸门；技能只要项目根 `.agents/skills`；上下文文件只要项目根 `AGENTS.md`（`projectRulesFilename('director')`）；不读 `~/.pi/agent/models.json`、不联网刷新模型目录；会话放应用数据目录 `<数据目录>/am/agent/sessions/<按项目路径编码>/`（`agent/pi.ts` 的 `projectSessionDir`，编码与 pi 自己的默认目录相同），不写进项目，续接时项目挪过位置就按 id 全局找。`agent.test.ts` 用上级目录的 `CLAUDE.md` 钉着「不读进来」、并查项目里没有留下会话文件 | 用户机器上可能装了 pi、留着别的工具的 CLAUDE.md，读进来就会照着别人的规矩做片；项目里的 `.pi/extensions` 是会被执行的代码；国内网络下刷新模型目录可能卡住 |
| am 的制作工具不经 MCP：`agent/command.ts` 用工具服务同一份 `describeTools` / `prepareCall` / `Jobs` 在进程内做成 agent 的工具，去掉 `wait_seconds` / `job_wait`，直接等到跑完。pi 的 `tools` 选项是「启用的全部工具名」，am 的工具名必须列进去，否则只登记不启用 | job 那一套是给 codex 60 秒 MCP 超时准备的；漏列工具名实测模型调用时报「Tool not found」 |
| 权限闸门（`agent/gate.ts`，pi 的 `tool_call`）：bash 走 `agentrun.commandAllowed` 与同一份白名单，文件工具只在项目与可写目录里直接放行，`.env` 一律拒绝，am 的工具放行，其余经收件目录问用户（与审批 MCP 同一条路，「以后都允许」这一轮里也生效）；不在客户端里一律拒绝，`--unsafe` 全放行 | 与其他几家的安全模式同一套规矩 |
| 导演暂时只做编排：`tools.ValidRenderers` 不含它，`RENDERER`、`scene.json` 的 `renderer`、记忆的 `applies_when.renderers` 都按这张表校验，`rendererInvocation('director')` 直接报错，设置页与输入框的渲染下拉框不列它 | 渲染要写复杂的 HyperFrames 合成、自己检查再改，最依赖成熟的编码工具；以后要接，先用记忆的「运行对比」比一次通过率 |
| 模型写成「服务商/模型」（pi 的服务商 id），留空用第一家填了 key 的服务商的推荐模型（`director.pickModel`）；`/api/agents/director/models` 跑 `am studio agent --list-models` | 与 opencode 的写法一致；pi 自带的模型目录随版本走，不另维护一份 |

改了这条链要在本机用真实 key 跑一轮（设置页填 key、编排选导演、发一句话）；CI 只跑 `agent.test.ts` 里的假模型（pi 的 `fauxProvider`）。

## 新增一个 TTS 或对齐工具

配音与对齐由编排工具按提示词执行，`am` 只登记取值并做与工具无关的校验。取值表在 `packages/engine/src/config/providers.ts`（`TTSProviders` / `Aligners`），校验与 `am config get` 的帮助都从它派生。加一个工具要同步：

| 位置 | 作用 |
|---|---|
| `packages/engine/src/config/providers.ts` | 取值、名称、自带时间戳粒度、命令名（安全模式下编排工具只被放行这一个命令），以及 `install`：`am setup` 怎么装它（npm 包 / uv 工具 / uv 专用环境，版本钉死，至少发布两周） |
| `assets/prompts/voice/stage.md`、`timeline/stage.md`（第三、四阶段） | 登录、合成与取时间戳的具体命令（**不写安装命令**，`gen.test.ts` 的「leaves voice tools to am setup」拦着），改完跑 `npm run generate -w @am/engine` |
| `apps/desktop/src/renderer/components/SetupGuide.tsx` 的 `voiceNames` | 安装页配音卡片上显示的服务名 |
| `assets/shared/article-to-motion.conf`、`.env.example`、两份 README | 可选值注释 |

收录门槛是「有可非交互调用的 CLI，且凭据不必落进项目文件」。写进提示词的命令要实测过；跑不了的（没有账号）照官方文档写，并让编排工具先打印返回结构再解析。没有自带字级时间戳的路径，`voice.srt` 一律由强制对齐生成，不拿句级时间戳凑。

## 音色库

`packages/engine/src/voice` 是用户级的音色库（`<数据目录>/am/voices`，`AM_VOICES_DIR` 覆盖），所有项目共用：每个音色是 `reference.wav`（经 mediaprobe 转成 24kHz 单声道，3–30 秒）加逐字一致的文字稿，`library.json` 记默认音色。Breeze 配音时从它克隆（`--ref_audio` / `--ref_text`），项目里只记音色名（`production-config.json` 的 `ttsVoice`、角色包的 `voice.breeze.voiceId`）。

| 约定 | 原因 |
|---|---|
| 正式配音一律克隆，描述（`--instruct`）只用来设计新声音的试听 | 2026-11 实测（Resemblyzer 余弦）：同一句描述三次生成只有 0.69 / 0.69 / 0.82，听起来像换了人；从参考音频克隆新文案 0.93 / 0.89 |
| 编排工具只有 `voice_list` / `voice_get` / `voice_save` / `voice_default`（`packages/cli/src/voice_cmd.ts`），删除只在客户端的音色页（`DELETE /api/voices/{名字}`）；`voice_save` 同名不覆盖，要 `overwrite` | 音色是用户长期积累的声音，一句话删掉或顶掉就找不回来。`voice_cmd.test.ts` 的「no way to delete a voice」钉着 |
| 音色页（`Voices.tsx`，后端 `studio/voices.ts`）在进程里直接读写音色库，不占项目写锁、不进轮次快照；上传录音先走 `/api/uploads` 再转存 | 与安装页、记忆面板相同：写的是用户级目录，不是项目文件 |
| `AM_VOICES_DIR` 经 `childEnvironment` 显式传下去，并进 `orchestratorAccess` 的 `writableDirs`；测试的 testutil / testsupport / e2e fixtures 都指到临时目录 | 理由同记忆库：子进程会算出另一个目录，codex 沙箱写不进去；测试不能动开发者真实积累的声音 |
| 语气指导（克隆参数加 `--instruct` 与 `--cfg_scale 4`）按段落分组合成再拼接，语气说明写进 `production/audio/directions.md`；说明只写语气、情绪、语速，不写音色 | 实测同一参考音频下「沉重」「兴奋」「亲切」三种说明，相似度仍有 0.90 / 0.90 / 0.94，时长与音高明显变化；「兴奋」把音高从 132 Hz 抬到 223 Hz，所以提示词要求先试听 |
| 声音事件只能写成 `<\|[笑]>` 这类只读标记（`align.VocalEvents`，`Piece.event`）：进 `tts-text.txt`，不进 `align-text.txt`、不是朗读单元、不显示；正文里直接写 `[笑]` 解析时报错。第四阶段对齐一律用 `align-text.txt` | 实测把事件留在对齐文本里，对齐器会把「叹」「笑」塞进几十毫秒、产生零长度的字；去掉后每个字一样准。`align.test.ts` 的「vocal events」用那次真实对齐结果（`testdata/breeze-events-align.json`）钉着 |
| 音色页能直接做新声音，不经项目对话、不管项目配音选的是谁：「录我的声音」用麦克风念 `voice.SampleText`（`POST /api/voice-record`，逐字稿就是那段字，念错了让用户改）；「按描述设计」用本机 Breeze 念试听（`voice.design`，`POST /api/voice-design`，试听放在库目录的 `.drafts/`、一天后清掉，挑中的经 `/api/voice-drafts/{id}/save` 存进库）；「上传录音」照旧 | 以前做新声音只能在项目里把配音设成 Breeze 再走对话，用户在 Studio 里找不到入口 |
| 「按描述设计」要的 Breeze 在安装页单独一项 `voice:breeze`（项目配音本来就是 Breeze 时用 `tts:breeze`，`/api/voices` 的 `design.install_id` 告诉页面是哪一项），音色页里能直接点安装 | 安装页的配音项按项目配置挑，项目不用 Breeze 时根本不列它 |
| 打包的 .app 要 `NSMicrophoneUsageDescription`（`apps/desktop/package.json` 的 `mac.extendInfo`）；e2e 启动时加 `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` | 没有这条说明 macOS 直接拒绝麦克风；测试不能碰真麦克风、也不能弹系统授权 |
| Breeze 的非商用许可与「只克隆本人或已授权的声音」只写在 README 里；界面、提示词、配置注释与工具说明都不另行提示，也不让编排工具找用户确认 | 软件开源，怎么用是用户自己的事；反复提示只是打断（用户要求） |
| mlx-audio 0.6.1 的命令行没有 `--seed`：同一段重生成结果会变，不能靠种子复现 | 上游 PyTorch 版与 API 有 seed，换到它们时再接 |

## Windows

客户端还没移植完：类型检查与构建在 CI 的 `windows` 任务（`windows-latest`）里必须通过，两包单元测试照跑但失败不挡合并（`continue-on-error`），全部通过后去掉。已经定下的约定：

| 约定 | 原因 |
|---|---|
| 仓库一律以 LF 检出（`.gitattributes`） | Windows 上 git 默认转 CRLF，内置资产按字节下发、指纹按字节算、生成器幂等门逐字节比，全会错 |
| 找可执行文件只用 `envutil.lookPath`：Windows 上按 `PATHEXT` 补扩展名、不看执行权限位；`toolpath.bundled` 同样试 `.exe` / `.cmd` | Windows 的 stat 没有执行位，原先的判断在那里什么都找不到 |
| 环境拷进普通对象一律经 `envMap`（`normalizeWindowsEnv` 把 `Path` 改名 `PATH`） | Windows 上 PATH 通常叫 `Path`；`process.env` 不分大小写，拷出来的对象却分，引擎到处读 `env.PATH` |
| 要整组结束的子进程用 `procgroup` 的 `start` / `groupSpawnOptions` / `killTree`，不要自己写 `detached: true` 与 `process.kill(-pid)` | Windows 没有进程组信号，要 `taskkill /T /F`；`detached` 在那里会弹出新的控制台窗口 |
| `.cmd` / `.bat` 不直接 spawn：`procgroup/windows.ts` 把 npm 的 cmd-shim 改成用 node 跑它的 JS 入口，其余经 `cmd.exe` 转义，多行参数直接报错 | Node 不让直接 spawn 批处理；`cmd.exe` 传不了多行参数，而提示词、MCP 配置正是多行的 |
| 启动 am 一律经 `envutil.amCommand`：Windows 上客户端不写 shim，`AM_SELF` 就是 `am.cjs`，用 Electron（`ELECTRON_RUN_AS_NODE=1`）跑；MCP 服务（`amToolsServer`、审批服务）与写任务都这样起 | 同上：交给各家 CLI 的 MCP 命令若是 `.cmd`，Node 写的 CLI 起不来 |
| Windows 上写出的批处理（agent 的 `am.cmd` 只用 ASCII；`node.cmd` 先 `chcp 65001`） | 批处理按系统代码页解析，中文 Windows 是 GBK，UTF-8 的中文与中文路径会读错 |
| 数据目录只经 `envutil.dataDir`：Windows 上是 `%LOCALAPPDATA%\am`，项目登记在 `%APPDATA%\am\studio`；`LOCALAPPDATA` 等系统变量在 `envutil.WindowsBaseEnvKeys` 里，进安全模式白名单与工具服务的环境 | Windows 上通常没有 `HOME`；子进程拿不到同一组变量就会算出另一个目录。缺 `SystemRoot` 时 Node、Python 的网络与加密直接失败 |
| Windows 上不借用客户端的 Chromium 渲染（不设 `AM_BROWSER`） | 浏览器模式接管 puppeteer 在 fd 3/4 上的管道，Windows 的管道句柄传法不同；改用 HyperFrames 自己的 chrome-headless-shell |

还没做：工具准备页的 Windows 下载表（ffmpeg、uv、无头浏览器）与 `toolinstall` 写出的 sh 包装、测试里的 sh 假工具、Windows 打包与真实 CLI 实测。

## 子进程环境

`config.childEnvironment`（`packages/engine/src/config/config.ts`）在安全模式下只透传白名单变量。`USER` / `LOGNAME` / `SHELL` 不是凭据但必须保留——macOS 上 claude CLI 缺 `USER` 就读不到 Keychain 登录态，报错却是「Not logged in」，与权限隔离毫无关联，极难排查。

新增白名单项要写清楚理由；需要临时透传由用户通过 `AM_PASSTHROUGH_ENV` 决定，不要在代码里放宽默认。
