# 仓库规则

本仓库是 ArticleToMotion 的 Go CLI 工具本体，交付物是单个 `am` 二进制。它**不是**视频项目：这里不制作视频，也不存放任何单片内容。给视频项目用的规则是 `assets/shared/templates/project-rules.md`，那份文件随项目骨架下发到用户项目的 `templates/project-rules.md`，不约束本仓库的开发。

## 命令

```bash
go build ./cmd/am
go test ./...
go test -race ./...
go vet ./...
```

## 内置资产

项目骨架分三棵源树，`assets.go` 的 `//go:embed` 清单是唯一来源：

| 源树 | 内容 |
|---|---|
| `assets/shared/` | 与画幅、风格都无关，所有项目共用（`PROMPT.md`、配置模板、中文正文字体、`templates/`、`.agents/skills/`） |
| `assets/presets/<画幅>/` | 只随画幅变化（`PROMPT-PRODUCTION.md`） |
| `assets/styles/<风格>/<画幅>/` | 风格 × 画幅（`frame.md`、风格说明书、示例图，以及该风格独有的字体） |

**每棵树的内部路径就是它在用户项目根下的目标路径**，`project.Initialize` 把选中的三棵树叠加拷贝，不做任何路径改写。所以 `assets/shared/assets/fonts/` 这层嵌套是刻意的——它对应项目里的 `assets/fonts/`。多棵树写入同一路径会直接报错，不静默覆盖；风格独有的字体要换一个文件名放进风格树，不能与共用树里的字体同名。

**新增一个需要随 `am init` 下发的文件时，要放进对的那棵树，并确认它落在 `//go:embed` 清单覆盖范围内**，否则它只存在于本仓库，永远到不了用户项目。`.env.example` 和 `.agents` 这类点开头的条目必须在 embed 指令里单列——目录模式会跳过它们，漏了不报错，只是那份内容从二进制里静默消失。

`am init` 不覆盖内容不同的已有文件：目标已存在且字节不同就整体失败并回滚，不做合并。

## 技能树

`assets/shared/.agents/skills/<name>/` 是随 `am init` 下发到用户项目根 `.agents/skills/` 的技能树。`scene.ResolveSkill` 从镜头目录逐级向上找 `.agents/skills`，落到项目根就能被发现，用户无需另行安装。

`hyperframes`、`hyperframes-cli` 等官方技能不在这棵树里，但**落点相同**：`am init` 通过 `internal/hyperframes` 把它们按固定版本装进同一个 `.agents/skills/`。这棵源树只放本仓库自带的技能。

官方技能不能直接跑 `npx hyperframes skills` 装——上游安装器只认 `homedir()`，没有任何选项能改落点（`skills update --dir` 的帮助原文写着 "scopes the prune, not the install"）。装在机器级会让项目之间互相覆盖：一台机器只有一份技能，项目 A 与项目 B 固定不同版本时谁后初始化谁说了算。

更要命的是上游安装器根本给不了可复现性：它 `git clone` 仓库默认分支取技能，没有指定 ref 的口子，技能内容随上游 `main` 漂移而版本号不变（实测 0.8.1 与 0.8.14 装出来逐字节相同）。所以 `internal/hyperframes` 不调用它，改为自己按 tag 浅克隆并校验 commit 与技能数量，见 `PinnedSkillsCommit` / `PinnedSkillsCount` 的注释；安装后写一份 `hyperframes-upstream.json` 记录 commit 与每个技能的内容摘要，见 `manifest.go`。校验过的技能树按 commit 缓存在用户级目录（`DefaultCacheDir`），第二个项目起不联网；缓存只在调用方显式传 `Options.CacheDir` 时启用（`projectinit.InstallSkills` 传），测试里传临时 `HOME` 的用例因此仍能断言 HOME 一个字节都没动。缓存按技能数判可用，残缺就重新下载覆盖。

`internal/hyperframes` 的做法是在项目外开一个临时 HOME 让上游安装器照常工作，再把产出搬进项目。三个细节是承重的，改动前先读那里的注释：

| 细节 | 不这么做会怎样 |
|---|---|
| 用 `node -e process.execPath` 解析真实 npx | asdf / nvm / volta 的 shim 靠 HOME 找 node，改写 HOME 后直接报 `unknown command: npx` |
| 接回 `npm_config_cache` | 缓存写进临时 HOME，每个项目重新下载整包 |
| 接回 `npm_config_userconfig` | 读不到用户 `.npmrc`，私有 registry、代理和鉴权全丢，公司内网装不上 |

上游产物里出现符号链接时直接报错而不是照搬：那些链接指回临时 HOME，搬进项目后会成为静默失效的空技能。受保护技能名从嵌入树现读（`assets.BuiltinSkills`），新增内置技能自动受保护，不会被上游同名技能覆盖。

技能分两种来源，`SkillDescriptor.Source` 是它们的分水岭——不是元数据，而是契约：缺失补救、升级方式和守护测试全都不同。

| 来源 | 谁装 | 能否进嵌入树 |
|---|---|---|
| `SourceEmbedded` | 随二进制下发，`project.Initialize` 写进项目 | **必须**在 `assets/shared/.agents/skills/` |
| `SourceUpstream` | `am init` 按固定版本从上游装进项目 | **禁止**——那会留一份永远追不上上游的陈旧副本 |

两条门禁互为反面：`TestEveryRegisteredSkillIsEmbedded` 查前者在不在嵌入树，`TestUpstreamSkillsAreNotVendoredIntoTheEmbeddedTree` 查后者在不在。把上游技能拷进 `assets/` 能让第一条变绿，但会被第二条抓住。

新增一个**内置**技能要动的地方：

| 位置 | 作用 |
|---|---|
| `assets/shared/.agents/skills/<name>/SKILL.md` | 技能本体，`SKILL.md` 是必需文件 |
| `assets.go` 的 `//go:embed` 清单 | 已含 `assets/shared/.agents`，新技能自动覆盖 |
| `internal/scene/skills.go` 的 `RegisteredSkills` | 追加描述符，`Source: SourceEmbedded` |
| 同文件的 `<name>Prompt` 函数 | 该技能注入镜头提示词的片段 |
| `assets/shared/templates/project-rules.md` | 下发规则要点名它，有门禁强制 |

新增一个**上游**技能只要在 `RegisteredSkills` 加一条 `Source: SourceUpstream` 的描述符加提示词片段——它已经被 `am init` 装进项目了，注册只是让 `am` 把绝对路径和用法边界写进渲染提示词。

注册上游技能时要收窄范围，上游技能的职责范围通常比单镜头渲染大得多：

- `hyperframes` 是入口技能，0.8.185 起上游把 `hyperframes-animation`、`hyperframes-core`、`hyperframes-creative` 并进了它，组合契约（`SKILL.md` 的 Contract、`references/format.md`）与动效手法（`references/motion.md`）都只在这里。它的本职却是整片制作：故事线三选一、`SPEC.md`、分镜、配乐音效、预览审批、桌面应用交接与 `REVIEW.md`。分镜由上层决定并已写进 `scene.json`，不收窄的话渲染器会产出计划文件、给镜头配乐（产物必须无音轨），还会停下来等人审批。另有两处与本项目正面冲突，要点名覆盖：`references/look.md` 让渲染器把项目根的 `frame.md` 当作配色与字体规范，而本项目的 `frame.md` 不是视觉命令；`references/format.md` 允许 `local()` 引用本机字体，换一台机器渲染结果就不同。
- `hyperframes-cli` 覆盖 `cloud` / `cloudrun` / `lambda` / `publish` 远端渲染路径，`skills` / `upgrade` 这类改动已装技能的命令，以及 `preview` / `open` / `catch-up` / `history` / `feedback` / `usage` 这类交互、桌面应用与遥测命令。第一类绕开本机确定性前提，第二类会顶掉固定版本、影响同项目其他镜头，第三类在无头渲染里要么卡住等人，要么往外发数据。`timeline` 只放行只读的 `--json`，它的改写子命令与「时长由 `scene.json` 决定」冲突。

