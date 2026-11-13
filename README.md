<p align="right">简体中文 | <a href="./README.en.md">English</a></p>

# ArticleToMotion

ArticleToMotion 是面向 macOS 和 Linux 的竖屏 MG 视频生产 CLI。它可以把定稿 SRT 拆成并发渲染的动画镜头，也可以从文章或口播稿完成 TTS、字幕、封面、声音制作和发布交付。

▶ [观看 ArticleToMotion 宣传视频（MP4，4 分 47 秒）](https://github.com/chouheiwa/articale-to-motion/blob/main/docs/article-to-motion-tutorial.mp4)

Go 版本以单个 `am` 二进制发布，不依赖 Python。项目 Prompt、发布模板和视觉规范由二进制内置；HyperFrames 技能在初始化时按固定官方版本装进项目，项目因此自包含——整个目录拷到另一台机器就能渲染。

## 安装

从 GitHub Releases 下载适合平台的压缩包，校验 `checksums.txt` 后把 `am` 放入 `PATH`。运行需要：

- macOS 或 Linux（amd64/arm64）
- Node.js 22+
- Git、FFmpeg、FFprobe
- Codex、Claude Code、Qoder、CodeBuddy、OpenCode 中至少一个已登录的 CLI

### 前置资源

要联网下载的东西只由一条命令准备，放在用户级目录、所有项目共用；其余命令（`am init`、`am film-style use`、`am scene run`、`am hyperframes`、`am studio`）都不联网，缺了会提示先运行它：

```bash
am setup                                    # 全部准备（已就绪的跳过，断了重跑接着下）
am setup --proxy http://127.0.0.1:7890      # GitHub 慢时让 git 走代理（不影响 npm）
am setup --only styles                      # 只准备其中几项：skills、cli、styles（全部风格来源）或 styles:<来源>
am setup --check                            # 只检查，不下载；有缺项时退出码 1
```

| 项 | 内容 | 位置 |
|---|---|---|
| `skills` | HyperFrames 官方技能（固定版本，git） | `~/.local/share/am/hyperframes/<commit>` |
| `cli` | 同版本 HyperFrames CLI（npm，沿用你的 `~/.npmrc`） | `~/.local/share/am/hyperframes/cli-<版本>` |
| `styles:<来源>` | 每个整片风格来源一项。lemo-opuscar：全部风格说明、demo、海报、模型与 three.js 依赖（约 100 MB） | `~/.local/share/am/film-styles/<来源>/` |

## 创建项目

```bash
am init my-video                          # 交互选择画幅
am init my-video --canvas vertical-9x16   # 或显式指定
cd my-video
```

画幅在初始化时一次性选定，写入项目的 `frame.md` 后不再更改。当前内置：

| 预设 | 画幅 | 用途 |
|---|---|---|
| `vertical-3x4` | 1080×1440，30fps | 默认，知识与科技类竖屏解说 |
| `vertical-9x16` | 1080×1920，30fps | 抖音等全屏竖屏平台 |
| `landscape-16x9` | 1920×1080，30fps | B 站、YouTube 等横屏平台 |

横屏的安全区避让底部播放器控制栏与进度条（竖屏避让的是抖音右侧互动栏），`frame.md` 末尾附有横屏构图要点。13 套风格都同时支持竖屏和横屏。

非交互环境（CI、管道）必须显式传入 `--canvas`，不会静默取默认值。

### 本地 Studio 工作台

可以启动一个本地网页工作台，在浏览器里用对话驱动制作并预览镜头：

```bash
am studio                         # 浏览器打开后选择项目
am studio /path/to/my-video       # 登记并直接打开项目
am studio --listen 127.0.0.1:4317
```

默认只监听本机。需要手机访问时，请使用自己的 Tailscale、VPN 或 SSH 隧道，并显式指定监听地址；Studio 不提供公网账户或 HTTPS。

工作台的主入口是对话：它在项目目录里启动配置的编排工具（`ORCHESTRATOR`），把它的输出实时推到网页上，多轮对话续接同一个 CLI 会话。「开始制作」等于在网页里跑 `am run`，之后在同一个会话里继续改；也可以开新的对话只做局部修改。

- **Studio 自己不改项目文件。** 改动只来自编排工具的一轮对话，或者渲染、拼接、校验、复查、确认卡点网格这类直接调用 `am` 子命令的按钮。
- **每轮可以回退。** 每轮开始和结束各给项目拍一次快照，结束后列出这一轮改了哪些文件，可以逐个看改动前后的内容，也可以整轮回退。某个文件在这一轮之后又被改过时，回退会整体拒绝，不做部分回退。媒体文件和 2 MB 以上的文件只列出变化，不回退，需要时重渲染。
- **每个会话自选工具。** 对话栏顶部可以为这个会话选编排工具和渲染工具，默认取项目配置，没装的工具不能选。选择只对这个会话生效，不改 `article-to-motion.conf`。会话中途换编排工具时，下一轮会带上之前的对话记录开新的 CLI 会话。
- **同一时间只有一个写入者。** 一轮对话进行中，渲染、拼接等按钮返回「项目正忙」；反过来也一样。
- **会话可以恢复。** 会话、事件和快照存在项目的 `production/studio/` 下，关掉浏览器或重启 Studio 后都还在。CLI 会话续接失败时（例如会话过期），会带上之前的对话记录开新会话。

`am --unsafe studio` 与 `am --unsafe run` 一样关闭权限隔离，见下文「安全模式」。

界面分三栏：左边是制作阶段、镜头列表和项目文件树；中间预览镜头产物（可逐帧步进、圈选区域）、镜头的合成页面（可点选元素）、成片、风格示例、复查联系表和发布信息；右边是对话。镜头截帧、圈出的区域和点选的元素都能附到下一条消息里。卡点项目在确认网格前，中间栏顶部会出现试听轨和「确认网格」按钮。

前端源码在 `internal/studio/ui/`（Vite + TypeScript + Preact），构建产物提交在 `internal/studio/web/`，由 `go:embed` 打进二进制，所以只改 Go 代码不需要 Node。改了前端需要 Node.js 22+：

```bash
cd internal/studio/ui
npm ci
npm run dev        # 开发服务器，接口转给本机 127.0.0.1:4321 上的 am studio
npm run build      # 写入 ../web，连同源码一起提交
npx playwright install chromium
AM_STUDIO_E2E_CONFIG=/tmp/am-studio-projects.json npm run test:e2e
```

### 视觉方向

项目不再预设或锁定视觉风格。画幅、帧率和渲染确定性仍由工具保证；配色、字体、版式、材质和动效由模型根据本片内容与每个镜头自主决定，镜头之间可以使用不同的视觉语言。

`frame.md`、`style_guide` 和旧版内置风格包只为兼容已有项目保留，不会进入新的渲染提示词，也不会作为渲染前置校验。需要参考图、字体或 GSAP 代码时，把它们复制进对应镜头目录即可。

`am init` 仍接受旧版 `--style` 参数以兼容已有脚本，但它不再构成视觉要求。

### 整片风格（可选）

想让全片统一画成一种风格时，从风格来源里选一种。每种风格的标识是「来源/目录名」，名字在各来源里唯一时也可以只写目录名、中文名或英文名。目前登记的来源是 [lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar)（作者 LemoLab，66 种，[图鉴](https://lemomo-ai.github.io/lemo-opuscar/)），之后可以接入更多来源。

```bash
am film-style list                      # 按来源、分类列出全部风格（--source 只看一个来源）
am init my-video --canvas landscape-16x9 --film-style lemo-opuscar/impasto
am film-style use 油画厚涂                # 已有项目；换风格要加 --replace
am film-style show                      # 本项目的整片风格与各风格来源的状态
```

没选时，编排工具会在稿件审核关卡按题材推荐两三种，也可以选「不用整片风格」。`am studio` 里首页、新建对话框和预览区的「风格」页都能直接挑（按来源分组，带海报，可搜索），也能换或去掉。

选中的风格装进项目的 `.agents/skills/am-film-style/`，契约只有三个文件：`STYLE.md`（风格的不变量）、`SKILL.md`（怎么用、技法参考在哪）与 `am-film-style.json`（来源与版本）；示例、引擎等其余文件由来源决定。镜头提示词随之把「视觉自由度」换成「整片风格」，渲染器必须遵守 `STYLE.md`，内容仍来自每个镜头自己的文案。换风格或去掉风格（`am film-style remove`）会让已渲染的镜头全部 Stale。早先装在 `.agents/skills/lemo-film-style/` 的项目照样能用，下次 `am film-style use` 时换成新目录。

各来源的数据是前置资源，由 `am setup` 下载到 `~/.local/share/am/film-styles/<来源>/`（可用 `AM_FILM_STYLES_DIR` 换根目录），所有项目共用；`am film-style` 各命令与 Studio 都不联网。只接画面：配乐仍按制作流程选授权素材，`STYLE.md` 里关于声音的内容只作为方向参考。

`am init` 不覆盖内容不同的已有文件。默认把固定版本 0.8.225 的 HyperFrames 官方技能从本机缓存（`am setup` 下载）拷进项目的 `.agents/skills/`，与随二进制下发的 `text-to-lottie`、`algorithmic-art` 同处一个目录；`am init` 不联网，缓存里没有时会提示先运行 `am setup`。`--skip-hyperframes` 跳过这一步。

技能装进项目而不是 HOME，是因为项目之间互不覆盖只有这样才成立：上游安装器只认 `homedir`，一台机器上只有一份技能，项目 A 与项目 B 固定不同版本时谁后初始化谁说了算。安装全程不写用户 HOME——上游安装器在项目外的临时目录里运行，产物再搬进项目。

#### 技能安装为什么不走上游安装器

上游 `hyperframes skills` 直接 `git clone` 仓库的**默认分支**再取技能，没有任何指定 tag 或 commit 的口子。实测同一台机器上 `hyperframes@0.8.1` 与 `hyperframes@0.8.14` 各装一遍，产出的 26 个技能逐字节相同、都等于当天 `main` 的状态——版本号固定的只是 CLI 二进制，技能内容会随上游主干漂移，而技能内容直接决定成片动效。

所以 `am init` 不调用它，改为自己按 tag `v<版本>` 浅克隆上游仓库，从 `skills/` 与 `.agents/skills/` 两处取出含 `SKILL.md` 的目录。实测这套筛选在同一个 commit 上与上游安装器的产出**逐字节相同**。三道闸保证结果确定：

- **commit 校验**：tag 可以被 force-push 移动，解析出的 commit 与 `PinnedSkillsCommit` 不符就拒装。
- **数量校验**：上游哪天挪动目录，按目录拼装会静默少装一批技能，而渲染 agent 找不到技能不会报错、只会自己发明写法。数量与 `PinnedSkillsCount` 不符就拒装。
- **环境隔离**：`GIT_LFS_SKIP_SMUDGE=1`（仓库里有 LFS 媒体文件，装了 git-lfs 的机器会还原成真文件、没装的留下指针，同一 commit 在两台机器上得到不同的树）、`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`（用户的 filter、autocrlf 不能参与检出）。

`am init` 还会把结果写进 `.agents/skills/hyperframes-upstream.json`：版本、上游 commit，以及每个技能目录的内容摘要。升级固定版本时改 `internal/hyperframes` 里的 `PinnedVersion` / `PinnedSkillsCommit` / `PinnedSkillsCount` 三个常量。

同版本的 HyperFrames CLI 由 `am setup` 装进 `~/.local/share/am/hyperframes/cli-<版本>`，渲染器与编排工具一律经 `am hyperframes …` 调用它，不在渲染途中现下载；没装好时 `am scene run` 在启动渲染器之前就报错。

初始化还会把二进制内置的技能树写到项目的 `.agents/skills/`，渲染工具会自动发现：

| 技能 | 用途 |
|---|---|
| `text-to-lottie` | 镜头里的 Lottie 图层：logo 演绎、图标、loader、SVG 描边、矢量特效 |
| `algorithmic-art` | 算法与生成式视觉效果 |

这两个随二进制下发，不需要联网安装，`--skip-hyperframes` 也不影响它们。

编辑 `article-to-motion.conf` 选择编排工具与渲染工具；两者可以相同：

```text
ORCHESTRATOR=codex
RENDERER=claude
TTS_PROVIDER=minimax
ALIGN_PROVIDER=auto
SCENE_JOBS=3
MEMORY=on
MEMORY_SNAPSHOT=
MEMORY_RECALL_BUDGET=1500
MEMORY_EXPLORE=0.1
```

`TTS_PROVIDER` 可选 `minimax`、`bailian`、`edge`（免鉴权，适合预览）、`elevenlabs`、`tencent`、`mlx`（本机离线，仅 Apple Silicon）；凭据一律走各工具自己的登录命令。`ALIGN_PROVIDER` 选择已知文本强制对齐工具，缺省 `auto`：Apple Silicon 上用 mlx-audio 的 Qwen3-ForcedAligner，其余平台用 FunASR。没有自带字级时间戳的 TTS 路径，字幕时间轴由它生成。

优先级为环境变量、项目 `.env`、配置文件、内置默认。项目 `.env` 不允许保存 API Key、Token、Secret 或 Password。

画幅之外，叙事模式是 `am init` 的第二个一次性维度：`--narration cast` 额外写出 `cast.yaml` 与 `cast/` 目录，进入多角色对话模式，见下方「多角色叙事」；不传则维持默认的单口播模式，行为与之前完全一致。

## 工作流

已有定稿 SRT 时，将它保存为 `transcription.srt`，然后运行：

```bash
am run
```

从文章、口播稿或参考字幕开始完整制作（项目里还没有 `transcription.srt` 时，不带参数的 `am run` 与 Studio 的「开始制作」也会自动走这条）：

```bash
am run PROMPT-PRODUCTION.md
```

`am run` 会自动将当前 `am` 可执行文件所在目录放到编排子进程的 `PATH` 首位，并注入其绝对路径为 `AM_EXECUTABLE`。因此 Prompt 中的 `am scene ...` 会继续使用启动本次流程的同一个 CLI，无需把二进制复制进项目。

镜头命令也可独立使用：

```bash
am scene run scenes/scene-001
am scene run-all scenes/ --jobs 3 --retries 2 --report-json production/run-report.json
```

配音对齐不手工映射。终稿 `production/script-final.md` 里用 `<显示|朗读>` 标出显示与朗读不同的地方（如 `<2025年|二零二五年>`），用 `@{短语编号}…@{/短语编号}` 标出受保护短语；`am align text` 生成送进 TTS 与强制对齐的朗读文本，`am align build` 把对齐器的逐字结果匹配回终稿，写出 `voice.srt`、`phrase-timeline.json` 与对齐报告。受保护短语里有字对不上（TTS 漏读或对齐丢了）时报错并点出终稿行列号；确需修正短语边界时写进 `production/phrase-adjust.json`，每条带理由，叠加在测量结果上：

```bash
am align text                 # → production/audio/tts-text.txt
am align build --fps 30       # 读 production/audio/align.json，分段时 --align align-02.json@312.48
```

镜头时长不手算。分镜计划 `production/scene-plan.json` 只写每个镜头从哪条字幕或哪个短语开始、切在空白的哪一侧，由 `am scene cues` 推出整数帧区间，写进各镜头的 `duration_seconds` 与 `timing` 块：

```bash
am scene cues --plan production/scene-plan.json --srt transcription-production.srt \
  --phrases production/phrase-timeline.json --total-frames 5400 scenes/
am scene cues --check ...   # 同样的参数，只核对不写，发现手改过的时长
```

渲染前 `am` 把镜头局部数据写成镜头目录里的 `am-scene.js`（`window.AM_SCENE`：画布、安全区、字幕规范、换算成镜头局部帧的字幕与短语），渲染提示词里同时附上局部时间表，渲染器不再自己从全片字幕里做减法。随 `am init` 下发的 `scene-kit` 技能读这份数据，提供按帧驱动的字幕组件 `SceneKit.captions`、`SceneKit.safeRect` 与缓动、淡入淡出、固定种子随机数等工具，免得每个镜头各写一套字幕代码。

镜头各自渲染、互相看不到，跨章节时常常硬切到一套全新的画面。分镜计划可以写全片配色 `look`、每个镜头的章节 `chapter`，并在交界后面那个镜头上写交接约定 `handoff`：手法（`carry` 接力、`match` 形状匹配、`push_in` 推进穿越、`flood` 色块铺满、`pan` 平移续接、`settle` 退回底色）加一句交界那一帧的画面描述。章节交界必须写，相邻两个章节交界不得用同一种手法。`am scene cues` 把同一份约定写进两侧镜头的 `timing.exit` / `timing.enter`，两个渲染提示词都会要求画出这一帧，并算好字幕之间可用于交接动作的空档；`am review` 比对这些交界的前后两帧，没接上就判不合格。

已有合格产物且输入没变的镜头会跳过。产物通过校验时，`am` 把输入指纹记在镜头目录的 `.am-render.json`：组好的渲染提示词、`scene.json`、`prompt.md`、字幕、视觉规范、角色包、渲染工具、技能内容与 `am` 版本，逐项记摘要。输入变了的镜头标记为 stale，报告里写明是哪几项变了，使用 `--force` 明确重渲染；没有记录的老产物仍按修改时间判定。每次渲染尝试写一份 `render-<镜头编号>.attempt.json`（耗时、结果、退出码、能读到时的 token 用量），重跑前上一次的产物与日志先归档进 `attempts/`。中断时停止新任务、终止在飞进程组，并写出部分报告。

## 多角色叙事

用 `am init --narration cast` 建的项目里，`cast.yaml`（登记班底）与 `cast/` 目录的存在本身就是模式开关：老项目没有这两样东西，行为一个字不变。

一个角色包是 `cast/<id>/` 下的一个目录：`character.yaml` 是唯一真相源（音色、rig 关节、姿势、可选的多视图与转身路径），配一份（或每个视图各一份）`rig.svg` 骨架图，`dna.md` 写人设供编排 agent 读、不参与渲染。

```bash
am cast new heiwa                  # 生成角色包骨架并登记进 cast.yaml（voiceId 留空待填）
am cast add ../shared-characters/heiwa   # 引入外部角色包：拷贝进 cast/ 并登记进 cast.yaml
am cast validate                   # 校验 cast.yaml 登记的全部角色包，重新生成 character.json
am cast preview cast/heiwa         # 每个命名姿势渲一张 contact sheet，人眼验收角度是否合理
```

手改 `character.yaml` 后不会自动同步：`character.json` 只在 `new`/`add`/`validate` 成功时重新生成，渲染机读取的是后者，改完一律先跑一次 `am cast validate`。这条命令还会顺带提醒当前 `TTS_PROVIDER` 是否缺音色（不影响退出码，供作者在做完角色包的第一时间就看到）；发布前的硬校验在 `am validate cast`，见下方「校验与归档」。

分说话人合成的配音需要重建成一条时间线，再按拆定的镜头切成节拍——这两步都是"算错了不会报错，只会让成片嘴和字对不上"的机械计算，因此收进 Go：

```bash
am dialogue assemble               # 读 production/audio/plan.json，拼出 voice.wav / SRT / dialogue.json
am dialogue beats                  # 镜头拆定后，按 dialogue.json 重算各 scene.json 的 cast.beats
```

作业规程（对话体脚本怎么分段、镜头 `scene.json` 的 `cast` 块怎么写）随项目下发在 `PROMPT-CAST-ADDENDUM.md`，`cast.yaml` 存在时生效。

## 渲染记忆

渲染记忆让项目随使用越来越懂用户，也让下一次渲染比这一次好。默认打开，`MEMORY=off` 关闭。记忆属于 `am`，存成纯文本放在用户级目录（默认 `~/.local/share/am/memory`，`AM_MEMORY_DIR` 可改），不写进任何工具私有的记忆。

| 层 | 内容 | 怎么来 |
|---|---|---|
| 经历 | 一次渲染尝试或一条人工反馈：冻结的镜头输入、召回了哪些记忆、各项校验结果 | 每次 `am scene run` / `run-all` 自动写入 |
| 经验 | 一条可检验的约束，配正例、反例，写明由哪个校验器判定 | `am memory consolidate` 从反复出现的失败里提炼，考试通过才生效 |
| 偏好 | 用户的长期取向（「以后都…」「我不喜欢…」） | 对话里亲口说的由编排工具用 `am memory remember` 当场记下并生效；👎 反馈整理出的要人确认；标注「未经机器验证」 |

每个镜头开工前，`am` 按镜头特征（中文、画幅、角色、卡点、交接手法……）和关键词召回相关的几条，注入提示词里固定的「记忆」段，所有渲染工具收到逐字相同的文本；总字数受 `MEMORY_RECALL_BUDGET` 限制，经验最多 3 条。正式渲染时有 `MEMORY_EXPLORE`（默认 10%）的镜头会把排最后的一条经验换成排在上限外的一条，给它们攒效果样本；这是这一批渲染的决定，不改变镜头是否过期。召回的记忆是输入指纹的一项，记忆一变，相关镜头会被判成 Stale 并注明「召回的记忆变了」。

```bash
am memory recall scenes/scene-001        # 这个镜头会想起什么、为什么
am memory consolidate                    # 失败经历 → 试用经验（由 ORCHESTRATOR 起草，过格式校验）
am memory exam --renderers claude,codex  # 回放考试：错题 + 留出题 × 渲染工具 × {对照, 试用}
am memory feedback scenes/scene-003 --down --note "字幕压住了图表"
am memory remember --name slow-pacing "节奏慢一点，每个画面多停一秒"   # 加 --global 对所有项目成立
am memory report                         # 按批次对比一次通过率、重试、问题数、耗时与 token
am memory import ../旧项目                # 把已有项目的渲染历史导入为种子经历
am memory status                         # 现状、待沉睡候选；手改记忆文件后用它记成新快照
am memory rollback --to 3                # 回到任意快照，不删历史
```

新经验先进入试用，只在考试里使用。考试按确定性校验评分，试用组总分要严格高于对照组，且在任何一个渲染工具上、任何一道对照组做对的题都不能做错，留出题的通过数不能下降；渲染工具自身故障使整场考试无效而不是记 0 分。生效记忆集合每变一次就生成一个快照，项目可以用 `MEMORY_SNAPSHOT` 钉住某个快照。

除了产物校验与确定性扫描，`am validate reads`（阅读时间）、`am review`（交接）、`am scene frames --check-blank`（空白帧）查出的问题也记到对应镜头上，参与整理。只由阅读时间或交接判定的经验要看整片，考试考不了，由人确认后生效。Studio 里每轮对话说的话和回退也会记下：反复提的同一个要求、被回退的改动会被整理成待确认的偏好，编排工具会在对话里找机会问你。

偏好同时交给编排工具：`am run` 与 Studio 对话开工前都会读到「用户偏好」段，用户随口一句话也能按以往的取向补全意图。

不同模型犯的错不一样。每次渲染都记下实际用的模型（claude、qoder、codebuddy 从输出流读，codex 读 `config.toml`，opencode 记为未知），失败按「渲染工具/模型」分布交给整理者；只在某个模型上成立的经验写 `applies_when.renderers` / `models` 限定范围，召回只给对应的渲染工具和模型。效果统计也按「渲染工具/模型」分开；模型换了以后 `am memory status` 会提示重考，`am memory exam --retest <名字>` 对照组去掉它重考。经验正文里不写工具名或模型名、不照抄镜头文案或素材名，`checked_by` 只能引用 `am` 已有的校验器 ID（`output.*` 与 `determinism.*`）。

考试的每一格都是一次真实渲染，渲染次数 = 题数 × 渲染工具数 × 2 × `--repeat`，默认最多 4 道错题。

## 安全模式

外部 AI CLI 默认限制在项目工作区。若某个已安装版本不支持受限的非交互模式，命令会失败关闭，不会自动扩大权限。

只有确认项目和输入可信时才使用：

```bash
am --unsafe run
```

`--unsafe` 会传递给嵌套镜头任务。安全模式需要额外传递的环境变量通过 `AM_PASSTHROUGH_ENV=NAME1,NAME2` 显式列出。

安全模式下，编排工具（`am run`）只被放行文件编辑和一组命令：`am`、`ffmpeg`、`ffprobe`、`ls`、`mkdir`、`am hyperframes`（am 管理的固定版本 HyperFrames CLI，包含在 `am` 里），以及 `TTS_PROVIDER` 与 `ALIGN_PROVIDER` 各自对应的那一个命令（如 `mmx`、`edge-tts`、`mlx_audio.stt.generate`；`funasr` 对应 `python3`）。安装命令（`brew`、`pip`、`uv`、`npm`）不在其中，相关工具要先自己装好。各工具的实现方式不同：

| 工具 | 安全模式的限制方式 |
|---|---|
| claude、codebuddy | `acceptEdits` 加 `--settings` 白名单；`.env` 禁读。Claude Code 的 `acceptEdits` 自身还会放行工作区内的 `touch`、`mkdir`、`rm` 等文件系统命令 |
| qoder | `accept_edits` 加逐条 `--allowed-tools` |
| codex | 没有命令白名单，由 `workspace-write` 沙箱限制写入范围；为了 TTS 放开了沙箱网络 |
| opencode | 没有可用的白名单机制，安全模式下仍能执行任何命令 |

codebuddy 的这套参数没有经过完整实测。

`am run` 的终端输出是整理过的事件：开头打印会话 id，正文原样打印，每次工具调用一行摘要，失败的工具结果用 `✗` 标出，结尾打印用量。

## 用量

每次 `am scene run` 结束都会打印这一次的 token 用量与费用（工具报了才有），`am scene run-all` 的汇总与 `--report-json` 里有每个镜头这一批的合计。编排工具的用量也记账：每次 `am run`、Studio 每一轮对话各记一行到项目的 `production/usage/orchestrator.jsonl`，失败与取消的调用照样记入。查整个项目花了多少：

```bash
am usage                        # 本项目合计：渲染 + 编排，分别按渲染工具/模型、按来源列出
am scene usage scenes/          # 每个镜头全部尝试（含失败、重试与归档）的合计，按渲染工具/模型分开
```

`am memory consolidate` 的整理者不属于哪个项目，用量记在记忆库的 `orchestrator-usage.jsonl` 里，`am usage` 单列、不计入项目合计。

各工具的口径统一为：输入含缓存命中，输出含推理 token。Studio 的镜头时间线显示本项目累计用量（悬停看渲染与编排的分项），镜头工具栏显示每个镜头的累计用量。

## 视觉检查与拼接

渲染成功不等于画面正确：文字压在图形上看不清、中文字体静默回退成方框、动画在中途就停住，这些都能拿到退出码 0。抽帧看图是唯一能提前发现它们的手段。

```bash
# 抽帧供视觉验收，--at 支持秒数、百分比与 end
am scene frames scenes/scene-001 --at 0,50%,end
am scene frames scenes/scene-001 --at 0 --check-blank   # 空白封面直接判失败
am scene frames scenes/scene-001 --strip 1.2:1.6        # 区间内每一帧拼成条带，看动作与转场
am scene frames scenes/scene-001 --at 50% --crop 88,1180,904,160   # 原始分辨率看局部小字

# 静态扫描合成源码的确定性问题（渲染后的产物校验会自动跑同一套规则）
am scene lint scenes/scene-001

# 按镜头顺序拼成静音母版，规格一致时全程 -c copy
am concat scenes/ --out production/silent-master.mp4 --dry-run
am concat scenes/ --out production/silent-master.mp4
```

`am concat` 不提供重定时能力。分辨率或帧率与母版不符时直接失败并要求回镜头工程重渲染，而不是缩放或改帧率——前者损失画质，后者会动到时间轴。

镜头产物校验除了画幅、帧率、时长与无音轨，还逐帧解码核对总帧数（时长容差能放过差几帧的产物），并扫描渲染实际加载的 HTML/JS/CSS：读时钟、`Math.random()`、`requestAnimationFrame`、`setInterval`、无限 `repeat`、渲染时联网、在线字体与未固定版本的 CDN 库都会让同一帧在两次渲染间不同；`@font-face` 指向镜头目录里不存在的文件、或 `font-display` 写成 `swap` / `fallback` / `optional`，会让字体静默回退。命中即判失败且不重试。渲染路径确实不经过的交互代码可在同一行注释写 `am-allow-nondeterministic: 理由` 豁免，豁免项照样写进报告。

`am scene run-all` 按镜头时长从长到短派发，避免排在末尾的长镜头独自拖长整批耗时；并发渲染时按 `(CPU 核数 - 2) / 并发数` 给每个镜头分配 HyperFrames 的 `--workers`，并按「一半物理内存 ÷ 每个 Chrome 1.5GB ÷ 并发数」封顶，免得几个渲染各自按独占整机估算、合起来超订 CPU 和内存。

## 平台封面

交付物里除了成片，还按发布平台另出封面图。它们用本片的视觉规范和画面主体分别构图，不拿成片截帧，也不互相缩放；源文件放在 `covers/src/`，各自是一个 1 秒的 HyperFrames 合成，`check` 通过后用 `snapshot` 出图，文件名 `covers/<平台>-<宽>x<高>.png`。

| 平台 | `platform` | 封面比例 | 推荐尺寸 |
|---|---|---|---|
| 抖音 | `douyin` | 横 4:3 + 竖 3:4（两张都要） | 1440×1080、1080×1440 |
| 小红书 | `xiaohongshu` | 竖 3:4（也接受 1:1、4:3） | 1080×1440 |
| 微信视频号 | `channels` | 竖 3:4（也接受 16:9） | 1080×1440 |
| B 站 | `bilibili` | 横 16:10，标题放进居中 1600×1080 安全区 | 1920×1200 |
| 知乎 | `zhihu` | 横 16:10 | 1920×1200 |

封面登记在 `publish.md` 的 `cover.images`（`{platform, ratio, path, width_px, height_px}`），同一张 3:4 可以登记给多个平台。`am validate publish` 按上表核对：平台是否接受该比例、文件是否在项目内且为 PNG / JPEG、实测宽高与声明一致且比例精确、短边不小于 1080；状态为 `ready` 时，`platform` 对应平台要的封面必须齐全。规格依据 2026-10 的检索，官方帮助页多需登录，知乎一项来源单一。

## 校验与归档

```bash
am validate publish publish.md --project-root .
am validate style --project-root .
am validate style --project-root . --regenerate-examples  # 需要 rsvg-convert 与 magick

# 多角色项目：班底、对白时间线（dialogue.json）与镜头节拍是否互相吻合；
# 单口播项目（没有 cast.yaml）自动跳过，退出码 0
am validate cast --project-root .

# 成片机器验收：画幅、帧率、编码、像素格式、帧数、音轨一次全查，不符项一次列全
am validate video production/silent-master.mp4 --silent --decode
am validate video final.mp4 --audio --expect-frames 8340 --check-frame-zero \
  --report-json production/final-check.json

# 字幕时间轴与配音逐条比对：用能量包络独立判定每一刻有没有声音，拦下整体偏移与漏字幕
# 每个可读元素的停留时间够不够读、是否早于口播出现、顺序是否与口播一致
am validate reads

am audio check --audio production/audio/voice.wav --srt production/audio/voice.srt

# 整片复查：音画时长、总帧数与镜头帧数之和、镜头交界帧，按镜头生成联系表，每个交界出一张逐帧条带；
# 有音轨时实测成片积分响度与真峰，偏离 frame.md 目标只作提示；音画差超过一个 AAC 帧（1024 采样）也只作提示
am review final.mp4 --scenes scenes/ --out production/review

am archive --dry-run
am archive
```

`--expect-frames` 与 `--decode` 会完整解码一遍，代价与文件长度成正比，所以默认关闭。判断结果读 `--report-json` 落盘的文件，不要解析终端输出。

归档在共享文件有修改或存在 ignored 文件时拒绝执行。成功后单片文件连同 SHA-256 清单移到仓库外归档目录，工作区 detach 到冻结的 `main` 提交。

## 开发

```bash
go test ./...
go test -race ./...
go vet ./...
go build ./cmd/am
```

项目采用 [Apache License 2.0](./LICENSE)。HyperFrames 是独立的 Apache-2.0 项目，ArticleToMotion 初始化时使用固定版本，不在本仓库复制本机技能目录。

内置技能 `text-to-lottie` 的 `references/` 裁剪自 [diffusionstudio/lottie](https://github.com/diffusionstudio/lottie)（MIT），版权声明与改动记录见 `assets/shared/.agents/skills/text-to-lottie/` 下的 `LICENSE` 与 `ATTRIBUTION.md`。

## 可选：单人歌曲讲解

默认口播和多角色流程不变。歌曲模式先生成候选，用户试听选定后再对齐、分镜；
首版不支持歌曲与 cast、口播混排。`am` 仍是单个 Go 二进制。

```bash
am init my-song --canvas vertical-3x4 --delivery song
cd my-song
# 查看平台开通要求、密钥申请入口与配置方法
am song providers
am song configure --provider fal       # 示例：托管 ACE-Step，无需部署
# 按输出在本机设置 FAL_KEY，再编辑 lyrics.txt 与 song.yaml
am song doctor
am song generate                       # 默认两首，串行；完成后停止供用户试听
am song select <candidate-id>           # 由用户确定
am song prepare
# 核对唱词、术语和句首时间；有异常先修正报告旁的 timeline-draft.json
am song prepare --timeline production/song/timeline.json --reviewed
# 按实际音频制作 scene.json，镜头时长均为整数帧
am song cues scenes/
am validate song
am scene run-all scenes/ --song-timeline production/song/timeline.json
am concat scenes/ --out production/silent-master.mp4
am song mux production/silent-master.mp4 --out final.mp4
```

已有项目运行 `am song init`，只补歌曲配置、提示词和技能，不覆盖不同内容的文件。
`am run` 检测 `song.yaml` 后使用歌曲入口；显式提供其他提示词仍追加歌曲契约。
外部歌曲用 `am song import song.mp3 --lyrics lyrics.txt` 导入，再试听选定。

### 网页生成，提供音频后继续

没有 API 权限也能使用。选择网页模式后，`am run` 根据文章创作歌词和风格，
展示两段可复制文本并暂停，等待你在网页生成歌曲，再上传 MP3/WAV 或给出本机路径。
同一会话可以继续，也可以再次运行 `am run` 读取交接记录续做，无需一直保持进程运行。

```bash
am song configure --provider manual
# 写好 lyrics.txt 和 song.yaml 中的 style 后：
am song handoff
# 在网页生成、下载，再接收文件：
am song receive /path/to/downloaded-song.mp3
# 用户试听确认后才 select；随后 doctor、prepare 和原有视频流程
am song select <candidate-id>
```

`manual` 模式下 `am song generate` 也只输出交接材料，不请求 API。
歌词与风格快照在 `production/song/handoffs/`，等待/接收状态在 `web-handoff.json`。
接收使用交接时的歌词，不受之后编辑项目歌词影响；等待期间要改材料，需明确运行
`am song handoff --refresh` 并在网页重新生成。网页若修改了歌词，请提供最终歌词并用
`am song import AUDIO --lyrics FINAL_LYRICS` 导入。上传文件不等于确认选定，仍需试听确认。

`am song providers [平台]` 无需项目即可查看申请入口、模型、权限限制与密钥状态；
`am song configure` 只修改平台相关设置，保留歌词、曲风和 YAML 注释，不保存密钥、不产生调用费用。

| 平台 | 配置命令 | 本机环境变量 / 接入条件 |
|---|---|---|
| 网页手动 | `am song configure --provider manual` | 无需 API Key；输出歌词和风格后等待用户提供音频 |
| Mureka | `am song configure --provider mureka` | `MUREKA_API_KEY`；默认 `mureka-9.5`，API 额度与网页会员分开 |
| Google Lyria | `am song configure --provider lyria` | `GEMINI_API_KEY`；默认 `lyria-3.5`，需对应 Gemini API 权限及计费 |
| 百炼 | `am song configure --provider bailian --workspace YOUR_WORKSPACE_ID` | `DASHSCOPE_API_KEY`；北京地域普通按量 Key、Fun-Music 邀测；当前 Token Plan 不覆盖 |
| ElevenLabs | `am song configure --provider elevenlabs` | `ELEVENLABS_API_KEY`；Music API 权限及付费额度 |
| fal | `am song configure --provider fal` | `FAL_KEY`；托管 `fal-ai/ace-step`，无需部署 |
| MiniMax | `am song configure --provider minimax` | `mmx` 登录；部分账户音乐 API 返回 410，不再向新用户开放 |
| 自建 ACE-Step | `am song configure --provider acestep --endpoint https://YOUR_SERVER` | `ACESTEP_API_KEY`（按服务要求）；需已有服务 |

密钥只在本机终端/密钥管理器设置，不写入 YAML 或项目 `.env`。`am run` 嵌套调用
还需显式追加对应变量名，例如：

```bash
export AM_PASSTHROUGH_ENV="${AM_PASSTHROUGH_ENV:+${AM_PASSTHROUGH_ENV},}FAL_KEY"
```

`doctor` 对托管平台仅检查密钥存在性，不代表权限或额度验证成功。
百炼固定歌词模式会忽略曲风提示，不发送时长/BPM 控制参数；ElevenLabs 使用固定歌词的
composition plan；fal 使用独立队列协议，不能填入自建 ACE-Step 地址。
Mureka 每次请求显式生成一首，避免服务默认两首造成额外费用；歌词最多 5000 字符，
曲风加生成要求最多 1024 字符。Lyria 使用带原歌词的 Interactions 请求，接收完整内联
MP3 音轨；同步请求中断不自动重发。两者的目标时长和 BPM 均为创作提示，
模型返回的歌词或时间标注不会替换项目原歌词或已审核时间轴。

相同配置、歌词和 `--batch` 复用候选。ACE-Step / fal / Mureka 已取得任务 ID 时重复原命令
继续轮询和下载，不重新提交；无任务 ID 的不明请求停止，人工检查后才用新
`--batch` 创建新请求。不自动换提供方。`--timeout` 默认 30 分钟。

对齐工具在仓库外的 Python 3.11–3.13 环境安装：

```bash
python3 -m venv "$HOME/.venvs/am-song"
"$HOME/.venvs/am-song/bin/pip" install \
  'xingyu-lyrics-aligner[alignment] @ git+https://github.com/wangjiqing/xingyu-lyrics-aligner.git@e647b2f3480a9f46a027352713c8e2072d88450d' \
  'librosa==0.11.0'
# 按 Xingyu 官方说明单独准备中文模型；am init 不安装环境或下载权重。
```

将 `song.yaml` 的 `python` 设为该环境 Python 的绝对路径。固定 Xingyu v0.6.1；
librosa 缺失或分析失败会明确降级为歌词驱动，不制造节拍。原始对齐输出、
问题清单及行映射保存在 `production/song/alignment/`；估算字词不会用于逐字同步。
对齐成功不代表唱词正确：人工核对核心知识和术语，抽查句首误差目标 ≤200 ms。
通过 `--timeline FILE --reviewed` 导入修正版前仍会校验摘要、歌词顺序及所有时间。

统一时间轴及其 SRT/短语数据位于 `production/song/`。重复副歌具有独立 ID，
无歌词区段单独记录。镜头从零覆盖完整音频，总帧数向上取整；合成仅在末尾补
不足一帧的静音，不变速、不额外叠 BGM。选歌、音频、歌词或时间轴变化会拒绝
旧镜头依赖；重跑 `song cues` 后使用 `scene run-all --force` 重渲染。

普通测试使用模拟服务，不产生付费调用。真实服务样片需独立验收，不能以
自动化测试代替歌曲内容、对齐误差或视觉质量验收。

## 可选：无配音卡点（开发中）

画面上有文字、没有配音，镜头切点全部落在音乐重拍上。目前已完成节拍网格与按小节切镜头；
渲染提示词、整片切点复查与 AI 生成纯音乐、代码合成配乐还在后续阶段。

```bash
am init my-reel --canvas vertical-9x16 --delivery beat    # 已有项目用 am beat init
# 在独立环境安装固定版本的节拍分析，并把 beat.yaml 的 python 指向它
python3 -m venv "$HOME/.venvs/am-beat"
"$HOME/.venvs/am-beat/bin/pip" install 'beat-this==1.1.0'
am beat doctor                       # 首次运行下载模型权重
am beat import track.mp3             # 授权来源记进素材账本
am beat analyze                      # 草稿网格 + 试听轨 production/beat/grid-click.wav
am beat regrid --meter 4 --anchor 1  # 试听发现重拍整体错位时才需要
am beat confirm                      # 听过试听轨、确认重拍都在小节开头后执行
am beat bars                         # 查每个小节的起止，按小节写 production/beat/plan.json
am beat cues scenes/                 # 写入各镜头的整数帧时长与 beat 块
am validate beat
```

`plan.json` 只用小节数描述镜头，例如 `{"schema":1,"scenes":[{"id":"scene-001","bars":2}]}`，
小节合计必须等于网格小节数；第一个重拍之前的弱起并进第一个镜头，最后一小节延伸到音乐结束。
切点帧号只由「重拍秒数 × fps 四舍五入」一个公式算出，`am beat cues` 写入的镜头时长不要手改，
改了会被 `am validate beat` 与渲染前的检查拦下。

节拍分析用 [beat-this](https://github.com/CPJKU/beat_this)（ISMIR 2024，代码与权重均为 MIT），
同时给出普通拍与重拍，CPU 可跑；不依赖 madmom。草稿网格从不直接生效：模型可能把重拍整体错位
或判错拍号，必须听过试听轨再 `confirm`。
