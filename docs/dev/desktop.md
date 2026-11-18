# 桌面客户端

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

`apps/desktop` 是唯一的界面：对话驱动的本地工作台，仿 OpenDesign。主进程（`src/main/`）在项目目录里启动编排工具，把 `packages/engine/src/agentrun` 的统一事件经 SSE 推给界面（`src/renderer/`，React 19），多轮续接同一个 CLI 会话。「开始制作」与 `onset run` 共用 `project.runPrompt`。界面与文档里仍把这套工作台叫 Studio，后端在 `packages/engine/src/studio`。

分成四份：

- 外壳：`docs/dev/desktop-shell.md`
- 后端（`packages/engine/src/studio`）：`docs/dev/desktop-backend.md`
- 界面（`apps/desktop/src/renderer`）：`docs/dev/desktop-ui.md`
- 端到端测试：`docs/dev/desktop-e2e.md`