这些禁令只存在于我们自己写的提示词片段里，上游不会替我们守，所以 `skills_test.go` 有对应的门禁盯着。`hyperframes` 的 `RequiredFiles` 包含提示词点名的 `references/*.md`：用 0.8.14 初始化的旧项目里入口技能只有一页路由说明，按缺失处理并在渲染前告警，比把渲染器指向不存在的文件强。

`internal/project/skilltree_test.go` 守着这条链：注册了但没随二进制下发、下发了但镜头目录找不到、技能目录缺 `SKILL.md`，都会失败。**这些失败必须修，不能豁免**——`ResolveSkill` 按设计在找不到技能时不报错只降级，没有这道门就会一路静默到成片质量变差才被发现。

fork 自外部项目的技能要带 `LICENSE` 和 `ATTRIBUTION.md`，后者记清上游 commit、保留了什么、丢了什么、改了哪几处，供日后同步上游时重做。`text-to-lottie` 的 `references/` 还有一道门禁止上游播放器契约（`Skottie`、`public/projects` 等）回流。

## 画幅预设与风格

画幅与风格是两个正交维度，都在 `am init` 时各选一次（`--canvas`、`--style`）。画幅决定画布与安全区，风格决定配色、字体、版式骨架、动效语法与禁用项；`go generate` 把二者组合成每个风格 × 画幅的 `frame.md`：canvas 与 safe_area 两块来自画幅，其余 token 来自风格模板。

`assets/presets/<画幅>/` 与 `assets/styles/<风格>/<画幅>/` 下的**文本产物全部由 `go generate ./internal/preset/` 生成，不要手改**。真相源是 `internal/preset/table.go` 的画幅表、`internal/preset/style.go` 的风格表，以及 `internal/preset/gen/templates/` 下的模板（`PROMPT-PRODUCTION.md` 与风格无关；每套风格在 `templates/styles/<风格>/` 下各有 `frontmatter.yaml`、`frame.body.md`、`style-guide.body.md`）。安全区在预设表里用 anchor 声明（贴顶 / 贴底 / 上下固定），构建期推导成绝对像素写进 `frame.md`——anchor 不进项目文件，渲染工具读到的始终是现成像素值。

改完预设表后必须重跑 `go generate` 并提交产物，CI 的 `generated-assets` job 会校验二者一致。

示例 SVG 是手绘的排版基准，生成器不改它们的内容；改完 SVG 用 `go run ./internal/preset/gen -examples -style <风格> -preset <画幅>` 更新 PNG。PNG 不参与 CI 幂等门——不同版本的 `rsvg-convert` 输出字节不同，纳进来会让门随 runner 随机失败。

SVG 转 PNG 必须走 `rsvg-convert`（`internal/styleimage`），**不能用 ImageMagick**：多数 ImageMagick 构建自带内置 XML SVG 渲染器，会抢在 rsvg 委托前接管 `.svg`，渲染不出文字也画不对背景填充，却返回退出码 0。

新增画幅要动的地方：`internal/preset/table.go` 加一条（安全区、`Platform` 平台措辞，必要时加 `LayoutNotes` 构图要点）、为每套风格手绘 4 张该尺寸的示例 SVG、跑 `go generate` 与 `-examples`。`validate` 与 `scene.BuildPrompt` 都向预设表反查，不持有画幅常量，无需改动。

风格模板是所有画幅共用的，**随画幅变化的东西一律写占位符，不写死**：`{{CONTENT_LEFT_PX}}`、`{{CONTENT_WIDTH_PX}}`、`{{SUBTITLE_MAX_WIDTH_PX}}`、`{{COVER_MAX_WIDTH_PX}}` 由生成器从安全区推导（可带整数偏移，如 `{{CONTENT_LEFT_PX+8}}`）；`{{ORIENTATION}}`、`{{PLATFORM_UI}}`、`{{UI_ZONE}}`、`{{AVOIDANCE_ZONES}}` 取自画幅表的 `Platform`。在模板里写「竖屏」「抖音右侧互动栏」或 `904` 这类数字，横屏项目就会拿到错的规范。未知占位符会让生成器直接报错。

新增风格要动的地方：`internal/preset/style.go` 加一条；在 `templates/styles/<风格>/` 写三份模板（`style_id` / `style_name` 必须与风格表一致，生成器会校验）；为每个画幅手绘 4 张示例 SVG，放进 `assets/styles/<风格>/<画幅>/assets/style-guide/examples/`；跑 `go generate` 与 `-examples`。四种镜头骨架的 id（`preset.ArchetypeIDs`）是叙事职责，所有风格共用、顺序固定，风格只换名字、用途说明和示例图。`TestInitEveryStyleAndCanvasPassesStyleValidation` 会对每个风格 × 画幅跑一遍 `am init` 加 `validate style`。

### 自定义风格

`am init --style custom --style-brief "…"` 不套内置风格：只写入描述（`docs/style-brief.md`）和草稿树 `assets/styles/custom-draft/<画幅>/`。草稿由 `go generate` 产出（模板在 `templates/styles/custom-draft/`），字段齐全但 token 只是默认风格的占位值，没有示例图。定稿由编排提示词的「第一阶段补充：定风格」完成，`TestProductionPromptCarriesCustomStyleStage` 钉着那一节。

| 位置 | 约定 |
|---|---|
| `preset.CustomStyle` | 草稿身份（`style_id: custom-draft`）。**刻意不进 `builtinStyles`**——生成器、选择框和一串枚举内置风格的测试都遍历那张表，混进去会把草稿当成带示例图的正式风格 |
| `preset.IsCustomStyleID` | 自定义风格的命名空间 `custom-<小写短名>`。内置风格不得以 `custom-` 开头 |
| `validate.Style` | 草稿直接报「定风格阶段未完成」；定稿后说明书路径固定为 `preset.CustomStyle.GuideDoc()`，不从用户写的 `style_name` 拼；其余检查与内置风格相同 |
| `validate.RegenerateExamples` | 自定义风格直接渲染项目里的四张 SVG，不重着色、不改写；草稿也放行。`am validate style --regenerate-examples` 因此先出图再校验 |
| `scene.Load` | `style_guide` 仍是草稿时拒绝加载。`scene` 不依赖 `preset`，草稿 id 抄了一份常量，`TestDraftStyleIDMatchesPreset` 钉住两边一致 |
| `am style fonts` / `add-font` | 字体只能来自 `preset.AllFonts`（与 `assets/fontpool/` 双向一致，`TestFontPoolMatchesAllFonts` 守着）或用户自带 woff2 |

可选键 `mood_refs` 列氛围参照图，通常来自编排工具的内置生图（官方 Codex 的 `$imagegen`）。它**不查尺寸**——生图工具不能指定像素——也不当版式基准；`BuildPrompt` 会写明配色、字体、版式以 `frame.md` 为准。生图只在 ChatGPT 登录的官方 Codex 下才可能可用（API key 与第三方 provider 会被上游过滤），所以提示词把它写成可跳过的一步，不能变成定风格的前提。`CODEX_HOME` 为此进了安全模式白名单。

