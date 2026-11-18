# 仓库规则

本仓库是片场的工具本体，交付物是 macOS 桌面客户端（`apps/desktop`，Electron）。`onset`（`packages/cli`，打成一个 JS 文件，由客户端自带的 Electron 当 Node 运行）只随客户端留在 .app 里给客户端自己用——后台任务直接调它，编排工具与渲染器经它的工具服务（MCP，见「onset 的工具服务」）调用——**命令行不对外提供**：没有安装到终端的入口，README 不教终端用法，提示词不教 `onset <命令>`。开发与 CI 照常在终端里用它。客户端与 onset 共用一份 TypeScript 引擎 `packages/engine`。它**不是**视频项目：这里不制作视频，也不存放任何单片内容。给视频项目用的规则是 `assets/shared/templates/project-rules.md`，那份文件随项目骨架下发到用户项目的 `templates/project-rules.md`，不约束本仓库的开发。

| 目录 | 内容 |
|---|---|
| `packages/engine/src/<包>/` | 引擎。包的公开 API 从各自的 `index.ts` 导出，外部用 `@onset/engine/<包>` 引用。编码约定见 `packages/engine/CONVENTIONS.md`——为了与用户已有的项目文件、记忆库和渲染指纹逐字节兼容，JSON、数字格式、正则都有固定写法 |
| `packages/cli/src/` | onset：制作步骤是操作表里的操作（`ops/op.ts` 的 `defineOp`，各模块加载时登记，例如 `scene_cmd.ts`；内置插件的操作经 `plugin_ops.ts` 订阅登记表），工具服务、客户端后端与开发用的命令行都从这张表来；`cli.ts` 只另挂 setup、init 与两个 MCP 服务。esbuild 打成 `packages/cli/dist/onset.cjs` |
| `apps/desktop/` | Electron 客户端：主进程 `src/main/`，React 19 界面 `src/renderer/`，端到端测试 `e2e/` |
| `assets/` | 随客户端下发的内置资产，运行时从磁盘读，见「内置资产」 |

## 命令

```bash
npm ci
npx tsc --noEmit -p packages/engine
npx tsc --noEmit -p packages/cli
npm run typecheck -w onset-desktop
npx vitest run --root packages/engine
npx vitest run --root packages/cli
npx vitest run --root apps/desktop     # 客户端界面里的纯函数
npm run build -w @onset/cli          # → packages/cli/dist/onset.cjs
npm run build -w onset-desktop       # → apps/desktop/out/
npm run test:e2e -w onset-desktop    # Playwright 的 Electron 模式，会先构建命令行与客户端
npm run dist -w onset-desktop        # 本机出一份应用目录（apps/desktop/release/）
npm run generate -w @onset/engine    # 由画幅表与模板重新生成 assets/presets/<画幅>/frame.md
```

CI（`.github/workflows/ci.yml`）跑类型检查、引擎、命令行与客户端的 Vitest、构建、生成器幂等与 e2e；发布（`.github/workflows/release.yml`）在推 `v*` tag 或发布 GitHub Release 时构建 macOS arm64 / x64 DMG 与 Windows x64 NSIS 安装程序；两平台成功后统一上传及生成 SHA-256 校验文件。打包脚本回归测试在两平台 CI 中必须通过，Windows 运行功能仍处于移植阶段。

## 开发约定在哪

细节按领域放在 `docs/dev/`。**动到哪个领域，先读那一份**；文中「见「某节」」按下表找到对应文件。改了约定就改那一份，不要往这个文件里加细节——这里只放索引、命令与对所有改动都成立的几条（`packages/engine/src/project/agentsdoc.test.ts` 卡着大小，并核对下表的文件都在）。

