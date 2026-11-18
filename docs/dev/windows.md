# Windows

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

通用制作能力不按操作系统分叉：单镜头互斥（`scene/lease.ts`）、计划镜头筛选、音频互斥播放、不可用模型停止续接重试与首次默认风格本地执行（`studio/localactions.ts`）、阅读清单与封面批准校验（`reads/approvals.ts`）、单次解码抽帧，以及代表镜头优先派发和队列日志，两平台共用代码与测试。渲染并发的硬上限经 `schedule/budget.ts` 传到渲染器工具入口；Windows 沿用可用内存预算，macOS 沿用物理内存的一半，不能用空闲内存直接代替 Mac 的可用内存。不要再给这些通用能力加 `win32` 开关或让 Mac 测试断言旧行为。

客户端还没移植完：类型检查与构建在 CI 的 `windows` 任务（`windows-latest`）里必须通过，两包单元测试照跑但失败不挡合并（`continue-on-error`），全部通过后去掉。已经定下的约定：

| 约定 | 原因 |
|---|---|
| 仓库一律以 LF 检出（`.gitattributes`） | Windows 上 git 默认转 CRLF，内置资产按字节下发、指纹按字节算、生成器幂等门逐字节比，全会错 |
| 找可执行文件只用 `envutil.lookPath`：Windows 上按 `PATHEXT` 补扩展名、不看执行权限位；`toolpath.bundled` 同样试 `.exe` / `.cmd` | Windows 的 stat 没有执行位，原先的判断在那里什么都找不到 |
| 环境拷进普通对象一律经 `envMap`（`normalizeWindowsEnv` 把 `Path` 改名 `PATH`） | Windows 上 PATH 通常叫 `Path`；`process.env` 不分大小写，拷出来的对象却分，引擎到处读 `env.PATH` |
| 要整组结束的子进程用 `procgroup` 的 `start` / `groupSpawnOptions` / `killTree`，不要自己写 `detached: true` 与 `process.kill(-pid)` | Windows 没有进程组信号，要 `taskkill /T /F`；`detached` 在那里会弹出新的控制台窗口 |
| `.cmd` / `.bat` 不直接 spawn：`procgroup/windows.ts` 把 npm 的 cmd-shim 改成用 node 跑它的 JS 入口，其余经 `cmd.exe` 转义，多行参数直接报错 | Node 不让直接 spawn 批处理；`cmd.exe` 传不了多行参数，而提示词、MCP 配置正是多行的 |
| Windows 长提示词经 `tools.windowsPromptInput` 改走 CLI 标准输入：Claude 移除位置参数，Codex 用 `-`；保留会话号与其他参数 | Windows CreateProcess 命令行约 32K UTF-16 上限，制作提示词超长会报 `spawn ENAMETOOLONG`；短提示词与其他平台沿用原路径 |
| 启动 onset 一律经 `envutil.onsetCommand`：Windows 上客户端不写 shim，`ONSET_SELF` 就是 `onset.cjs`，用 Electron（`ELECTRON_RUN_AS_NODE=1`）跑；MCP 服务（`onsetToolsServer`、审批服务）与写任务都这样起 | 同上：交给各家 CLI 的 MCP 命令若是 `.cmd`，Node 写的 CLI 起不来 |
| Windows 上写出的批处理（agent 的 `onset.cmd` 只用 ASCII；`node.cmd` 先 `chcp 65001`） | 批处理按系统代码页解析，中文 Windows 是 GBK，UTF-8 的中文与中文路径会读错 |
| 数据目录只经 `envutil.dataDir`：Windows 上是 `%LOCALAPPDATA%\onset`，项目登记在 `%APPDATA%\onset\studio`；`LOCALAPPDATA` 等系统变量在 `envutil.WindowsBaseEnvKeys` 里，进安全模式白名单与工具服务的环境 | Windows 上通常没有 `HOME`；子进程拿不到同一组变量就会算出另一个目录。缺 `SystemRoot` 时 Node、Python 的网络与加密直接失败 |
| 渲染器在 Windows 上全放开：没有系统沙箱，各家自己也不按命令白名单拦（`scene.rendererUnfiltered` → `RendererAccess.unfiltered`，与 macOS 沙箱里同一组参数：claude、qoder 跳过权限，codex 不套自己的沙箱，codebuddy `-y`），`.env` 也不再禁读。镜头技能照样链进各家的目录，用户级技能与设置照常加载（qoder 的 `--setting-sources` 与 opencode 的 `permission.skill` 仍生效） | 用户定的（2026-11）：Windows 上先不要安全，命令白名单只会让渲染器白耗几轮。以后要补目录边界，最接近 macOS 沙箱的是 AppContainer，要在 Windows 真机上验证各家 CLI、Node 与借用的浏览器能在里面跑 |
| Windows 上借用客户端的 Chromium 渲染走引导脚本接管的路（见「开箱即用」），不用包装脚本与 fd 3/4 | 包装只能是 `.exe`；Windows 的管道句柄传法不同。隐藏窗口截图在 Windows 上是否与 macOS 一致只有真机验证得了，用安装页的「试渲染一个镜头」 |

还没做：工具准备页的 Windows 下载表（ffmpeg、uv；借用浏览器之后不再需要无头浏览器）与 `toolinstall` 写出的 sh 包装、测试里的 sh 假工具、Windows 真实安装与 CLI 实测。