## 整片风格

`internal/filmstyle` 把 lemo-opuscar 风格库（LemoLab，MIT + demo CC BY 4.0）里的一种风格装成项目的整片风格。am 本身不锁定视觉；整片风格是可选的第三种技能来源，与 `SourceEmbedded` / `SourceUpstream` 并列但**不进 `RegisteredSkills`**：那张表要求解析不到时退回按名字引用，而整片风格解析不到的意思是「本片没有整片风格」。`scene.ResolveFilmStyle` 只找项目级 `.agents/skills/lemo-film-style/`（不找家目录），解析到就并进 `ResolveAllSkills` 的结果，指纹与安全模式读取因此自动覆盖；`BuildPrompt` 据此把「视觉自由度」段换成 `filmStyleSection`。

| 约定 | 原因 |
|---|---|
| `filmstyle.PinnedCommit` 固定 commit，`catalog.json` 由 `go run ./internal/filmstyle/gen -src <检出>` 从同一 commit 生成（生成器校验 HEAD），`PinnedStyleCount` 守条数 | STYLE.md 与 demo 引擎直接决定画面；跟随 main 的话同一项目两次安装得到不同风格 |
| 风格库本体在用户级目录（`DefaultLibraryDir`，按 commit 分目录），项目里只装选中的一种 | 所有项目共用一份检出；项目里的那份让项目可以整体拷走 |
| 只接画面，不接风格库的 Python 配乐工具（`core/audio/`） | 要一套 Python 环境加约 1.4 GB 采样库，国内网络装不上时整条链路卡住；配乐仍走第九阶段的授权素材，Sound palette 只作参考 |
| am 克隆的风格库带 `.am-library` 标记，只有它的稀疏规则可以由 am 改（`EnsureDemo`）；用户经 `AM_FILM_STYLE_LIBRARY` 指向的检出只读 | 子进程总是经环境变量拿到风格库目录，不能用「是不是默认目录」判断归属 |
| `ChildEnvironment` 显式写 `AM_FILM_STYLE_LIBRARY`；`OrchestratorAccess` 总把风格库放进 `WritableDirs`，开工前 `EnsureFilmStyleLibraryDir` 先建目录 | 默认目录由 `XDG_DATA_HOME` 推出而它不在白名单；编排工具可能在这一轮里才 `am film-style use`，codex 沙箱只能放行已存在的目录 |
| git 子进程带 `GIT_HTTP_LOW_SPEED_LIMIT/TIME`（1 KB/s 持续 60 秒即放弃） | 连接被掐断时 `--filter=blob:none` 的按需取文件不报错只挂着，实测卡过半小时 |
| 下载可续传：克隆在固定的 `<目录>.partial` 里进行，失败保留；检出按 `libraryStages` 分段扩大稀疏规则，每段重试 3 次；demo 以 `.git/am-demos` 完成记录为准 | 按需取文件一批里断一次整批白下；分段后已取回的留在本地，国内网络下重跑几次总能下完 |
| 技能目录不带 `demo/stills`、渲染产物与音频，不带 `core/render`；three.js 只带 demo 与 `core/` 实际 import 到的模块（`threeClosure` 顺着 import 链收集），`core/assets` 只带源码里出现过名字的模型与贴图（`referencedAssets`，按名字认是因为 demo 常拼接路径） | 整棵带的话一种 three.js 风格进项目 34 MB，挑过之后几 MB；多余的文件还会让指纹随无关内容变化 |
| am 管理的风格库里的文件硬链接进项目并设为只读，跨磁盘时退回复制；用户自己的检出只复制、不改权限 | 内容钉在 commit 上不会变，硬链接不占第二份磁盘；只读是因为在项目里改它就改了所有项目共用的那一份 |
| `core/assets/` 不在首次检出里，`EnsureDemo` 发现 demo 引用它才取（`.git/am-core-assets` 完成记录） | 12 MB 的一批经代理常因一次握手失败整批重来，而只有少数风格用它 |
| `SKILL.md` 由 `skill.md.tmpl` 生成，写明 lemo 页面契约（`window.render(t)`）怎么换成 HyperFrames 的 `hf-seek`、`/core/...` 路径为何拷进镜头目录后不用改、Sound palette 与胶片颗粒对镜头无效 | 上游写给它自己的渲染器，这些冲突上游不会替我们守 |

制作提示词「整片风格」一节由 `TestProductionPromptCarriesFilmStyle` 钉着。升级 `PinnedCommit` 时对比新旧 `core/lib.js` 与 `core/README.md` 的页面契约。

## Prompt 文件

`assets/shared/PROMPT.md` 和 `assets/presets/<画幅>/PROMPT-PRODUCTION.md` 是内置资产，不是本仓库的文档。它们随 `am init` 下发到项目根，被 `am run` 直接喂给编排工具。`PROMPT-PRODUCTION.md` 是生成产物，改它要改 `internal/preset/gen/templates/PROMPT-PRODUCTION.md`。

- 要像直接写给人类操作者的任务说明，不暴露执行者是 agent、Codex 或 AI，也不使用「主控 agent」这类身份设定；但可以明确说明他需要操作其他 AI。
- 不得出现 `./am` —— 用户项目里没有这个二进制，`am run` 通过 `PATH` 和 `AM_EXECUTABLE` 注入当前可执行文件。
- 这两条由 `internal/project/boundary_test.go` 的 `TestPromptsUseInstalledCLIAndDoNotExposeExecutorIdentity` 强制执行，违反会让测试失败。

## 媒体校验与拼接

`internal/mediaprobe` 是所有 ffprobe / ffmpeg 调用的唯一入口，别在其他包里直接拼这两个命令。

| 类型 | 作用 |
|---|---|
| `Spec` | 期望规格。**零值字段表示不检查**，调用方只想查一件事时不必填满全部字段 |
| `Spec.Check` | 返回**全部**不符项，不是第一条。每次只报一条会让调用方「修一条、重跑一次、再发现下一条」 |
| `Toolchain.Verify` | 完整校验流程，返回 `Report`。`error` 只表示「检查没跑成」，「跑了但不合格」是 `Report.OK == false` |
| `FrameStats` | 单帧灰度均值与标准差。`Blank()` 只看 `Flat()`，**不叠加 `Dark()`** |

空白帧阈值（`flatStdDev = 2.0`）刻意取得极保守。不能凭「真实帧标准差通常很高」来定：深色背景上只有一行标题时亮部占比不到 1%，标准差会低到 20 出头，那是合法封面。误判它比漏判一个真空白帧更糟——前者会让人很快不再信任这个检查。`TestFrameStatsDoesNotFlagSparseTextOnDarkBackground` 钉着这个上界。

`internal/concat` **刻意不提供重定时能力**。PROMPT 第八阶段写着「禁止通过 `setpts` 或改变帧率让镜头追赶配音」——提示词里的禁令可以被忽略，不存在的能力不能。所以分辨率或帧率不符归入 `Plan.Blocking` 要求重渲染，只有编码和像素格式差异走 `Plan.Normalize`。**不要为了「方便」给它加缩放或变速参数。**

镜头产物校验（`scene.VerifyOutput`）查画幅、帧率、时长、逐帧解码的总帧数、无音轨，不查编码和像素格式：PROMPT 第八阶段明确允许镜头产物规格不一致，由拼接前的规范化统一，在镜头层拦下会和那条既定流程打架。