| 文件 | 节 | 什么时候读 |
|---|---|---|
| `docs/dev/assets.md` | 内置资产 | 改 `assets/` 两棵源树、`project.initialize`、点开头的下发条目 |
| `docs/dev/render-resources.md` | 共享渲染资源 | 字体、vendor 库、`.onset/resources` 共享池、资源指纹 |
| `docs/dev/skills.md` | 技能树 | 内置 / 上游技能、HyperFrames 技能与 CLI、前置资源与「开箱即用」、`toolpath` |
| `docs/dev/canvas-presets.md` | 画幅预设 | 画幅表、`frame.md` 模板与生成器、SVG 转 PNG |
| `docs/dev/film-styles.md` | 整片风格 | `filmstyle`、lemo / anidoodle / huashu 三个来源 |
| `docs/dev/prompts-and-flows.md` | Prompt 文件、流程与站、制作提示词的写法 | 改 `assets/prompts/`、插件段落、`flow` 的站与流程、制作路线的判断 |
| `docs/dev/third-party-plugins.md` | 第三方站 | 插件清单、装与升级、插件中心、操作与页面沙箱、钩子、渲染技能、风格库 |
| `docs/dev/builtin-plugins.md` | 内置插件 | `plugin` 登记表、`plugins/<id>/`、卡点 / 歌曲 / 多角色 / 发布的登记 |
| `docs/dev/media-checks.md` | 媒体校验与拼接 | `mediaprobe`、`concat`、产物校验、确定性扫描、`review`、阅读时间检查 |
| `docs/dev/scene-timing-and-reuse.md` | 镜头时长、局部数据与复用 | 对齐、`scene_cues`、交接与修接缝、共用组件、镜头扩展块、指纹与渲染记录、续接、用量 |
| `docs/dev/render-memory.md` | 渲染记忆 | `memory` 包、记忆面板、进化页 |
| `docs/dev/auditions.md` | 试镜与模型互学 | `audition`、试镜页、学习关系、范例库 |
| `docs/dev/beat.md` | 卡点模式 | `beat` 包、节拍分析环境 |
| `docs/dev/covers.md` | 平台封面 | `publish.md` 的封面规格、`safeRelative` |
| `docs/dev/ops.md` | 操作表 | 新增或修改一条 onset 操作 |
| `docs/dev/tools-mcp.md` | onset 的工具服务（MCP） | `toolsmcp`、执行进程、各家挂 MCP 的方式、工具输出精简 |
| `docs/dev/desktop.md` | 桌面客户端 | 总览；外壳、后端、界面、端到端测试各一份：`desktop-shell.md`、`desktop-backend.md`、`desktop-ui.md`、`desktop-e2e.md` |
| `docs/dev/ai-cli.md` | 新增一个 AI CLI | 任何一家编排 / 渲染工具的调用、权限、沙箱、审批、技能挂载 |
| `docs/dev/director.md` | 制作人（自带的编排工具） | `director`、`packages/cli/src/agent`、模型服务与 key |
| `docs/dev/prompt-optimizer.md` | 提示词优化 | 润色、检查画面描述 |
| `docs/dev/tts-and-aligners.md` | 新增一个 TTS 或对齐工具 | `providers.ts`、配音与对齐适配 |
| `docs/dev/voices.md` | 音色库 | `voice` 包、音色页 |
| `docs/dev/windows.md` | Windows | 跨平台代码、进程组、批处理、数据目录 |

写测试前另读 `docs/dev/desktop-e2e.md` 开头「什么写 e2e、什么不写」：界面细节写组件测试，不新开 e2e 用例。

## 公开树边界

`packages/engine/src/project/boundary.test.ts` 的「public tree contains no private or legacy content」扫描 `git ls-files --cached --others --exclude-standard`，命中即失败。禁止出现的路径包括 `transcription.srt`、`final.mp4`、`publish.md`、`scenes/`、`production/`、`auto-test/`、`article_to_motion/`、`pyproject.toml`、`onset`。

调试产生的单片内容留在仓库外，不要靠 `.gitignore` 遮掩——未跟踪文件同样会被这个测试扫到。

## 子进程环境

`config.childEnvironment`（`packages/engine/src/config/config.ts`）在安全模式下只透传白名单变量。`USER` / `LOGNAME` / `SHELL` 不是凭据但必须保留——macOS 上 claude CLI 缺 `USER` 就读不到 Keychain 登录态，报错却是「Not logged in」，与权限隔离毫无关联，极难排查。

新增白名单项要写清楚理由；需要临时透传由用户通过 `ONSET_PASSTHROUGH_ENV` 决定，不要在代码里放宽默认。
