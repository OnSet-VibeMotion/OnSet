# 仓库规则

本仓库是 ArticleToMotion 的工具本体，交付物是 macOS 桌面客户端（`apps/desktop`，Electron）与随客户端附带的 `am` 命令行（`packages/cli`，打成一个 JS 文件，由客户端自带的 Electron 当 Node 运行）。两者共用一份 TypeScript 引擎 `packages/engine`。它**不是**视频项目：这里不制作视频，也不存放任何单片内容。给视频项目用的规则是 `assets/shared/templates/project-rules.md`，那份文件随项目骨架下发到用户项目的 `templates/project-rules.md`，不约束本仓库的开发。

| 目录 | 内容 |
|---|---|
| `packages/engine/src/<包>/` | 引擎。包的公开 API 从各自的 `index.ts` 导出，外部用 `@am/engine/<包>` 引用。编码约定见 `packages/engine/CONVENTIONS.md`——为了与用户已有的项目文件、记忆库和渲染指纹逐字节兼容，JSON、数字格式、正则都有固定写法 |
| `packages/cli/src/` | `am` 命令行：`cobra.ts` 是命令与参数的解析框架，`cli.ts` 注册全部命令，各命令在 `*_cmd.ts` 等文件里。esbuild 打成 `packages/cli/dist/am.cjs` |
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
npm run generate -w @am/engine    # 由画幅表、风格表与模板重新生成 assets/presets 与 assets/styles
```

CI（`.github/workflows/ci.yml`）跑类型检查、两包的 Vitest、构建、生成器幂等与 e2e；发布（`.github/workflows/release.yml`）在推 `v*` tag 时出 arm64 与 x64 两份 dmg。

## 内置资产

项目骨架分三棵源树，`packages/engine/src/assets/index.ts` 是读取它们的唯一入口：

| 源树 | 内容 |
|---|---|
| `assets/shared/` | 与画幅、风格都无关，所有项目共用（`PROMPT.md`、配置模板、中文正文字体、`templates/`、`.agents/skills/`） |
| `assets/presets/<画幅>/` | 只随画幅变化（`PROMPT-PRODUCTION.md`） |
| `assets/styles/<风格>/<画幅>/` | 风格 × 画幅（`frame.md`、风格说明书、示例图，以及该风格独有的字体） |

**每棵树的内部路径就是它在用户项目根下的目标路径**，`project.initialize`（`packages/engine/src/project/init.ts`）把选中的三棵树叠加拷贝，不做任何路径改写。所以 `assets/shared/assets/fonts/` 这层嵌套是刻意的——它对应项目里的 `assets/fonts/`。多棵树写入同一路径会直接报错，不静默覆盖；风格独有的字体要换一个文件名放进风格树，不能与共用树里的字体同名。

资产不打进 JS：开发时直接读仓库里的 `assets/`，打包时 `apps/desktop/package.json` 的 `extraResources` 把整棵 `assets/` 拷进应用资源目录，客户端与命令行的启动方经 `AM_ASSETS_DIR` 告诉引擎它在哪。遍历时有一条过滤规则：**目录里名字以 `.` 或 `_` 开头的条目一律跳过**（macOS 的 `.DS_Store` 就靠它挡住），只有 `explicitDotEntries` 里列出的 `assets/shared/.env.example` 与 `assets/shared/.agents` 两个入口例外。**新增一个需要随 `am init` 下发的点开头条目时，要把它加进 `explicitDotEntries`**——漏了不报错，只是那份内容静默到不了用户项目。`packages/engine/src/assets/index.test.ts` 的「skips dot and underscore entries except the explicit ones」与「includes the explicitly embedded dot entries」钉着这条规则；打包规则里的 `**/.*` 也要保留，否则点开头的文件在 .app 里根本不存在。

`am init` 不覆盖内容不同的已有文件：目标已存在且字节不同就整体失败并回滚，不做合并。

## 技能树

`assets/shared/.agents/skills/<name>/` 是随 `am init` 下发到用户项目根 `.agents/skills/` 的技能树。`scene.resolveSkill` 从镜头目录逐级向上找 `.agents/skills`，落到项目根就能被发现，用户无需另行安装。

`hyperframes`、`hyperframes-cli` 等官方技能不在这棵树里，但**落点相同**：`am init` 通过 `packages/engine/src/hyperframes` 把它们按固定版本装进同一个 `.agents/skills/`。这棵源树只放本仓库自带的技能。

官方技能不能直接跑 `npx hyperframes skills` 装——上游安装器只认 `homedir()`，没有任何选项能改落点（`skills update --dir` 的帮助原文写着 "scopes the prune, not the install"）。装在机器级会让项目之间互相覆盖：一台机器只有一份技能，项目 A 与项目 B 固定不同版本时谁后初始化谁说了算。

更要命的是上游安装器根本给不了可复现性：它 `git clone` 仓库默认分支取技能，没有指定 ref 的口子，技能内容随上游 `main` 漂移而版本号不变（实测 0.8.1 与 0.8.14 装出来逐字节相同）。所以 `hyperframes` 包不调用它，改为自己按 tag 浅克隆并校验 commit 与技能数量，见 `packages/engine/src/hyperframes/constants.ts` 里 `PinnedSkillsCommit` / `PinnedSkillsCount` 的注释；安装后写一份 `hyperframes-upstream.json` 记录 commit 与每个技能的内容摘要，见 `manifest.ts`。校验过的技能树按 commit 缓存在用户级目录（`defaultCacheDir`）；缓存只在调用方显式传 `Options.cacheDir` 时启用，测试里传临时 `HOME` 的用例因此仍能断言 HOME 一个字节都没动。缓存按技能数判可用。

**要联网的东西都是前置资源**（`packages/engine/src/prereq`）：HyperFrames 技能（`hyperframes.prepareSkills`）、HyperFrames CLI（`ensureCLI`）、各整片风格来源的数据（`Source.prepare`，lemo-opuscar 含全部 demo、海报、core/assets 与 three.js 依赖）只由 `am setup` 下载，用户自己在终端里跑，能看进度、加 `--proxy`、断了重来。其余路径只检查：`am init` / 客户端新建用 `Options.cacheOnly` 从缓存拷技能，`am hyperframes` 与 `scene.run` 用 `requireCLI`，`am film-style use` 与客户端用 `filmstyle.install` / `Source.check`，缺了一律抛 `prereq.MissingError`（文案统一指向 `am setup`）。**不要再在这些路径里加自动下载**：以前建项目、渲染、打开菜单时各自现下载，网络一差就卡在半路，用户看不到卡在哪，渲染途中卡住还白花一次模型调用。`am setup` 的界面（`packages/cli/src/setupview.ts`）每项一行、按显示宽度对齐，终端里原地重画，管道里每次状态变化打一行；git / npm 的原始输出一律写进 `<数据目录>/am/setup.log`（`packages/cli/src/setup.ts`），失败时屏幕只给错误、日志最后几行与日志路径——别再把子进程输出直接接到终端，混进进度行就乱了。`am setup --proxy` 用 `GIT_CONFIG_PARAMETERS` 只给 git 设代理：设成 `HTTPS_PROXY` 的话 npm 也走它，国内镜像经代理反而连不上（实测）。

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
| `packages/engine/src/scene/skills.ts` 的 `registeredSkills` | 追加描述符，`source: SourceEmbedded` |
| 同文件的 `<name>Prompt` 函数 | 该技能注入镜头提示词的片段，挂在描述符的 `promptSection` 上 |
| `assets/shared/templates/project-rules.md` | 下发规则要点名它，有门禁强制（「builtin skills are documented in project rules」） |

新增一个**上游**技能只要在 `registeredSkills` 加一条 `source: SourceUpstream` 的描述符加提示词片段——它已经被 `am init` 装进项目了，注册只是让 `am` 把绝对路径和用法边界写进渲染提示词。

注册上游技能时要收窄范围，上游技能的职责范围通常比单镜头渲染大得多：

- `hyperframes` 是入口技能，0.8.185 起上游把 `hyperframes-animation`、`hyperframes-core`、`hyperframes-creative` 并进了它，组合契约（`SKILL.md` 的 Contract、`references/format.md`）与动效手法（`references/motion.md`）都只在这里。它的本职却是整片制作：故事线三选一、`SPEC.md`、分镜、配乐音效、预览审批、桌面应用交接与 `REVIEW.md`。分镜由上层决定并已写进 `scene.json`，不收窄的话渲染器会产出计划文件、给镜头配乐（产物必须无音轨），还会停下来等人审批。另有两处与本项目正面冲突，要点名覆盖：`references/look.md` 让渲染器把项目根的 `frame.md` 当作配色与字体规范，而本项目的 `frame.md` 不是视觉命令；`references/format.md` 允许 `local()` 引用本机字体，换一台机器渲染结果就不同。
- `hyperframes-cli` 覆盖 `cloud` / `cloudrun` / `lambda` / `publish` 远端渲染路径，`skills` / `upgrade` 这类改动已装技能的命令，以及 `preview` / `open` / `catch-up` / `history` / `feedback` / `usage` 这类交互、桌面应用与遥测命令。第一类绕开本机确定性前提，第二类会顶掉固定版本、影响同项目其他镜头，第三类在无头渲染里要么卡住等人，要么往外发数据。`timeline` 只放行只读的 `--json`，它的改写子命令与「时长由 `scene.json` 决定」冲突。CLI 的写法本身也由这一段教：`scene.hyperFramesCommand()` 返回 `hyperframes.CLICommand`（`am hyperframes`），同时用于提示词和 `rendererAccess` 的放行列表，并要求每条命令单独执行、不拼 `cd …;` / `&&`。以前只有放行列表里有前缀，全靠编排工具写的渲染器锁定文件转告；锁定文件一缺，渲染器写成不带版本的 `npx hyperframes`，整场 lint、check、render 全被拦下，没有产物（实测）。

这些禁令只存在于我们自己写的提示词片段里，上游不会替我们守，所以 `packages/engine/src/scene/skills.test.ts` 有对应的门禁盯着。`hyperframes` 的 `requiredFiles` 包含提示词点名的 `references/*.md`：用 0.8.14 初始化的旧项目里入口技能只有一页路由说明，按缺失处理并在渲染前告警，比把渲染器指向不存在的文件强。

`packages/engine/src/project/skilltree.test.ts` 与 `skilltree.scene.test.ts` 守着这条链：注册了但没随客户端下发、下发了但镜头目录找不到、技能目录缺 `SKILL.md`，都会失败。**这些失败必须修，不能豁免**——`resolveSkill` 按设计在找不到技能时不报错只降级，没有这道门就会一路静默到成片质量变差才被发现。

fork 自外部项目的技能要带 `LICENSE` 和 `ATTRIBUTION.md`，后者记清上游 commit、保留了什么、丢了什么、改了哪几处，供日后同步上游时重做。`text-to-lottie` 的 `references/` 还有一道门禁止上游播放器契约（`Skottie`、`public/projects` 等）回流（`skilltree.test.ts` 的「forked skill carries no upstream player contract」）。

## 画幅预设与风格

画幅与风格是两个正交维度，都在 `am init` 时各选一次（`--canvas`、`--style`）。画幅决定画布与安全区，风格决定配色、字体、版式骨架、动效语法与禁用项；生成器把二者组合成每个风格 × 画幅的 `frame.md`：canvas 与 safe_area 两块来自画幅，其余 token 来自风格模板。2026-10-20 起内置风格只作为旧项目的兼容资产保留：新镜头的提示词不再把 `frame.md` 的风格 token、`style_id`、风格说明书当作视觉命令，`am init` 不传 `--style` 时取自定义草稿（`packages/cli/src/canvas.ts` 的 `resolveStyle`），视觉由各镜头自主决定或由「整片风格」统一。画幅部分（画布、帧率、安全区）照常生效。

`assets/presets/<画幅>/` 与 `assets/styles/<风格>/<画幅>/` 下的**文本产物全部由 `npm run generate -w @am/engine` 生成，不要手改**。真相源是 `packages/engine/src/preset/table.ts` 的画幅表、`packages/engine/src/preset/style.ts` 的风格表，以及 `packages/engine/src/preset/gen/templates/` 下的模板（`PROMPT-PRODUCTION.md` 与风格无关；每套风格在 `templates/styles/<风格>/` 下各有 `frontmatter.yaml`、`frame.body.md`、`style-guide.body.md`）。安全区在预设表里用 anchor 声明（贴顶 / 贴底 / 上下固定），构建期推导成绝对像素写进 `frame.md`——anchor 不进项目文件，渲染工具读到的始终是现成像素值。

改完预设表后必须重跑生成器并提交产物，CI 的 `generated-assets` job 会校验二者一致（`packages/engine/src/preset/gen/gen.test.ts` 的「matches the committed assets byte-for-byte」在本地也能先拦下）。

示例 SVG 是手绘的排版基准，生成器不改它们的内容；改完 SVG 用 `npm run generate -w @am/engine -- -examples -style <风格> -preset <画幅>` 更新 PNG（入口是 `packages/engine/src/preset/gen/main.ts`）。PNG 不参与 CI 幂等门——不同版本的 `rsvg-convert` 输出字节不同，纳进来会让门随 runner 随机失败。

SVG 转 PNG 必须走 `rsvg-convert`（`packages/engine/src/styleimage`），**不能用 ImageMagick**：多数 ImageMagick 构建自带内置 XML SVG 渲染器，会抢在 rsvg 委托前接管 `.svg`，渲染不出文字也画不对背景填充，却返回退出码 0。

新增画幅要动的地方：`packages/engine/src/preset/table.ts` 加一条（安全区、`platform` 平台措辞，必要时加 `layoutNotes` 构图要点）、为每套风格手绘 4 张该尺寸的示例 SVG、跑生成器与 `-examples`。`validate` 与 `scene.buildPrompt` 都向预设表反查，不持有画幅常量，无需改动。

风格模板是所有画幅共用的，**随画幅变化的东西一律写占位符，不写死**：`{{CONTENT_LEFT_PX}}`、`{{CONTENT_WIDTH_PX}}`、`{{SUBTITLE_MAX_WIDTH_PX}}`、`{{COVER_MAX_WIDTH_PX}}` 由生成器从安全区推导（可带整数偏移，如 `{{CONTENT_LEFT_PX+8}}`）；`{{ORIENTATION}}`、`{{PLATFORM_UI}}`、`{{UI_ZONE}}`、`{{AVOIDANCE_ZONES}}` 取自画幅表的 `platform`。在模板里写「竖屏」「抖音右侧互动栏」或 `904` 这类数字，横屏项目就会拿到错的规范。未知占位符会让生成器直接报错。

新增风格要动的地方：`packages/engine/src/preset/style.ts` 加一条；在 `templates/styles/<风格>/` 写三份模板（`style_id` / `style_name` 必须与风格表一致，生成器会校验）；为每个画幅手绘 4 张示例 SVG，放进 `assets/styles/<风格>/<画幅>/assets/style-guide/examples/`；跑生成器与 `-examples`。四种镜头骨架的 id（`preset.ArchetypeIDs`）是叙事职责，所有风格共用、顺序固定，风格只换名字、用途说明和示例图。`packages/engine/src/validate/validate.test.ts` 的「accepts every builtin preset」对每个风格 × 画幅的产物跑一遍 `validate.style`，`packages/engine/src/assets/trees.test.ts` 的「resolve for every combination」确认每个组合的三棵树都在。

### 自定义风格

`am init --style custom --style-brief "…"` 不套内置风格：只写入描述（`docs/style-brief.md`）和草稿树 `assets/styles/custom-draft/<画幅>/`。草稿由生成器产出（模板在 `templates/styles/custom-draft/`），字段齐全但 token 只是默认风格的占位值，没有示例图。原先由编排提示词的「第一阶段补充：定风格」定稿；2026-10-20 起那一节已从制作提示词里拿掉，`gen.test.ts` 的「leaves the visual style free」钉着它与 `custom-draft`、`docs/style-brief.md` 不回流。以下约定仍对存量项目成立：

| 位置 | 约定 |
|---|---|
| `preset.CustomStyle` | 草稿身份（`style_id: custom-draft`）。**刻意不进 `builtinStyles`**——生成器、选择框和一串枚举内置风格的测试都遍历那张表，混进去会把草稿当成带示例图的正式风格（`preset.test.ts` 的「keeps the custom draft out of the builtin table」） |
| `preset.isCustomStyleID` | 自定义风格的命名空间 `custom-<小写短名>`。内置风格不得以 `custom-` 开头 |
| `validate.style` | 草稿直接报「定风格阶段未完成」；定稿后说明书路径固定为 `preset.guideDoc(preset.CustomStyle)`，不从用户写的 `style_name` 拼；其余检查与内置风格相同 |
| `validate.regenerateExamples` | 自定义风格直接渲染项目里的四张 SVG，不重着色、不改写；草稿也放行。`am validate style --regenerate-examples` 因此先出图再校验 |
| `scene.load` | 原先在 `style_guide` 仍是草稿时拒绝加载；风格不再是渲染前置条件后改为放行，旧项目仍从中读技术画布（`scene/style_guide.test.ts` 的「load accepts a draft style guide」） |
| `am style fonts` / `add-font` | 字体只能来自 `preset.allFonts`（与 `assets/fontpool/` 双向一致，`packages/engine/src/assets/trees.test.ts` 的「matches AllFonts in both directions」守着）或用户自带 woff2 |

可选键 `mood_refs` 列氛围参照图，通常来自编排工具的内置生图（官方 Codex 的 `$imagegen`）。它**不查尺寸**——生图工具不能指定像素——也不当版式基准；现在 `buildPrompt` 已不读它（`style_guide.test.ts` 的「buildPrompt does not read mood refs」）。生图只在 ChatGPT 登录的官方 Codex 下才可能可用（API key 与第三方 provider 会被上游过滤），所以它只能是可跳过的一步，不能变成任何流程的前提。`CODEX_HOME` 为此进了安全模式白名单。

## 整片风格

整片风格分两层：`packages/engine/src/filmstyle` 是**与来源无关的通用部分**（`Source` 接口与登记、风格目录查找、装进项目的契约），具体风格来源在子目录里实现 `Source`，模块加载时调用 `filmstyle.register`。目前只有 `packages/engine/src/filmstyle/lemo`（lemo-opuscar，LemoLab，MIT + demo CC BY 4.0）。am 本身不锁定视觉；整片风格是可选的第三种技能来源，与 `SourceEmbedded` / `SourceUpstream` 并列但**不进 `registeredSkills`**：那张表要求解析不到时退回按名字引用，而整片风格解析不到的意思是「本片没有整片风格」。`scene.resolveFilmStyle` 只找项目级（不找家目录），只认契约，解析到就并进 `resolveAllSkills` 的结果，指纹与安全模式读取因此自动覆盖；`buildPrompt` 据此把「视觉自由度」段换成 `filmStyleSection`。

| 约定 | 原因 |
|---|---|
| 项目里的契约：`.agents/skills/am-film-style/` 下必须有 `STYLE.md`（不变量）与 `SKILL.md`（用法、技法参考在哪、来源特有的注意事项），`am-film-style.json` 记来源、风格、版本与内容摘要；其余文件由来源决定。`filmstyle.install`（`install.ts`）校验契约、负责换位与新旧目录，来源只实现 `fill` | 镜头提示词、制作提示词与客户端只依赖契约，接新来源不用改它们。目录名带 `am-` 前缀，免得撞上用户自己装的技能 |
| **镜头提示词与制作提示词不点名任何来源**：lemo 的页面契约、demo、`core/fonts`、真实素材类风格的先后顺序都写在 lemo 自己的 `SKILL.md` 模板里；`gen.test.ts` 的「carries the film style without naming a source」拦 `lemo`、`DEMO.md`、`core/fonts` 回流到制作提示词 | 来源特有的话写进通用提示词，下一个来源就得到一份错的说明 |
| 风格标识是「来源/目录名」（`styleKey`）；`filmstyle.lookup` 也认唯一的目录名、中文名、英文名，多个来源重名时要求写全 | 来源之间目录名会撞 |
| 各来源的数据放在 `filmstyle.rootDir`（`~/.local/share/am/film-styles`，`AM_FILM_STYLES_DIR` 覆盖）下以来源 ID 分目录；`childEnvironment` 显式传根目录与各来源 `envKeys()` 里设了的变量 | 默认目录由 `XDG_DATA_HOME` 推出而它不在白名单，子进程会算出另一个目录 |
| 来源数据是前置资源：只由 `am setup` 经 `Source.prepare` 下载（每个来源一项 `styles:<来源>`），其余路径用 `Source.check` / `fill` 只读，缺了抛 `prereq.MissingError`。编排工具的可写范围里**没有**来源数据 | 见「技能树」一节前置资源的理由 |
| 新增来源：子目录实现 `Source`、模块加载时 `register`，在 `packages/engine/src/filmstyle/sources/index.ts` 里加一行 import（am 命令、客户端后端与前置资源清单都 import 这个模块）。`packages/engine/src/filmstyle/filmstyle.test.ts` 的假来源证明通用部分不依赖任何具体来源 | 登记靠 import 副作用，集中在一处才不会漏 |
| 早先只有一个来源时装在 `.agents/skills/lemo-film-style/`（`lemo-upstream.json`）：`filmstyle.installed`、`resolveFilmStyle` 照样认，`install` 装好新目录后删掉旧目录 | 两份并存会被当成两套整片风格 |

lemo 来源（`packages/engine/src/filmstyle/lemo`）自己的约定：

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

`assets/shared/PROMPT.md` 和 `assets/presets/<画幅>/PROMPT-PRODUCTION.md` 是内置资产，不是本仓库的文档。它们随 `am init` 下发到项目根，被 `am run` 与客户端的「开始制作」直接喂给编排工具。`PROMPT-PRODUCTION.md` 是生成产物，改它要改 `packages/engine/src/preset/gen/templates/PROMPT-PRODUCTION.md` 再跑生成器。

- 要像直接写给人类操作者的任务说明，不暴露执行者是 agent、Codex 或 AI，也不使用「主控 agent」这类身份设定；但可以明确说明他需要操作其他 AI。
- 不得出现 `./am` —— 用户项目里没有这个可执行文件，`am run` 通过 `PATH` 和 `AM_EXECUTABLE` 注入当前的 `am`。
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

`mediaprobe` / `concat` 的集成测试需要真实 ffmpeg，缺失时自行跳过。CI 装了 ffmpeg 与 librsvg——不装的话测试仍然「通过」，真正跑外部命令的代码再没被验证过。

## 镜头时长、局部数据与复用

配音时间轴由 `am align`（`packages/engine/src/align`）从终稿与对齐器输出算出：终稿用 `<显示|朗读>` 与 `@{id}…@{/id}` 标记，`build` 逐字匹配（标签 exact / split / merge / replacement / source-omission / evidence-insertion），写 `voice.srt` 与 `phrase-timeline.json`。匹配代价刻意不照搬 HYPIT：它按整词匹配，按单字匹配时原样的代价会把漏读的几个字合并成一次「替换」藏起来，见 `align/match.ts` 的注释。对齐器 JSON 的结构没有逐版本实测，加载器按「找到第一组带 text/start/end 的对象数组」宽松解析，认不出时报出顶层结构并给出标准结构 `[{"text","start","end"}]`。人工修正只走 `phrase-adjust.json`，不改测量数据。

口播项目的镜头时长由 `am scene cues`（`packages/cli/src/scene_cues.ts`）从分镜计划 `production/scene-plan.json` 推出，与卡点模式的 `am beat cues` 同一个思路：计划只写锚点（`first_subtitle` / `first_phrase`）与切点规则（`cut`），帧号由代码算，写进 `scene.json` 的 `duration_seconds` 与 `timing` 块，`scene.verifyTimingInputs` 做精确比对。秒换帧沿用 `beat.frameOf`，不要另写取整。计划严格解析，新增字段要在 `scene.PlanEntry`（`scene/timing.ts`）里登记，否则提示词里让编排工具写的键会让命令直接失败。

`scene.run` 在启动渲染器前写 `am-scene.js`（`window.AM_SCENE`）。它的字段名是 `scene-kit` 技能的契约：`packages/engine/src/scene/scenedata.ts` 与 `assets/shared/.agents/skills/scene-kit/scene-kit.js` 两边改一处就要改另一处，`packages/engine/src/project/scenekit.test.ts` 用真实扫描器把示例镜头跑一遍。没有 `timing` 块的老镜头照样写这份文件（`cues` / `phrases` 为空），提示词里不出现时间合同表。

镜头交接（`scene/timing.ts` 的 `PlanHandoff` / `Handoff`）是分镜计划里唯一跨镜头的约定。渲染器互相看不到，交界能接上只靠两侧拿到**同一份**约定，所以它由 `am scene cues` 从计划抄进两侧的 `timing.enter` / `timing.exit`，不让编排工具在两份 `prompt.md` 里各写一遍。手法表 `HandoffDevices` 刻意只收「靠画面里的东西接过去」的写法，不收通用擦除——章节交界套固定转场正是要消除的生硬；「相邻章节交界不得同手法」也是同一个理由。`am review` 用 `Toolchain.frameDifference`（32×32 RGB 均值绝对差）比对声明过交接的交界，阈值取得宽，只拦「两张不同的画面」：物件挪几像素就报的话，这道门很快没人信。改手法表要同步改制作提示词第五阶段「镜头交接」的表格，`gen.test.ts` 的「carries scene handoffs」钉着。

镜头复用按输入指纹判定（`scene.fingerprint`，`scene/record.ts`，记录在镜头目录的 `.am-render.json`）。指纹只算**声明过的输入**，不扫整个镜头目录——渲染器自己会往目录里写合成代码，算进去的话渲染一结束指纹就变了。镜头新增一类输入文件时，要把它加进 `fingerprint` 的文件清单，否则改了它也不会触发 Stale。指纹一致只表示「这份已验收产物出自当前输入」，不表示可复现；指纹不一致仍只标 Stale、要 `--force` 才覆盖，不要改成自动重渲染。指纹的摘要按字节算，所以写进 `.am-render.json` 与提示词的文字要逐字稳定，见 `packages/engine/CONVENTIONS.md`。

每次渲染写 `render-<id>.attempt.json`，重渲染前 `scene.archiveAttempt`（`scene/attempt.ts`）先把上一次的产物、日志与尝试记录挪进 `attempts/`。调度层的重试与单镜头重跑走同一个归档函数，不要各写一份编号逻辑。token 用量按各工具流式事件尽力读取（`tools.accumulateUsage`），读不到就留空，不做估算。

用量口径统一（`tools/usage.ts` 的 `Usage`）：输入含缓存命中与写入，缓存是输入里命中的部分，输出含推理。codex 原样就是这个口径，claude 系与 opencode 要把缓存加回输入——不统一的话 claude 显示「输入 4、缓存 40437」，跨工具既不能比也不能相加。新记录带 `basis: total-input`，没有它的老记录读时经 `usageNormalized` 换算；新增一家工具时要按这个口径填，并在 `tools/usage.test.ts` 的「usage is comparable across tools」里加一行真实流。汇总一律用 `usageAdd`：有一次没读到用量就标 `partial`，数字只是下限。

用量账以尝试记录为准：`scene.attemptHistory` 读当前记录加 `attempts/` 归档，失败与重试照样计入（`am scene usage`、客户端镜头列表）。客户端后端把 `render-*.attempt.json` 当媒体只记 stat，回退一轮不会删掉它——那是已经花掉的钱。

编排工具的用量记在账本里（`packages/engine/src/ledger`，只追加的 JSONL）：`am run` 与客户端每一轮记进项目的 `production/usage/orchestrator.jsonl`，整理记忆记进记忆库的 `orchestrator-usage.jsonl`。每次调用一行，失败、取消、续接失败后重开的会话都各记一行；进程没起来（`agentrun` 的 `Result.started` 为 false）的不记。模型名取 `Result.model`（流里的 `system/init`），读不到再按 `tools.configuredModel` 补。客户端后端的 `scanTree` / `statTree` 跳过 `production/usage/`：账在一轮结束前写下，不跳过的话会算成这一轮的改动，回退时连账一起抹掉。`am usage` 合计渲染与编排两本账。

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
| `am memory import` 导入已有项目：尝试记录直接读；只有产物的老归档在临时目录里铺上镜头目录现在的文件（字体、视觉规范）再覆盖归档后重判，只记失败；时长 / 帧数差出 3 帧以上视为镜头后来改过时长，不记 | 不铺镜头目录会把引用本地字体的合成全误判成 font-missing（实测 29 条）；按现在的 scene.json 重判改过时长的镜头会凭空制造失败 |
| 记忆设置经 `childEnvironment` 显式传给子进程（`AM_MEMORY_DIR`、`MEMORY`……） | 安全模式白名单里没有它们，编排工具调用的 `am memory remember` 会落到默认目录，codex 沙箱里直接写失败（实测） |
| 召回每个镜头最多注入 `DefaultMaxLessons`（3）条经验（`memory/recall.ts`），排在后面的记为 `limit`；偏好不占条数，只受字数预算 | SkillsBench（2026）里 1–3 条技能提升 18–19 个百分点，4 条以上只剩 10：条数多了指导互相冲突。字数预算拦不住「很多条短经验」。考试的试用组同样受这个上限，挤不进前 3 的试用经验就是在真实召回里也用不上 |
| 经验的修订（`revises`）要保留旧版全部 `checked_by`，正文不得短于旧版的一半（`lintRevision`） | ACE（ICLR 2026）记录过整体重写把上下文从 1.8 万 token 压成 122 token、准确率跌破基线；LLM 改写还倾向为简洁丢细节。偏好不查：用户换说法替换旧偏好，短一点正常 |
| 整理时每组失败最多附 `MaxContrasts` 组成败对照（`memory/consolidate.ts`；同一镜头后来改对的优先，其次同渲染工具、特征最接近的通过渲染）；通过那一版的源码在指纹仍一致时拷进整理工作目录的 `contrasts/` | 只看失败，整理者只能把报错改写成禁令；ExpeL、ReasoningBank 都从成败对比里提炼。拷进工作目录而不是给路径，是因为整理者在安全模式下未必能读工作目录之外 |
| `suspectMemories`（`memory/stats.ts`）：召回后它 `checked_by` 里的校验器照样判失败，有害 ≥ 2 次且不少于召回次数的一半，记为「可疑」，按渲染工具/模型分开；只给候选，不改状态 | 「待沉睡」要攒够样本比基线；可疑是更直接的负证据（借鉴 ExpeL 的增减投票、ACE 的 helpful/harmful 计数）。改状态要经重考或人 |
| `am memory remember --inferred`：编排工具推测（用户没明说）的偏好进入试用，出现在偏好段的「待确认」里，用户认可后才生效 | 没经确认就写进记忆的内容会被照着做、错了被放大（Xiong et al. 2025）；用户亲口说的不在此列 |
| 记忆探索（`MEMORY_EXPLORE`，默认 0.1）是一批渲染的决定，不是镜头的属性：`attachMemory`（`packages/cli/src/memory_cmd.ts`）按「批次编号 + 镜头目录」抽签，抽中就把注入的最后一条经验换成排在上限外、字数换得进去的第一条，倾向分数记进经历的 `explored`。`recallDigest` 仍返回不探索时的摘要，输入指纹不变；考试与 `am memory recall` 不探索 | 召回排序只统计「当时被召回」的经验，排在上限外的永远攒不到样本，排序会固化（日志 bandit 的选择偏差，Kiyohara et al. 2025）。探索要放在 agent 的运行里而不是镜头里：指纹带上探索结果的话，抽中的镜头下次会被判 Stale，没抽中的又永远不会被探索 |
| 镜头特征词表是 `FeatureDescriptions`（`memory/features.ts`），新增特征要同时改同文件 `features` 的抽取 | 整理说明与格式校验都只认这张表，抽不出来的特征写进经验永远匹配不上 |
| 考试的作答者由调用方注入（`ExamRunner`，`memory/exam.ts`），考场建在项目的 `production/memory-exams/` | 渲染器从镜头目录向上找 `.agents/skills`，建在记忆库里就找不到项目技能 |
| 记忆面板（`apps/desktop/src/renderer/components/Memory.tsx`）先讲「你的偏好 / 学到的经验 / 这个镜头会用上 / 最近」，效果对比、考试、存档回退收进「高级」；校验器 ID、事件类型、镜头特征一律经 `/api/memory` 的 `labels` 换成大白话（`CheckerLabels` / `EventLabels` 在 `memory/labels.ts`，`FeatureDescriptions`），`memory/labels.test.ts` 的「TestEveryCheckerHasLabel」守着说法表与 `knownCheckers()` 一致 | 旧版把快照号、`reads.binding`、`episode` 和考试控件平铺在第一屏，用户看不懂记忆学到了什么 |
| 门槛 `judge`（`memory/exam.ts`）是纯函数，五条门槛各有单测；渲染工具自身故障让整场无效，不按 0 分算 | 一次认证失效不能让一条好经验被拒 |

## 卡点模式

`packages/engine/src/beat` 是无配音卡点的时间契约，以项目根 `beat.yaml` 启用，与 `song.yaml`、`cast.yaml` 互斥。链路是「导入音乐 → 分析出草稿网格 → 试听确认 → 按小节的分镜计划 → `am beat cues` 写镜头时长」。

| 约定 | 原因 |
|---|---|
| 切点帧号只由 `beat.frameOf`（秒 × fps 四舍五入）算出，总帧数只由 `beat.totalFrames` 算出（都在 `beat/grid.ts`） | 两处取整方式不同，画面与音乐会慢慢错开，而且是那种看半天说不出哪里不对的错开 |
| 分镜计划 `plan.json` 只接受小节数，不接受秒数 | 能写秒数就能写出不在重拍上的切点；切点卡在重拍上要由结构保证，不靠事后对轴 |
| `am beat cues` 写 `duration_seconds`，`beat.verifyCue`（`beat/cue.ts`）对切点做**精确**比对 | 帧号只有一个来源，任何偏差都是有人手改了时长；成片里的 ±1 帧容差属于整片复查，不属于这里 |
| 草稿网格永远不直接生效，只有 `beat.confirm` 能把 `reviewed` 置为 true | 模型最常见的错是重拍整体错位或拍号判错，只有听过试听轨才知道 |
| 分析脚本把结果写进文件，不打印到 stdout | 首次运行下载模型权重，进度输出会污染标准输出，按 stdout 解析时结果直接丢失（实测过） |
| 音乐由 ffmpeg 解码成单声道 WAV，脚本用标准库 `wave` 读，再调 `Audio2Beats` | 不走 beat-this 自带的 torchaudio 读文件：它的后端随版本变化，能不能读 MP3 取决于用户机器 |

节拍分析固定 `beat-this` `AnalyzerVersion`（`beat/store.ts`，代码与权重 MIT），不用 librosa（没有重拍）和 madmom（Python 3.12+ 兼容问题，DBN 后处理有专利、限非商用）。CI 不装 torch，真实分析的集成测试（`beat/analyze.test.ts`）只在设置 `AM_TEST_BEAT_PYTHON` 时运行，改动分析脚本后要在本机跑一遍：

```bash
AM_TEST_BEAT_PYTHON=/path/to/venv/bin/python npx vitest run --root packages/engine src/beat -t RealBeatThis
```

镜头的 `beat` 块与 `song` 块并列，`scene.verifyBeatInputs` 在渲染前、复用已有产物前与 `run-all` 里都会执行；启用了卡点却没有 `beat` 块的镜头直接拒绝。

## 平台封面

`publish.md` 的 `cover.images` 登记上传用的平台封面，校验在 `packages/engine/src/validate/cover_images.ts`，平台规格只有一个来源：`coverSpecs`（抖音 4:3 + 3:4、小红书 3:4 / 1:1 / 4:3、视频号 3:4 / 16:9、B 站与知乎 16:10，以及各平台 `ready` 前必须备齐的比例）。平台规则变了改这张表，制作提示词第十二阶段「平台封面」的表格要同步改，`gen.test.ts` 的「requires platform covers」钉着那一节。

尺寸以文件实测为准、声明值只用来对账：手填宽高与实际不符，说明封面改过却没回填，发布时上传的就不是记录里那张。短边下限 1080，所以 B 站常见的 1146×717 不合格（它本身也不是精确的 16:10），用 1920×1200。模板里写封面尺寸时用「宽 1440、高 1080」，不要写成 `1440×1080` 这类乘号形式——`gen.test.ts` 的「substitutes the canvas label」会把它当成写死的画幅拦下。

`safeRelative`（`validate/validate.ts`）解析路径时找最近一层已存在的上级目录（`resolveExisting`），不只看直接父目录：目标在还没建出来的子目录里（例如还没出图的 `covers/`）时，只解析父目录会因为 macOS 临时目录的 `/var` → `/private/var` 符号链接而误判成逃出项目。

## 公开树边界

`packages/engine/src/project/boundary.test.ts` 的「public tree contains no private or legacy content」扫描 `git ls-files --cached --others --exclude-standard`，命中即失败。禁止出现的路径包括 `transcription.srt`、`final.mp4`、`publish.md`、`scenes/`、`production/`、`auto-test/`、`article_to_motion/`、`pyproject.toml`、`am`。

调试产生的单片内容留在仓库外，不要靠 `.gitignore` 遮掩——未跟踪文件同样会被这个测试扫到。

## 桌面客户端

`apps/desktop` 是唯一的界面：对话驱动的本地工作台，仿 OpenDesign。主进程（`src/main/`）在项目目录里启动编排工具，把 `packages/engine/src/agentrun` 的统一事件经 SSE 推给界面（`src/renderer/`，React 19），多轮续接同一个 CLI 会话。「开始制作」与 `am run` 共用 `project.runPrompt`。界面与文档里仍把这套工作台叫 Studio，后端在 `packages/engine/src/studio`。

### 外壳

| 约定 | 原因 |
|---|---|
| 客户端在 `apps/desktop`（npm workspaces，根目录 `package.json`）：`src/main` 是 Electron 主进程，`src/renderer` 是 React 19 界面 | 一个 workspace 一个交付物，引擎与命令行各自独立构建 |
| 界面从自定义协议 `am://app/` 加载，界面里的 `/api/…`、`EventSource`、媒体 `src`、预览 iframe、上传都落到主进程的 `handleRequest`（`src/main/main.ts`） | 界面代码按普通网页写请求，不用为 Electron 改一行；接口名就是后端路由名 |
| `/api`、`/preview` 由进程内的后端处理（`@am/engine/studio` 的 `Server.handle(Request)`）；它的写任务与编排工具调用的 `am` 是 `userData/bin/am` 这份私有 shim（`AM_SELF` 同指它）；退出前 `Server.shutdown()` 取消进行中的轮次与任务 | 不依赖用户是否安装了命令行、也不会调到 `~/.local/bin` 里别的版本；编排工具与子命令各成进程组，不显式取消会在客户端退出后继续跑 |
| 命令行是打进资源目录的 `cli/am.cjs`，由一段 shim（`src/main/clishim.ts` 的 `shimScript`）以 `ELECTRON_RUN_AS_NODE=1` 用客户端自带的 Electron 运行，同时设 `AM_ASSETS_DIR`。菜单「安装命令行工具…」把同一段 shim 写到 `~/.local/bin/am`，已有别人写的 `am` 时先确认、不静默覆盖 | 用户不必另装 Node；终端里的 `am` 与客户端里的永远是同一个版本。重装客户端后路径可能变，在菜单里重新安装即可 |
| 主进程启动时从登录 shell 读 PATH（`shellpath.ts`） | 从 Finder 启动的应用只有系统 PATH，编排工具、ffmpeg、asdf 的 node 全都找不到 |
| 顶栏就是标题栏：`.desktop .topbar` 可拖动窗口，按钮 `no-drag`；macOS 左侧留 88px 给红绿灯 | `titleBarStyle: hiddenInset` 去掉了系统标题栏 |
| 静态文件（`serveStatic`）只把不带扩展名的路径回落到 `index.html`，带扩展名找不到直接 404；按扩展名设 MIME，一律 `no-cache` | 缺失的脚本拿到一份 HTML，浏览器只报模块 MIME 错误，看不出真正原因 |
| 界面产物文件名固定（`assets/app.js`，见 `vite.config.mjs`），不带 hash；`apps/desktop/out/` 与 `packages/cli/dist/` 是构建产物，不提交 | 主进程按路径直接取文件；产物每次由 `npm run build` / `npm run dist` 现做，CI 与发布都从源码构建 |
| 根目录 `package-lock.json` 的 `resolved` 必须是 `registry.npmjs.org` | 用镜像装完依赖要把 `resolved` 换回官方源再提交，CI 访问不到国内镜像 |
| 发布没有签名证书（`apps/desktop/package.json` 的 `build.mac.identity` 是 `null`）：dmg 只能「右键 → 打开」放行 | 有 Apple 开发者账号后在发布流程里接签名与公证 |

### 后端（`packages/engine/src/studio`）

| 约定 | 原因 |
|---|---|
| 客户端自己不写项目文件；改动只来自一轮对话，或 `studioCommands`（`api_sessions.ts`）/ 镜头渲染这类直接调 `am` 子命令的按钮 | 旧版自造过一套 Operation 类型，镜头动作、相机写进 `production/studio/*.json` 再注入渲染提示词，等于绕开项目文件的第二条编辑通道。不要再加回来：要改什么就让编排工具改项目文件 |
| 每轮前后各扫一遍项目（`scanTree`，`turns.ts`），差异即本轮改动，回退按快照恢复 | 编排工具改了哪些文件只有事后比对才知道，工具调用事件并不可靠（Bash 里也能写文件） |
| 回退时任一文件在本轮之后又变过，整体拒绝（`ConflictError`），不做部分回退 | 部分回退会留下一半新一半旧的项目，比不回退更难收拾 |
| 文本按 sha256 存进 `production/studio/blobs/`；媒体扩展名、含 NUL、超过 2 MB 的只记 stat，列出但不回退 | 渲染产物每轮存一份不现实，重渲染即可 |
| 项目级写锁（`Server.acquire` / `release`）：一轮对话与渲染、拼接、复查等写任务互斥 | 否则任务写的文件会被算进那一轮的改动，回退时误删 |
| 预先指定或从流里读到会话 id 立刻落盘；续接失败且没有任何产出时，带对话记录开新会话 | 进程中途崩了也能续接；CLI 会话过期是常态，不能让对话就此断掉 |
| 会话、事件（`<id>.events.jsonl`，SSE 的 id 就是 seq）、轮次记录都在项目的 `production/studio/` 下 | 状态跟着项目走，`am archive` 一起归档；客户端重启后进行中的轮次标成 `interrupted` |
| 编排工具与渲染工具按会话选（`SessionMeta.tool` / `renderer`，`sessions.ts`），默认取项目配置；客户端不改 `article-to-motion.conf`，选择经 `sessionConfig` 覆盖后由 `childEnvironment` 写进子进程的 `ORCHESTRATOR` / `RENDERER` | 环境变量优先于项目配置，编排工具在这一轮里调用的 `am scene run` 因此也用会话选的渲染工具。换编排工具时清掉 CLI 会话 id，下一轮按续接失败的路子带上对话记录开新会话 |
| 项目路径一律用 `Server.currentProject()` 返回的（登记时已 realpath） | macOS 的 `/var` 是 `/private/var` 的链接，两种写法会被当成两个项目，锁和会话都对不上 |
| 上传的文件存进 `production/studio/uploads/`（`uploads.ts`），附件带 `upload: true`，提示词里只给路径和种类，由编排工具在这一轮里复制或转换到项目里；`.env` 拒收 | 客户端不写项目文件。上传落在不进快照的状态目录，文件真正进项目的那一步是某一轮的改动，照常能看差异、能回退 |
| 一轮进行中发的消息排队（`enqueueTurn`，事件 `queued` 带 `queue_id`），这一轮结束后合并成下一轮（`drainQueue`）；`DELETE …/queue/{id}` 移除（事件 `unqueued`），`POST …/queue/{id}/steer` 把它提到最前并停掉当前这一轮；按停止会清掉排队 | 各家 CLI 在非交互模式下都不能中途注入输入，只能排到下一轮。按停止多半是不想让后面的要求接着跑 |
| 待办清单统一成 `agentrun` 的 `KindPlan`（claude 的 TodoWrite、codex 的 `todo_list`、opencode 的 `todowrite`），每条是完整清单；镜头的「渲染中」由渲染日志三分钟内有写入且比尝试记录新判断（`sceneRendering`，`scenes.ts`） | 整片制作要跑几个小时，只看一串工具调用不知道做到哪了。新增一家 CLI 时它的待办工具也要译成 plan 事件 |
| 建项目只走 `packages/engine/src/projectinit`：`am init` 与客户端的新建（`Server.createAPI`）共用 `create`（讲解形式、叙事模式、cast 骨架）与 `installSkills`（HyperFrames 官方技能）。客户端新建后在后台从本机缓存拷技能（`studio/skills.ts`，不联网；缓存是 `am setup` 准备的前置资源，缺了显示指向 `am setup` 的错误），顶栏在缺技能时给「安装」，安装中显示进度条（`hyperframes.Options.progress`，拷贝按技能计数；`am setup` 下载时克隆让 git `--progress` 并解析百分比，在终端里用一行回车刷新）；端到端测试用 `AM_STUDIO_SKIP_SKILL_INSTALL=1` 跳过 | 两边各写一份时界面漏了讲解形式、多角色对话，也不装官方技能，渲染器拿不到 hyperframes 入口技能 |
| `/api/files` 与 `/preview/scenes/` 经 `containedPath`（`sessions.ts`）解析（含符号链接），`.env` 一律不读 | 这两个接口按路径读文件，而预览 iframe 里跑的是渲染器写出的合成页面、与界面同在 `am://app/` 下；不限定在项目内的话，一段生成的 HTML 就能读到项目外的文件与 `.env` |
| 风格只展示整片风格（`studio/filmstyle.ts`）：首页菜单、新建对话框与「风格」页共用 `FilmStyles.tsx`；旧版内置风格不再出现在界面里（`/api/styles` 只剩画幅还在用）。装、换、去掉都经 `am film-style` 写任务（`startFilmStyleTask`），新建时 `/api/projects/create` 收 `film_style` 并返回 `film_style_task`，开机画面跟这个任务；顶栏显示的是 `metadata.film_style` | 旧风格 10 月 20 日起已不影响渲染，留在选择器里只会让人选一个不起作用的东西。风格改的是项目文件，走写任务才不会和一轮对话的快照打架 |
| 客户端不下载风格来源与海报（前置资源，`am setup` 准备）：来源没准备好时 `/api/film-styles` 的那个来源报 `ready: false` 并附指向 `am setup` 的说明，界面显示分类色占位块；`/api/film-styles/{来源}/{目录名}/poster.jpg` 默认给 480 宽的缩略图（`posterThumbWidth`，缓存在 `<风格根目录>/.thumbs/<来源>/`），`?size=full` 给原图 | 原图一张 1920×1080，菜单一屏几十张会卡 |
| 编排工具与界面互通（`studio/view.ts`、`packages/engine/src/studioview`）：编排工具运行 `am studio show <页面> [对象] [--note …]` 把界面切到要用户看的那一页——请求写进这一轮的收件目录（`AM_STUDIO_INBOX`，在 `production/studio/inbox/<轮次>/`，`runTurn` 经子进程环境传下去），后端每 300 毫秒取一次、译成 `view` 事件，界面只执行刚发生的（15 秒内，重放历史不切页），回复下面留一个可点的「↗ 页面」。反方向，界面每条消息带 `view`（当前页、镜头、文件），`describeView` 把它写进这一轮的提示词，不进对话显示。约定写在 `studioInteraction`（`viewInteraction`），页面表 `ViewPages` 与 `Preview.tsx` 的 `tabs` 一一对应 | 走文件不走 HTTP：codex 沙箱默认断网，项目目录总是可写，编排工具也不必知道客户端的任何地址。不在客户端里（`am run`）时 `am studio show` 静默跳过、页面写错照样报错，编排工具照提示词调用不会失败。实测 claude 在安全模式下能直接调用并切页 |
| 口播稿页（`studio/script.ts` 的 `/api/script`、`Script.tsx`）排在标签第一位：读 `production/script-final.md`，经 `align` 的 `view`（`align/view.ts`）排成标题、段落、读法（ruby）与受保护短语，附字数、估算时长（每秒 4.5 字）、`voice.srt` 的实际配音时长与 `script-change-log.md`；没有终稿时原样显示原稿，标记写错时给出位置并显示原文。有终稿、还没有镜头时自动切到这一页，稿子改过没看过时标签打点，聊天里点到终稿也打开这一页。「确认，开始配音」「提修改意见」「针对所选提意见」都只是往对话里发话或填输入框 | 稿件审核关卡要用户看稿，以前只能在聊天里翻；视图与 `am align` 共用一份解析器，读法与短语和配音、对齐看到的是同一份。客户端自己不改稿 |
| 发布页（`Publish.tsx`）不贴 `publish.md` 原文：`/api/publish` 经 `validate.readPublish` 只解析 frontmatter（不校验）返回 `data`，页面按「状态 → 可复制的标题 / 简介 / 话题 → 登记的封面 → 还剩的人工检查」排，规格与证据收进折叠。客户端里任何地方都不显示它的 Markdown 原文：接口不回传正文，解析失败只给原因、让编排工具修；聊天、文件树、`am studio show file publish.md` 点到它都切到发布页（`app.tsx` 的 `pageForFile`，口播稿同理）。合格与否仍只看「发布校验」 | `publish.md` 是 `am run` 下给人看的发布助手；在客户端里发布页就是那份助手，再贴原文只是把几十行校验字段和重复的表格摆到用户面前 |
| 前置资源引导（`studio/setup.ts` 的 `/api/setup`、`SetupGuide.tsx`）：清单来自 `packages/engine/src/prereqs`，与 `am setup` 同一份；只读不下载。缺了在首页输入框上方显示引导卡片（缺哪几项、可复制的 `am setup` 命令、重新检查，每 10 秒自动查一次），顶栏给「前置资源缺 N 项」打开同一份引导；技能或 CLI 缺时「开始制作」不可点，项目里的「安装技能」按钮也让位给引导。`AM_STUDIO_SKIP_SKILL_INSTALL=1` 时当作全部就绪 | 前置资源只由用户在终端里跑 `am setup`；没有引导的话，用户第一次建项目只会在装技能那一步看到一条报错 |

### 界面（`apps/desktop/src/renderer`）

| 约定 | 原因 |
|---|---|
| 编排工具要用户拍板时在回复末尾写 ` ```choices ` 代码块，界面渲染成按钮（`components/chat/model.ts` 的 `parseChoices`），点了把那一行原样发出；约定写在 `studioInteraction`，聊天开场、整片制作第一轮、续接失败补发时都带上 | 没有结构化的「提问」事件，这是三家都能做到的最小约定；改格式要两边一起改 |
| Markdown 渲染（`components/chat/Markdown.tsx`）用 marked（GFM：表格、任务列表、删除线、嵌套列表、自动链接）加 DOMPurify 清洗，再做对话里的处理：标题降两级、外链交给系统浏览器、项目文件路径（链接或行内代码）可点开文件页（`MarkdownContext` 由 `app.tsx` 提供文件树）、代码块带语言与复制、表格可横向滚动、图片只读项目文件或外链。另加两条内联规则 `cjkStrong` / `cjkDel`：CommonMark 的分隔符规则按英文标点设计，`**字体还没下载。**下载` 这种收尾符号前是中文标点、后面紧跟汉字的写法不算粗体，而中文回复里到处是 | 原来的手写解析只认段落、列表、代码与粗体，表格（编排工具最常用的对比格式）、嵌套列表都原样显示；回复里的 HTML 一律经 DOMPurify，事件属性与 `javascript:` 链接进不了页面，e2e 的「renders GitHub-flavored markdown safely」专门测这条 |
| 回复里提到的音频、图片、视频直接在对话里放（`Chat.tsx` 的 `MediaStrip`，查找在 `model.ts` 的 `findMedia`）：按项目文件树认，写全路径或只写文件名都行（同名多个时优先回复里提到过的目录），音频与视频给播放器、图片给缩略图，点文件名打开文件页；`studioInteraction` 要求编排工具写出项目内的相对路径 | 音色试听、配音片段、封面候选原来只是一串文件名，用户得自己去文件树里找；编排工具常把目录写在前文、表格里只写文件名，所以按文件名也要能认 |
| 推荐整片风格时写 ` ```film-styles ` 代码块，每行「来源/目录名 理由」（约定同在 `studioInteraction`）；界面按风格目录渲染成海报卡片（`StylePicks`，海报走 `/api/film-styles/…/poster.jpg`），「用这个风格」把「整片风格用「中文名」（标识）」作为下一条消息发出，由编排工具运行 `am film-style use`。没有代码块时，回复里写到的已知风格标识也显示海报（`parseStylePicks`）——制作提示词只要求「写明中文名、标识」，`am run` 下同一份提示词也得能用 | 用户选画风要看图，光看名字选不出来；装风格仍由编排工具做，客户端不绕过对话改项目文件 |
| 聊天面板的结构照 OpenDesign：一轮的过程（思考、工具、中间的话）收进一个折叠块，进行中展开、结束收起，结尾的话才是回复；进度是底部浮动的药丸，排队的消息叠在输入框上方。事件到界面的整理只在 `components/chat/model.ts`（`buildBlocks`） | 一轮动辄几十次工具调用，平铺会把回复淹没；整理逻辑放一处，渲染组件只管画 |
| 没有打开项目、或点左上角时显示首页（`Home.tsx`，照 OpenDesign 首页）：在输入框说要做什么、拖进文章，发送后进入「开机」画面（`Creation.tsx`）：场记板、按画幅的监视器、四段片段的时间线，依次 `projects/create` → `uploads` → 等 `/api/skills` 装完 → `production/start`（带 `attachments`），播放头按真实进度走，装技能可以「不等了」转后台，最后打板推进到项目。先装技能再开工，编排工具一开工就有 hyperframes 技能。项目名由第一句话或文件名推出，重名加 `-2`；「保存到」默认取上次新建时的父目录（项目登记里的 `last_parent`），最近项目带阶段与出片摘要（`ProjectSummary`） | 从一句话到开始制作不该要先填一张表；已经不存在的项目不混进最近列表，给一键清理 |
| 输入框的 `@` 与 `/`（`components/chat/complete.ts`）：`@` 在任意位置补全口播稿、镜头与项目文件，文字里留 `@编号` / `@路径`，发送时 `mentionAttachments` 把认得的 `@` 变成引用（与右键引用同一种附件）；`/` 只在开头，补全 Studio 命令：新对话、停止、开始制作、切页、渲染 / 校验镜头、拼接、复查在界面里直接执行（走已有接口，不经编排工具），确认口播稿、重做镜头、记偏好换成一句话交给编排工具。带参数的命令先选命令再选参数；认不出的 `/xxx` 照常发出 | 各家 CLI 都用 `@` 指文件、`/` 调命令，用户会照着习惯打；`@` 只留在文字里的话编排工具未必去读，变成引用才有明确的出处。新增命令改 `slashCommands` 与 `Chat.tsx` 的 `runCommand` 两处 |
| 右键菜单（`ContextMenu.tsx`）：工作台里右键按点到的东西给动作——选中的文字、口播稿的一段、镜头、文件树的文件、编排工具的回复，都能「引用到对话」或「引用并说哪里不满意」；输入框里与按住 Shift 时不拦截右键。页面元素用 `data-ctx-source` / `data-ctx-label` / `data-ctx-para` / `data-ctx-scene` / `data-ctx-file`（`data-ctx-whole` 表示没选文字时可整块引用）声明自己是什么，新页面要能右键引用就加这几个属性。引用是附件的一种（后端 `Attachment` 的 `quote` / `label` / `ref`），`attachmentText`（`studio/sessions.ts`）写成「用户引用的内容」一节，界面的 `splitAttachmentText`（`model.ts`）按这个标题把它从用户消息里拆出来，两边改一处要改另一处；引用上限 `maxQuoteRunes`，出处必须在项目里 | 用户对稿子、镜头不满意时，原来只能自己在输入框里描述是哪一段；引用让编排工具拿到原文与出处，不用猜。引用里去掉读法（ruby）与只读不显示的部分，用户看到什么就引用什么 |
| 视觉是「放映室」：`styles.css` 的 `:root` 是唯一的色板（暖黑底、象牙白字、只有一种黄铜色 `--accent`），标题用 `--serif`（本机宋体栈）、数字与小标签用 `--mono`；按钮默认是胶囊形描边。外框没有左侧栏：顶栏中间是四个编号步骤（`Preview.tsx` 的 `stepTabs`），其余页面小字列在右侧，文件树只在「文件」页。镜头页只留画面、名字与「重新渲染」，其余动作收进「⋯」菜单；时间线每格是那个镜头的画面，只在镜头、合成、成片三页出现。成片页与镜头页同版式（左画面、右信息），右栏是复查摘要（问题数、帧数、响度、真峰，读 `review.json` 的 `problems`）与「去发布」；口播稿是居中一栏的宋体文稿、段落编号挂在页边（`.para-no`，`readableText` 引用时去掉）；发布页封面在左（竖版在前）、文案在右 | 用户要「少即是多」和高级感：作品是主角，界面往后退。新页面沿用这套色板与字体，不要再引入第二种强调色 |
| 新组件的样式放进各自的 css（`chat.css`、`home.css`、`creation.css` 等），选择器挂在组件根类下（`.chat …`、`.home …`） | 全局 `styles.css` 里已有 `.legend`、`.style-thumb` 这类通用名，同名类后写的覆盖先写的，撞过两次：时间线图例被挤成一条、风格缩略图撑满整个菜单 |
| `src/renderer/types.ts` 与后端 JSON 字段一一对应 | 前后端之间没有生成代码，改字段两边一起改 |

### 端到端测试

`apps/desktop/e2e/` 用 Playwright 的 Electron 模式启动构建好的客户端（`playwright.config.mjs`、`e2e/fixtures.mjs`）。每个用例一套临时目录：HOME、userData（`AM_DESKTOP_USER_DATA`）、项目登记（`AM_STUDIO_CONFIG`）、记忆库（`AM_MEMORY_DIR`），并设 `AM_STUDIO_SKIP_SKILL_INSTALL=1`——记忆默认打开，不设 `AM_MEMORY_DIR` 的话每次跑 e2e 都往用户真实记忆库写经历，记忆面板曾被几百条 `am-studio-e2e-*` 淹没。

`apps/desktop/e2e/fake-bin/claude` 是 e2e 用的假编排工具（同目录的 `codex` 只用来显示为「已安装」，被调用时直接失败），`fixtures.mjs` 把它放在 PATH 最前面，并设 `AM_DESKTOP_KEEP_PATH=1` 让主进程不再把登录 shell 的 PATH 并到前面（否则真实的 claude 会被先找到）；提示词里带「慢慢来」时它只回报会话然后挂起，供取消测试使用。单元测试里的假工具同理，子进程环境按安全模式白名单构造，测试开关要经 `AM_PASSTHROUGH_ENV` 透传。

## 新增一个 AI CLI

工具矩阵散落在五个文件，加一个工具必须七处同步改，漏一处会在运行期才炸：

| 位置 | 作用 |
|---|---|
| `packages/engine/src/tools/tools.ts` `rendererInvocation` | 单镜头渲染的命令行与非交互权限模式；该模式若拦截 Bash，要把 `RendererAccess` 译成该工具的放行配置（claude 用 `--settings`） |
| `packages/engine/src/tools/tools.ts` `orchestratorInvocation` | 编排调用的命令行、prompt 传递方式（stdin 还是参数）、结构化输出参数、会话参数（新会话 / 续接），以及把 `OrchestratorAccess` 译成该工具的白名单 |
| `packages/engine/src/tools/tools.ts` `presetSessionID` | 该工具能否由调用方预先指定新会话 id；不能的（codex、opencode）要从输出流的第一条事件里读 |
| `packages/engine/src/tools/tools.ts` `ValidTools` | `ORCHESTRATOR` / `RENDERER`（`config.load`）与 `scene.json` 的 `renderer` 字段（`scene.load`）都按这张表校验 |
| `packages/engine/src/agentrun/parse.ts` | 把该工具的结构化流译成统一事件；先录一份真实的两轮输出放进 `packages/engine/src/agentrun/testdata/`，`parse.test.ts` 的「recorded streams」加一行 |
| `packages/engine/src/scene/skills.ts` `rendererSkillDirs` | 该工具的技能目录约定（家目录级与项目级） |
| `packages/engine/src/studio/agents.ts` `agentOrder` | 客户端工具选择里的展示名与顺序，`agents.test.ts` 的「agentOrder covers valid tools」守着与 `ValidTools` 一致 |

同时更新 `assets/shared/article-to-motion.conf`、`assets/shared/.env.example`、`README.md`、`README.en.md` 里的可选值注释。

安全模式的权限模式必须实测能跑通渲染命令。claude 的 `acceptEdits` 只自动批准文件编辑、拦下所有 Bash，而 `-p` 下没人批准，渲染器会执行不了 `am hyperframes render`；`scene.rendererAccess` 列出要放行的最小命令集（`am hyperframes`、`ls`、`ffprobe`）与技能目录读取，`.env` 始终禁读。

编排工具同理，`orchestratorAccess`（`config/providers.ts`）列出它要放行的命令：基础命令（`orchestratorBaseCommands`）加当前 TTS 与对齐工具各自的那一个命令（`TTSProviders` / `Aligners` 的 `command` 字段）。各家的权限模式实测结果不同，改之前先读 `orchestratorInvocation` 的注释：qoder 的 `dont_ask` 连写文件都拒；codex 没有命令白名单，靠沙箱，而沙箱默认断网会让 TTS 失败；opencode 2.x 只读项目目录里的 `opencode.json`，规则集拦不住命令，写成全拒时无头运行会直接挂起，所以安全模式下不加限制，README 里写明了。

改了任何一家的调用参数或解析器，都要在本机跑一遍真实 CLI 集成测试（`packages/engine/src/agentrun/integration.test.ts`）：

```bash
AM_TEST_AGENT_TOOLS=claude,codex,qoder,codebuddy,opencode npx vitest run --root packages/engine src/agentrun -t RealCLI
```

它对每家跑两轮，第二轮续接后要答出第一轮让它记住的词。每次都是真实模型调用，CI 不跑。

## 新增一个 TTS 或对齐工具

配音与对齐由编排工具按提示词执行，`am` 只登记取值并做与工具无关的校验。取值表在 `packages/engine/src/config/providers.ts`（`TTSProviders` / `Aligners`），校验与 `am config get` 的帮助都从它派生。加一个工具要同步：

| 位置 | 作用 |
|---|---|
| `packages/engine/src/config/providers.ts` | 取值、名称、自带时间戳粒度、命令名（安全模式下编排工具只被放行这一个命令） |
| `packages/engine/src/preset/gen/templates/PROMPT-PRODUCTION.md` 第三、四阶段 | 安装、登录、合成与取时间戳的具体命令，改完跑 `npm run generate -w @am/engine` |
| `assets/shared/article-to-motion.conf`、`.env.example`、两份 README | 可选值注释 |

收录门槛是「有可非交互调用的 CLI，且凭据不必落进项目文件」。写进提示词的命令要实测过；跑不了的（没有账号）照官方文档写，并让编排工具先打印返回结构再解析。没有自带字级时间戳的路径，`voice.srt` 一律由强制对齐生成，不拿句级时间戳凑。

## 子进程环境

`config.childEnvironment`（`packages/engine/src/config/config.ts`）在安全模式下只透传白名单变量。`USER` / `LOGNAME` / `SHELL` 不是凭据但必须保留——macOS 上 claude CLI 缺 `USER` 就读不到 Keychain 登录态，报错却是「Not logged in」，与权限隔离毫无关联，极难排查。

新增白名单项要写清楚理由；需要临时透传由用户通过 `AM_PASSTHROUGH_ENV` 决定，不要在代码里放宽默认。