校验失败返回 `*scene.VerificationError`，`cli` 把它包成 `schedule.Fatal` 停止重试。规格不符是确定性的，重跑只会得到同样的产物，而每次重试都是一次完整的 AI CLI 调用。**新增确定性失败时记得走同一条路。**

`scene.VerifyOutput` 还会跑 `internal/determinism` 的源码扫描：从合成入口沿本地引用展开，只扫渲染真正加载的文件，命中同样返回 `VerificationError`。规则只收「上游禁令里有、HyperFrames lint 不查、几乎没有合法用途」的写法；`setTimeout` 刻意不收，等字体就绪的代码里太常见。新增规则前先拿内置技能与上游技能的示例跑一遍——`TestEmbeddedViewerTemplatePasses` 钉着 algorithmic-art 的 viewer 模板，它的交互路径靠逐行 `am-allow-nondeterministic` 豁免。误判一次，这道门就没人信了。

`@font-face` 只判两种确定的错误：`src` 指向镜头目录里不存在的文件，以及 `font-display` 显式写成 `swap` / `fallback` / `optional`。没写 `font-display` 不判（Chrome 的 `auto` 按 `block` 处理），`local()` 不判（常见写法是 `local()` 后接 `url()` 兜底）。

成片级检查有两条：`am review` 比对音视频流时长、总帧数与镜头帧数之和、镜头交界帧并出联系表，并解码成片实测积分响度与真峰（只进 hints：平台响度规范各不相同，frame.md 的目标是缺省建议）；`am audio check` 用能量包络独立校验字幕时间轴。两者把切黑转场、字幕延长停留这类「机器分不清有意还是事故」的情况放进 hints，不改变退出码。

`am validate reads` 读 `visible-event-inventory.json` 检查每个可读元素的停留时长、短语绑定与顺序。阈值取 Netflix 简体中文字幕规范（每秒 9 字、每条至少 5/6 秒），那是固定位置字幕的下限；画面元素还要先被找到，所以只能放宽不能收紧——收紧会把合法的快节奏镜头判死。字数按阅读单位算（一个英文词算一个），同理是为了不高估。两个 JSON 的字段名写死在制作提示词第四阶段，改字段要同步改那里。

`mediaprobe` / `concat` 的集成测试需要真实 ffmpeg，缺失时自行跳过。CI 装了 ffmpeg——不装的话测试仍然"通过"但覆盖率掉到门禁线以下，真正跑外部命令的代码再没被验证过。

## 镜头时长、局部数据与复用

配音时间轴由 `am align`（`internal/align`）从终稿与对齐器输出算出：终稿用 `<显示|朗读>` 与 `@{id}…@{/id}` 标记，`build` 逐字匹配（标签 exact / split / merge / replacement / source-omission / evidence-insertion），写 `voice.srt` 与 `phrase-timeline.json`。匹配代价刻意不照搬 HYPIT：它按整词匹配，按单字匹配时原样的代价会把漏读的几个字合并成一次「替换」藏起来，见 `match.go` 的注释。对齐器 JSON 的结构没有逐版本实测，加载器按「找到第一组带 text/start/end 的对象数组」宽松解析，认不出时报出顶层结构并给出标准结构 `[{"text","start","end"}]`。人工修正只走 `phrase-adjust.json`，不改测量数据。

口播项目的镜头时长由 `am scene cues` 从分镜计划 `production/scene-plan.json` 推出，与卡点模式的 `am beat cues` 同一个思路：计划只写锚点（`first_subtitle` / `first_phrase`）与切点规则（`cut`），帧号由代码算，写进 `scene.json` 的 `duration_seconds` 与 `timing` 块，`scene.VerifyTimingInputs` 做精确比对。秒换帧沿用 `beat.FrameOf`，不要另写取整。计划严格解析，新增字段要在 `scene.PlanEntry` 里登记，否则提示词里让编排工具写的键会让命令直接失败。

`scene.Run` 在启动渲染器前写 `am-scene.js`（`window.AM_SCENE`）。它的字段名是 `scene-kit` 技能的契约：`scenedata.go` 与 `assets/shared/.agents/skills/scene-kit/scene-kit.js` 两边改一处就要改另一处，`internal/project/scenekit_test.go` 用真实扫描器把示例镜头跑一遍。没有 `timing` 块的老镜头照样写这份文件（`cues` / `phrases` 为空），提示词里不出现时间合同表。

镜头交接（`timing.go` 的 `PlanHandoff` / `Handoff`）是分镜计划里唯一跨镜头的约定。渲染器互相看不到，交界能接上只靠两侧拿到**同一份**约定，所以它由 `am scene cues` 从计划抄进两侧的 `timing.enter` / `timing.exit`，不让编排工具在两份 `prompt.md` 里各写一遍。手法表 `HandoffDevices` 刻意只收「靠画面里的东西接过去」的写法，不收通用擦除——章节交界套固定转场正是要消除的生硬；「相邻章节交界不得同手法」也是同一个理由。`am review` 用 `mediaprobe.FrameDifference`（32×32 RGB 均值绝对差）比对声明过交接的交界，阈值取得宽，只拦「两张不同的画面」：物件挪几像素就报的话，这道门很快没人信。改手法表要同步改制作提示词第五阶段「镜头交接」的表格，`TestProductionPromptCarriesSceneHandoffs` 钉着。

镜头复用按输入指纹判定（`scene.Fingerprint`，记录在镜头目录的 `.am-render.json`）。指纹只算**声明过的输入**，不扫整个镜头目录——渲染器自己会往目录里写合成代码，算进去的话渲染一结束指纹就变了。镜头新增一类输入文件时，要把它加进 `Fingerprint` 的文件清单，否则改了它也不会触发 Stale。指纹一致只表示「这份已验收产物出自当前输入」，不表示可复现；指纹不一致仍只标 Stale、要 `--force` 才覆盖，不要改成自动重渲染。

每次渲染写 `render-<id>.attempt.json`，重渲染前 `scene.ArchiveAttempt` 先把上一次的产物、日志与尝试记录挪进 `attempts/`。调度层的重试与单镜头重跑走同一个归档函数，不要各写一份编号逻辑。token 用量按各工具流式事件尽力读取（`tools.AccumulateUsage`），读不到就留空，不做估算。

用量口径统一（`tools.Usage`）：输入含缓存命中与写入，缓存是输入里命中的部分，输出含推理。codex 原样就是这个口径，claude 系与 opencode 要把缓存加回输入——不统一的话 claude 显示「输入 4、缓存 40437」，跨工具既不能比也不能相加。新记录带 `basis: total-input`，没有它的老记录读时经 `Usage.Normalized` 换算；新增一家工具时要按这个口径填，并在 `TestUsageIsComparableAcrossTools` 里加一行真实流。汇总一律用 `Usage.Add`：有一次没读到用量就标 `partial`，数字只是下限。

用量账以尝试记录为准：`scene.AttemptHistory` 读当前记录加 `attempts/` 归档，失败与重试照样计入（`am scene usage`、Studio 镜头列表）。Studio 把 `render-*.attempt.json` 当媒体只记 stat，回退一轮不会删掉它——那是已经花掉的钱。

