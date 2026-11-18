# 桌面客户端 · 端到端测试

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

**什么写 e2e、什么不写**：e2e 只测核心流程——用户从头到尾做一部片子会走过的主干（新建、开工与停下、对话里的改动与回退、审批、口播稿、分镜、渲染进度、制作路线、确认成片与发布、设置、插件的安装与沙箱），加上只有真客户端验证得了的几条（Markdown 安全渲染、原生菜单、桌宠与皮肤的跨窗口、启动首帧、内嵌网页）。每个 e2e 用例都要新开一个 Electron 与一套临时目录（最快 2 秒、中位 5 秒）。其余一律写在 `apps/desktop/src/` 里，由 `npx vitest run --root apps/desktop` 跑、不开窗口：纯函数写 `*.test.{ts,mjs}`；组件写 `*.test.tsx`（首行 `// @vitest-environment jsdom`，用 Testing Library 渲染，后端用 `src/renderer/testing.tsx` 的 `mockApi` 换成一张路由表、对话事件流用 `FakeEventSource`，测试数据按 `types.ts` 写类型，后端字段变了类型检查会拦下）。界面细节、各种展示状态、边角情况都写组件测试，不新开 e2e 用例；真要加 e2e，先想清楚它是不是核心流程。以前客户端没有单元与组件测试，什么都写进 Playwright，e2e 堆到 138 个、CI 要 13 分钟。

`apps/desktop/e2e/` 用 Playwright 的 Electron 模式启动构建好的客户端（`playwright.config.mjs`、`e2e/fixtures.mjs`）。每个用例一套临时目录：HOME、userData（`ONSET_DESKTOP_USER_DATA`）、项目登记（`ONSET_STUDIO_CONFIG`）、记忆库（`ONSET_MEMORY_DIR`），并设 `ONSET_STUDIO_SKIP_SKILL_INSTALL=1` 与 `ONSET_DESKTOP_BACKGROUND=1`（客户端以辅助程序运行：不进 Dock、不激活、窗口不显示、系统通知默认不弹，见 `main.ts`；测通知的用例自己把 `Notification.prototype.show` 换成记录。否则每个用例都弹到最前面抢走开发者的焦点）——记忆默认打开，不设 `ONSET_MEMORY_DIR` 的话每次跑 e2e 都往用户真实记忆库写经历，记忆面板曾被几百条 `onset-studio-e2e-*` 淹没。用例并行跑（`fullyParallel`，本机 4 个，`ONSET_E2E_WORKERS` 可改，调试时设 1；CI 的 macOS 机器只有 3 个核，一台上同时开几个 Electron 每个用例慢 4 倍、音视频用例超时，所以 CI 一次一个，用例少、一台机器就够）：新用例只用 fixtures 给的临时目录与自己的 Electron，不能依赖全局状态、固定路径、固定端口或别的用例的执行顺序。

`apps/desktop/e2e/fake-bin/claude` 是 e2e 用的假编排工具（同目录的 `codex` 只用来显示为「已安装」，被调用时直接失败），`fixtures.mjs` 把它放在 PATH 最前面，并设 `ONSET_DESKTOP_KEEP_PATH=1` 让主进程不再把登录 shell 的 PATH 并到前面（否则真实的 claude 会被先找到）；提示词里带「慢慢来」时它只回报会话然后挂起，供取消测试使用。单元测试里的假工具同理，子进程环境按安全模式白名单构造，测试开关要经 `ONSET_PASSTHROUGH_ENV` 透传。
