# 新增一个 TTS 或对齐工具

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

内置配音统一由 `voice_synthesize`（`packages/engine/src/voice`）执行，编排工具只给文稿、音色和表达参数，不直接运行供应商 CLI；音色发现走 `voice_catalog`，新声音试听走 `voice_design`。对齐沿用已有对齐工具。取值表在 `packages/engine/src/config/providers.ts`（`TTSProviders` / `Aligners`），校验与 `onset config get` 的帮助都从它派生。加一个工具要同步：

| 位置 | 作用 |
|---|---|
| `packages/engine/src/config/providers.ts` | 取值、名称、自带时间戳粒度、宿主内部使用的命令名（配音命令不加入编排工具白名单），以及 `install`：`onset setup` 怎么装它（npm 包 / uv 工具 / uv 专用环境，版本钉死，至少发布两周） |
| `assets/prompts/voice/stage.md`、`timeline/stage.md`（第三、四阶段） | OnSet 操作的用法、各家支持的创作参数与时间戳来源（**不写安装命令**，`gen.test.ts` 的「leaves voice tools to onset setup」拦着），改完跑 `npm run generate -w @onset/engine` |
| `packages/engine/src/voice/synthesis.ts` / `adapters.ts` / `catalog.ts` | 合成与音色查询适配、参数验证、多段文稿默认按段落独立合成并在普通段间插入 650ms（`paragraph_pause_ms`）、`#` 章节空行间插入 1300ms（`chapter_pause_ms`）48kHz 双声道零静音、统一 48kHz 双声道 WAV，保留原始音频与服务响应；不覆盖旧 take，不自动下载 |
| `apps/desktop/src/renderer/components/SetupGuide.tsx` 的 `voiceNames` | 安装页配音卡片上显示的服务名 |
| `assets/shared/onset.conf`、`.env.example`、两份 README | 可选值注释 |

收录门槛是「有可非交互调用的 CLI，且凭据不必落进项目文件」。供应商适配器的参数与返回结构由宿主代码管理并测试；没有账号的服务按固定版本的官方 CLI 文档与响应样本测试，不让编排工具临时写解析脚本。没有自带字级时间戳的路径，`voice.srt` 一律由强制对齐生成，不拿句级时间戳凑。