编排工具的用量记在账本里（`internal/ledger`，只追加的 JSONL）：`am run` 与 Studio 每一轮记进项目的 `production/usage/orchestrator.jsonl`，整理记忆记进记忆库的 `orchestrator-usage.jsonl`。每次调用一行，失败、取消、续接失败后重开的会话都各记一行；进程没起来（`agentrun.Result.Started` 为 false）的不记。模型名取 `agentrun.Result.Model`（流里的 `system/init`），读不到再按 `tools.ConfiguredModel` 补。Studio 的 `scanTree` / `statTree` 跳过 `production/usage/`：账在一轮结束前写下，不跳过的话会算成这一轮的改动，回退时连账一起抹掉。`am usage` 合计渲染与编排两本账。

## 渲染记忆

`internal/memory` 实现 `docs/superpowers/specs/2026-11-02-渲染记忆-design.md`：经历 → 整理成试用经验 → 回放考试 → 生效并按镜头召回。记忆库在用户级目录（`config.MemorySettings.Dir`），不在项目里。

| 约定 | 原因 |
|---|---|
| `scene` 不依赖 `memory`：召回结果经 `Scene.Memory`（`MemoryRecall`，已渲染好的文本与摘要）挂进来，经历经 `Scene.AfterAttempt` 回调写出；二者都是 `json:"-"`，`AfterAttempt` 在 `Fingerprint` 里清掉 | `memory` 要读 `scene` 抽特征、冻结输入；反过来依赖会成环。回调让经历拿到的正是 `scene.Run` 写下的那份尝试记录，不靠事后读文件猜是不是本次的 |
| 召回段放在 `determinismSection` 之后，开头声明「与上面的强制要求冲突时以上面为准」；段落里不写快照号 | 手写约束优先于学来的约束。不写快照号是为了回退到内容相同的快照时召回段逐字不变，镜头不被误判 Stale |
| `MEMORY` 默认打开；没有召回条目时 `Fingerprint` 不加 `memory` 项、提示词逐字不变 | 项目要随使用越来越懂用户，所以默认打开；空库时与关闭逐字相同，升级 am 不会让老镜头变成 Stale |
| 记忆打开时 `Config.OrchestratorAccess` 把记忆库放进 `WritableDirs`，codex 安全模式据此加 `--add-dir`；`am run` 与 Studio 每轮开工前先建好记忆库目录 | 编排工具调用的 `am memory remember`、`am scene run` 要写用户级记忆库，codex 的 workspace-write 沙箱默认只放行工作目录，写不进去也不报错，只是经历和偏好静默丢失 |
| `internal/cli` 与 `internal/studio` 的 `TestMain` 把 `AM_MEMORY_DIR` 指到临时目录；只读路径（偏好段）用 `memory.OpenReadOnly`，不建目录 | 记忆默认打开，测试不设它就会往开发者真实的 `~/.local/share/am/memory` 写经历 |
| 召回只读快照（`Snapshot.Entries` 存完整文件内容），不读记忆文件；手改文件要经 `am memory status` 记成标注「未经考试」的新快照 | 同一快照 + 同一镜头输入永远同一召回；回退只需把快照内容写回 |
| 效果统计不写进记忆文件，由经历聚合（`ComputeStats`），生成快照时冻结进 `Snapshot.Stats` 供排序 | 并发镜头同时改一个文件会打架；统计写进文件会让规则摘要随每次渲染变化 |
| 统计只算正式渲染的首次尝试；考试经历（`SourceExam`）不进统计、不进整理；渲染工具崩溃不算失败经历 | 重试带着失败说明、考试是人为安排的对照，混进来统计就失真；崩溃不是写法问题，记忆帮不上 |
| 失败按校验器 ID 聚类：`VerificationError.Checks` 与 `Problems` 等长一一对应。产物校验的 ID 由 `scene.ClassifyOutputProblem` 按 `mediaprobe` 的措辞前缀归类，确定性扫描的 ID 是 `determinism.` + 规则名 | 改了 `Spec.Check` 的措辞要同步改归类，`TestVerificationChecksAlignWithProblems` 会抓住落进 `output.other` 的问题。新增确定性规则要登记进 `determinism.RuleIDs`，`TestRuleIDsCoverEveryEmittedRule` 守着——经验的 `checked_by` 只认这两处的 ID |
| 不同模型犯的错不一样：经验可以用 `applies_when.renderers`（渲染工具 ID）/ `models`（模型名前缀）限定范围，召回按当前渲染工具与模型硬过滤，专属经验排在通用经验前；模型未知时不召回限定了模型的经验 | 只在某个模型上成立的经验注入给别的模型，只会白占预算甚至误导；没写范围的经验仍对所有渲染工具成立 |
| 模型名只来自实测：claude / qoder / codebuddy 读输出流的 `system/init`（`tools.DetectModel`），codex 读 `$CODEX_HOME/config.toml` 顶层 `model`（`tools.ConfiguredModel`），opencode 记为未知。召回在渲染器启动前，用 `Store.CurrentModel`：配置声明的优先，否则取 `models.json` 里最近一次实测的 | 流里的模型名只有渲染开始后才有；换模型后的第一次渲染按旧模型召回，渲染完即更新 |
| 格式校验（`memory.Lint`）拒收正文 / 描述 / 关键词里的工具名与模型名（范围只能写进 `applies_when`）、镜头编号、素材文件名、照抄镜头文案连续 8 字以上、与已有经验同校验器同特征同范围却不写 `revises` 的草稿 | 正文保持中性才能在范围放宽时直接复用；「矛盾」无法语义判定，用「同一组校验器 + 特征 + 范围」近似，只拦并列新增 |
| 偏好也交给编排工具：`PreferenceBrief` 追加在 `am run` 的提示词后、Studio 每轮对话前（偏好摘要没变且 CLI 会话还在时不重发，见 `SessionMeta.PreferenceDigest`）。段落里总写着怎样用 `am memory remember` 记下新偏好；用户亲口说的偏好直接生效，不经人工确认或考试 | 用户随口一句话，是编排工具在理解、在定分镜和风格；渲染器只拿到展开后的镜头说明 |
| 事后检查也是校验器：`am validate reads`（`reads.<规则>`，来自 `reads.Report.Findings`）、`am review`（`review.handoff`，`review.HandoffBroken`）、`am scene frames --check-blank`（`frames.blank`）查出的问题经 `RecordCheck` 记到镜头上，渲染工具 / 模型 / 召回继承该镜头最近一次渲染；同一份产物同一组问题不重复记。统计里，事后查出问题的产物不再算一次通过 | 产物校验与确定性扫描是渲染工具本来就很少犯的错（导入的 82 次真实渲染全部一次通过），决定观感的是阅读时间、交接与空白帧 |
| 只由 `reads.*` / `review.handoff` 判定的经验考不了（要看整片），`memory.Examinable` 把它们排除在考试外，由人 `promote`；`frames.blank` 由考试在作答后补查第 0 帧（`ExamOptions.PostCheck`），只补查试用经验引用的校验器 | 单镜头重放没有整片清单和相邻镜头；补查只看第 0 帧，是因为空白帧经验来自「第 0 帧当封面」，看末帧会把合法的淡出算进去 |
| 偏好信号（`memory.PreferenceSignals`）：Studio 每轮对话的话与回退经 `RecordUtterance` 记为 `conversation` 经历，在不同轮次反复提的同一要求（字二元组 Jaccard ≥ 0.5 或重合占短句 ≥ 0.6）、被回退的一轮、带说明的 👍 / 👎 汇成 `human` 组交给整理者起草偏好；起草的偏好要确认，偏好段会让编排工具在对话里问用户 | 单独一句话大多只对这一次成立，反复与回退才说明默认做法不合心意 |
| 批次：每次 `am scene run` / `run-all` 生成一个 `run-…` 编号写进经历，`am memory report` 与 Studio「运行对比」按批次、按渲染工具/模型比一次通过率、重试、问题数、耗时与 token | 评审要看到「第二次比第一次好」，混在一起的话换了渲染工具的变化会被算成记忆的功劳 |
| 统计键是「渲染工具/模型」（`StatKey`）；召回排序只把当前模型自己的样本当强证据，别的模型的样本向 0.5 收缩一半。`Status` 的 `Retest` 列出考试时用的模型与现在不同的生效经验，`am memory exam --retest` 对照组去掉它重考，通过补记考试编号，不通过只报告不改状态 | 换了模型，旧结论不再可信，但也不能自动作废 |
| `am memory import` 导入已有项目：尝试记录直接读；只有产物的老归档在临时目录里铺上镜头目录现在的文件（字体、视觉规范）再覆盖归档后重判，只记失败；时长 / 帧数差出 3 帧以上视为镜头后来改过时长，不记 | 不铺镜头目录会把引用本地字体的合成全误判成 font-missing（实测 29 条）；按现在的 scene.json 重判改过时长的镜头会凭空制造失败 |
| 记忆设置经 `ChildEnvironment` 显式传给子进程（`AM_MEMORY_DIR`、`MEMORY`……） | 安全模式白名单里没有它们，编排工具调用的 `am memory remember` 会落到默认目录，codex 沙箱里直接写失败（实测） |
| 召回每个镜头最多注入 `memory.DefaultMaxLessons`（3）条经验，排在后面的记为 `limit`；偏好不占条数，只受字数预算 | SkillsBench（2026）里 1–3 条技能提升 18–19 个百分点，4 条以上只剩 10：条数多了指导互相冲突。字数预算拦不住「很多条短经验」。考试的试用组同样受这个上限，挤不进前 3 的试用经验就是在真实召回里也用不上 |
| 经验的修订（`revises`）要保留旧版全部 `checked_by`，正文不得短于旧版的一半（`lintRevision`） | ACE（ICLR 2026）记录过整体重写把上下文从 1.8 万 token 压成 122 token、准确率跌破基线；LLM 改写还倾向为简洁丢细节。偏好不查：用户换说法替换旧偏好，短一点正常 |
| 整理时每组失败最多附 `MaxContrasts` 组成败对照（同一镜头后来改对的优先，其次同渲染工具、特征最接近的通过渲染）；通过那一版的源码在指纹仍一致时拷进整理工作目录的 `contrasts/` | 只看失败，整理者只能把报错改写成禁令；ExpeL、ReasoningBank 都从成败对比里提炼。拷进工作目录而不是给路径，是因为整理者在安全模式下未必能读工作目录之外 |
| `SuspectMemories`：召回后它 `checked_by` 里的校验器照样判失败，有害 ≥ 2 次且不少于召回次数的一半，记为「可疑」，按渲染工具/模型分开；只给候选，不改状态 | 「待沉睡」要攒够样本比基线；可疑是更直接的负证据（借鉴 ExpeL 的增减投票、ACE 的 helpful/harmful 计数）。改状态要经重考或人 |
| `am memory remember --inferred`：编排工具推测（用户没明说）的偏好进入试用，出现在偏好段的「待确认」里，用户认可后才生效 | 没经确认就写进记忆的内容会被照着做、错了被放大（Xiong et al. 2025）；用户亲口说的不在此列 |
| 记忆探索（`MEMORY_EXPLORE`，默认 0.1）是一批渲染的决定，不是镜头的属性：`attachMemory` 按「批次编号 + 镜头目录」抽签，抽中就把注入的最后一条经验换成排在上限外、字数换得进去的第一条，倾向分数记进经历的 `explored`。`RecallResult.Digest` 仍返回不探索时的摘要，输入指纹不变；考试与 `am memory recall` 不探索 | 召回排序只统计「当时被召回」的经验，排在上限外的永远攒不到样本，排序会固化（日志 bandit 的选择偏差，Kiyohara et al. 2025）。探索要放在 agent 的运行里而不是镜头里：指纹带上探索结果的话，抽中的镜头下次会被判 Stale，没抽中的又永远不会被探索 |
| 镜头特征词表是 `memory.FeatureDescriptions`，新增特征要同时改 `Features` 的抽取 | 整理说明与格式校验都只认这张表，抽不出来的特征写进经验永远匹配不上 |
| 考试的作答者由调用方注入（`ExamRunner`），考场建在项目的 `production/memory-exams/` | 渲染器从镜头目录向上找 `.agents/skills`，建在记忆库里就找不到项目技能 |
| 门槛 `memory.Judge` 是纯函数，五条门槛各有单测；渲染工具自身故障让整场无效，不按 0 分算 | 一次认证失效不能让一条好经验被拒 |

## 卡点模式

`internal/beat` 是无配音卡点的时间契约，以项目根 `beat.yaml` 启用，与 `song.yaml`、`cast.yaml` 互斥。链路是「导入音乐 → 分析出草稿网格 → 试听确认 → 按小节的分镜计划 → `am beat cues` 写镜头时长」。

| 约定 | 原因 |
|---|---|
| 切点帧号只由 `beat.FrameOf`（秒 × fps 四舍五入）算出，总帧数只由 `beat.TotalFrames` 算出 | 两处取整方式不同，画面与音乐会慢慢错开，而且是那种看半天说不出哪里不对的错开 |
| 分镜计划 `plan.json` 只接受小节数，不接受秒数 | 能写秒数就能写出不在重拍上的切点；切点卡在重拍上要由结构保证，不靠事后对轴 |
| `am beat cues` 写 `duration_seconds`，`beat.VerifyCue` 对切点做**精确**比对 | 帧号只有一个来源，任何偏差都是有人手改了时长；成片里的 ±1 帧容差属于整片复查，不属于这里 |
| 草稿网格永远不直接生效，只有 `beat.Confirm` 能把 `reviewed` 置为 true | 模型最常见的错是重拍整体错位或拍号判错，只有听过试听轨才知道 |
| 分析脚本把结果写进文件，不打印到 stdout | 首次运行下载模型权重，进度输出会污染标准输出，按 stdout 解析时结果直接丢失（实测过） |
| 音乐由 ffmpeg 解码成单声道 WAV，脚本用标准库 `wave` 读，再调 `Audio2Beats` | 不走 beat-this 自带的 torchaudio 读文件：它的后端随版本变化，能不能读 MP3 取决于用户机器 |

节拍分析固定 `beat-this` `AnalyzerVersion`（代码与权重 MIT），不用 librosa（没有重拍）和 madmom（Python 3.12+ 兼容问题，DBN 后处理有专利、限非商用）。CI 不装 torch，真实分析的集成测试只在设置 `AM_TEST_BEAT_PYTHON` 时运行，改动分析脚本后要在本机跑一遍。

镜头的 `beat` 块与 `song` 块并列，`scene.VerifyBeatInputs` 在渲染前、复用已有产物前与 `run-all` 里都会执行；启用了卡点却没有 `beat` 块的镜头直接拒绝。

## 平台封面

`publish.md` 的 `cover.images` 登记上传用的平台封面，校验在 `internal/validate/cover_images.go`，平台规格只有一个来源：`coverSpecs`（抖音 4:3 + 3:4、小红书 3:4 / 1:1 / 4:3、视频号 3:4 / 16:9、B 站与知乎 16:10，以及各平台 `ready` 前必须备齐的比例）。平台规则变了改这张表，制作提示词第十二阶段「平台封面」的表格要同步改，`TestProductionPromptRequiresPlatformCovers` 钉着那一节。

尺寸以文件实测为准、声明值只用来对账：手填宽高与实际不符，说明封面改过却没回填，发布时上传的就不是记录里那张。短边下限 1080，所以 B 站常见的 1146×717 不合格（它本身也不是精确的 16:10），用 1920×1200。模板里写封面尺寸时用「宽 1440、高 1080」，不要写成 `1440×1080` 这类乘号形式——`TestRenderSubstitutesCanvasLabel` 会把它当成写死的画幅拦下。

`safeRelative` 解析路径时找最近一层已存在的上级目录（`resolveExisting`），不只看直接父目录：目标在还没建出来的子目录里（例如还没出图的 `covers/`）时，只解析父目录会因为 macOS 临时目录的 `/var` → `/private/var` 符号链接而误判成逃出项目。

## 公开树边界

`TestPublicTreeContainsNoPrivateOrLegacyContent` 扫描 `git ls-files --cached --others --exclude-standard`，命中即失败。禁止出现的路径包括 `transcription.srt`、`final.mp4`、`publish.md`、`scenes/`、`production/`、`auto-test/`、`article_to_motion/`、`pyproject.toml`、`am`。

调试产生的单片内容留在仓库外，不要靠 `.gitignore` 遮掩——未跟踪文件同样会被这个测试扫到。

## Studio

`am studio`（`internal/studio`）是对话驱动的本地工作台，仿 OpenDesign：在项目目录里启动编排工具，把 `internal/agentrun` 的统一事件经 SSE 推给网页，多轮续接同一个 CLI 会话。「开始制作」与 `am run` 共用 `project.RunPrompt`。

| 约定 | 原因 |
|---|---|
| Studio 自己不写项目文件；改动只来自一轮对话，或 `studioCommands` / 镜头渲染这类直接调 `am` 子命令的按钮 | 旧版自造过一套 Operation 类型，镜头动作、相机写进 `production/studio/*.json` 再注入渲染提示词，等于绕开项目文件的第二条编辑通道。不要再加回来：要改什么就让编排工具改项目文件 |
| 每轮前后各扫一遍项目（`scanTree`），差异即本轮改动，回退按快照恢复 | 编排工具改了哪些文件只有事后比对才知道，工具调用事件并不可靠（Bash 里也能写文件） |
| 回退时任一文件在本轮之后又变过，整体拒绝（`ConflictError`），不做部分回退 | 部分回退会留下一半新一半旧的项目，比不回退更难收拾 |
| 文本按 sha256 存进 `production/studio/blobs/`；媒体扩展名、含 NUL、超过 2 MB 的只记 stat，列出但不回退 | 渲染产物每轮存一份不现实，重渲染即可 |
| 项目级写锁（`acquire` / `release`）：一轮对话与渲染、拼接、复查等写任务互斥 | 否则任务写的文件会被算进那一轮的改动，回退时误删 |
| 预先指定或从流里读到会话 id 立刻落盘；续接失败且没有任何产出时，带对话记录开新会话 | 进程中途崩了也能续接；CLI 会话过期是常态，不能让对话就此断掉 |
| 会话、事件（`<id>.events.jsonl`，SSE 的 id 就是 seq）、轮次记录都在项目的 `production/studio/` 下 | 状态跟着项目走，`am archive` 一起归档；Studio 重启后进行中的轮次标成 `interrupted` |
| 编排工具与渲染工具按会话选（`SessionMeta.Tool` / `Renderer`），默认取项目配置；Studio 不改 `article-to-motion.conf`，选择经 `sessionConfig` 覆盖后由 `ChildEnvironment` 写进子进程的 `ORCHESTRATOR` / `RENDERER` | 环境变量优先于项目配置，编排工具在这一轮里调用的 `am scene run` 因此也用会话选的渲染工具。换编排工具时清掉 CLI 会话 id，下一轮按续接失败的路子带上对话记录开新会话 |
| 项目路径一律用 `currentProject()` 返回的（已 `EvalSymlinks`） | macOS 的 `/var` 是 `/private/var` 的链接，两种写法会被当成两个项目，锁和会话都对不上 |
| 上传的文件存进 `production/studio/uploads/`（`uploads.go`），附件带 `upload: true`，提示词里只给路径和种类，由编排工具在这一轮里复制或转换到项目里；`.env` 拒收 | Studio 不写项目文件。上传落在不进快照的状态目录，文件真正进项目的那一步是某一轮的改动，照常能看差异、能回退 |
| 一轮进行中发的消息排队（`enqueueTurn`，事件 `queued` 带 `queue_id`），这一轮结束后合并成下一轮（`drainQueue`）；`DELETE …/queue/{id}` 移除（事件 `unqueued`），`POST …/queue/{id}/steer` 把它提到最前并停掉当前这一轮；按停止会清掉排队 | 各家 CLI 在非交互模式下都不能中途注入输入，只能排到下一轮。按停止多半是不想让后面的要求接着跑 |
| 编排工具要用户拍板时在回复末尾写 ` ```choices ` 代码块，网页渲染成按钮（`Chat.tsx` 的 `parseChoices`），点了把那一行原样发出；约定写在 `studioInteraction`，聊天开场、整片制作第一轮、续接失败补发时都带上 | 没有结构化的「提问」事件，这是三家都能做到的最小约定；改格式要两边一起改 |
| 待办清单统一成 `agentrun.KindPlan`（claude 的 TodoWrite、codex 的 `todo_list`、opencode 的 `todowrite`），每条是完整清单；镜头的「渲染中」由渲染日志三分钟内有写入且比尝试记录新判断（`sceneRendering`） | 整片制作要跑几个小时，只看一串工具调用不知道做到哪了。新增一家 CLI 时它的待办工具也要译成 plan 事件 |
| 聊天面板的结构照 OpenDesign：一轮的过程（思考、工具、中间的话）收进一个折叠块，进行中展开、结束收起，结尾的话才是回复；进度是底部浮动的药丸，排队的消息叠在输入框上方。事件到界面的整理只在 `ui/src/components/chat/model.ts`（`buildBlocks`） | 一轮动辄几十次工具调用，平铺会把回复淹没；整理逻辑放一处，渲染组件只管画 |
| 建项目只走 `internal/projectinit`：`am init` 与 Studio 的新建（`createAPI`）共用 `Create`（讲解形式、叙事模式、cast 骨架）与 `InstallSkills`（HyperFrames 官方技能）。Studio 新建后在后台装技能（`installSkills`），顶栏在缺技能时给「安装」，安装中显示进度条（`hyperframes.Options.Progress`：克隆时让 git `--progress` 并解析百分比，检出那一步 git 不报进度、显示不确定进度，拷贝按技能计数；`am init` 在终端里用一行回车刷新）；浏览器端到端测试用 `AM_STUDIO_SKIP_SKILL_INSTALL=1` 跳过联网 | 两边各写一份时 Studio 漏了讲解形式、多角色对话，也不装官方技能，渲染器拿不到 hyperframes 入口技能 |
| 没有打开项目、或点左上角时显示首页（`Home.tsx`，照 OpenDesign 首页）：在输入框说要做什么、拖进文章，发送后进入「开机」画面（`Creation.tsx`）：场记板、按画幅的监视器、四段片段的时间线，依次 `projects/create` → `uploads` → 等 `/api/skills` 装完 → `production/start`（带 `attachments`），播放头按真实进度走，装技能可以「不等了」转后台，最后打板推进到项目。先装技能再开工，编排工具一开工就有 hyperframes 技能。项目名由第一句话或文件名推出，重名加 `-2`；「保存到」默认取上次新建时的父目录（`registry.LastParent`），最近项目带阶段与出片摘要（`ProjectSummary`） | 从一句话到开始制作不该要先填一张表；已经不存在的项目不混进最近列表，给一键清理 |
| `/api/files` 与 `/preview/scenes/` 经 `containedPath` 解析（含符号链接），`.env` 一律不读 | 默认只监听回环地址，但手机经隧道访问时这两个接口就是对外的 |

### 前端

源码在 `internal/studio/ui/`（Vite + TypeScript + Preact），`npm run build` 写进 `internal/studio/web/`，由 `//go:embed web` 打进二进制。

| 约定 | 原因 |
|---|---|
| 构建产物提交进仓库，改了 `ui/src` 必须重新构建并一起提交 | 只改 Go 的人和 `go install` 的用户不需要 Node。CI 的 `studio-ui` job 重新构建后 `git diff internal/studio/web` 必须为空 |
| 产物文件名固定（`assets/app.js`、`assets/index.css`），不带 hash | 带 hash 的话每次改动都换文件名，产物 diff 难读；`index.html` 发 `no-cache`，不靠文件名破缓存 |
| `static` 只把不带扩展名的路径回落到 `index.html`，带扩展名找不到直接 404；JS 按扩展名设 MIME | 缺失的脚本拿到一份 HTML，浏览器只报模块 MIME 错误，看不出真正原因 |
| `package-lock.json` 里的地址是 `registry.npmjs.org` | 用镜像装完依赖要把 `resolved` 换回官方源再提交，CI 访问不到国内镜像 |
| 新组件的样式放进各自的 css（`chat.css`、`home.css`、`creation.css`），选择器挂在组件根类下（`.chat …`、`.home …`） | 全局 `styles.css` 里已有 `.legend`、`.style-thumb` 这类通用名，同名类后写的覆盖先写的，撞过两次：时间线图例被挤成一条、风格缩略图撑满整个菜单 |
| `ui/src/types.ts` 与后端 JSON 字段一一对应 | 前后端之间没有生成代码，改字段两边一起改 |

`internal/studio/ui/e2e/fake-bin/claude` 是 e2e 用的假编排工具（同目录的 `codex` 只用来显示为「已安装」，被调用时直接失败），`ui/playwright.config.mjs` 只给 Studio 服务进程的 PATH 加上它；提示词里带「慢慢来」时它只回报会话然后挂起，供取消测试使用。单元测试里的假工具同理，子进程环境按安全模式白名单构造，测试开关要经 `AM_PASSTHROUGH_ENV` 透传。

## 新增一个 AI CLI

工具矩阵散落在六个文件，加一个工具必须八处同步改，漏一处会在运行期才炸：

| 位置 | 作用 |
|---|---|
| `internal/tools/tools.go` `RendererInvocation` | 单镜头渲染的命令行与非交互权限模式；该模式若拦截 Bash，要把 `RendererAccess` 译成该工具的放行配置（claude 用 `--settings`） |
| `internal/tools/tools.go` `OrchestratorInvocation` | 编排调用的命令行、prompt 传递方式（stdin 还是参数）、结构化输出参数、会话参数（新会话 / 续接），以及把 `OrchestratorAccess` 译成该工具的白名单 |
| `internal/tools/tools.go` `PresetSessionID` | 该工具能否由调用方预先指定新会话 id；不能的（codex、opencode）要从输出流的第一条事件里读 |
| `internal/agentrun/parse.go` | 把该工具的结构化流译成统一事件；先录一份真实的两轮输出放进 `testdata/`，`TestRecordedStreams` 加一行 |
| `internal/config/config.go` `validTools` | `ORCHESTRATOR` / `RENDERER` 取值校验 |
| `internal/scene/scene.go` `validRenderer` | `scene.json` 的 `renderer` 字段校验 |
| `internal/scene/skills.go` `rendererSkillDirs` | 该工具的技能目录约定（家目录级与项目级） |
| `internal/studio/agents.go` `agentOrder` | Studio 工具选择里的展示名与顺序，`TestAgentOrderCoversValidTools` 守着与 `validTools` 一致 |

同时更新 `assets/shared/article-to-motion.conf`、`assets/shared/.env.example`、`README.md`、`README.en.md` 里的可选值注释。

安全模式的权限模式必须实测能跑通渲染命令。claude 的 `acceptEdits` 只自动批准文件编辑、拦下所有 Bash，而 `-p` 下没人批准，渲染器会执行不了 `npx hyperframes render`；`scene.RendererAccess` 列出要放行的最小命令集（带固定版本的 hyperframes、`ls`、`ffprobe`）与技能目录读取，`.env` 始终禁读。

编排工具同理，`config.Config.OrchestratorAccess` 列出它要放行的命令：基础命令加当前 TTS 与对齐工具各自的那一个命令（`providers.go` 的 `Command` 字段）。各家的权限模式实测结果不同，改之前先读 `OrchestratorInvocation` 的注释：qoder 的 `dont_ask` 连写文件都拒；codex 没有命令白名单，靠沙箱，而沙箱默认断网会让 TTS 失败；opencode 2.x 只读项目目录里的 `opencode.json`，规则集拦不住命令，写成全拒时无头运行会直接挂起，所以安全模式下不加限制，README 里写明了。

改了任何一家的调用参数或解析器，都要在本机跑一遍真实 CLI 集成测试：

```bash
AM_TEST_AGENT_TOOLS=claude,codex,qoder,codebuddy,opencode go test ./internal/agentrun -run RealCLI -v
```

它对每家跑两轮，第二轮续接后要答出第一轮让它记住的词。每次都是真实模型调用，CI 不跑。

## 新增一个 TTS 或对齐工具

配音与对齐由编排工具按提示词执行，`am` 只登记取值并做与工具无关的校验。取值表在 `internal/config/providers.go`（`TTSProviders` / `Aligners`），校验与 `am config get` 的帮助都从它派生。加一个工具要同步：

| 位置 | 作用 |
|---|---|
| `internal/config/providers.go` | 取值、名称、自带时间戳粒度、命令名（安全模式下编排工具只被放行这一个命令） |
| `internal/preset/gen/templates/PROMPT-PRODUCTION.md` 第三、四阶段 | 安装、登录、合成与取时间戳的具体命令，改完跑 `go generate` |
| `assets/shared/article-to-motion.conf`、`.env.example`、两份 README | 可选值注释 |

收录门槛是「有可非交互调用的 CLI，且凭据不必落进项目文件」。写进提示词的命令要实测过；跑不了的（没有账号）照官方文档写，并让编排工具先打印返回结构再解析。没有自带字级时间戳的路径，`voice.srt` 一律由强制对齐生成，不拿句级时间戳凑。

## 子进程环境

`Config.ChildEnvironment` 在安全模式下只透传白名单变量。`USER` / `LOGNAME` / `SHELL` 不是凭据但必须保留——macOS 上 claude CLI 缺 `USER` 就读不到 Keychain 登录态，报错却是「Not logged in」，与权限隔离毫无关联，极难排查。

新增白名单项要写清楚理由；需要临时透传由用户通过 `AM_PASSTHROUGH_ENV` 决定，不要在代码里放宽默认。
