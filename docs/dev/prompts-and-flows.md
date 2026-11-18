# Prompt 文件

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

制作提示词不是项目里的文件，也不是生成器的产物：它只有一条路——开工时按项目锁文件里记下的流程，把 `assets/prompts/<站>/<段>.md`（宿主的段落）与 `assets/plugins/<id>/sections/`（内置插件登记的段落，例如发布、歌曲讲解）组合起来（`project.runPrompt` → `flow.composeFlowPrompt`），客户端的「开始制作」把它直接喂给编排工具。改提示词就改段落；要看某个项目现在组合出的全文，用 cli-only 的 `prompt_show`（`onset prompt show`）。`runPrompt` 的 `override`（显式指定一份提示词文件）原样读那份文件，不再组合。

镜头实现的职责边界统一写在 `assets/prompts/host/scene-ownership.md`：口播、卡点、歌曲与复用公共前言的第三方流程都带上，Studio 每轮还从同一文件读取并补发（已经含全文时不重复），因此正常续接的旧会话也能收到新规则。编排只改任务书、执行契约与素材；镜头代码、共用动画模块、复制同步与返修都交给渲染器。不要把这份编排专用限制写进项目根指令文件，渲染子进程也会读它。返修段落不能再直接要求编排「改合成代码」。

对某个流程不成立的话不写成「如果是卡点则…」：把段落拆细，或给它一版按流程挑（插件流程自己的那一版放在插件名下，例如宿主的 `host/head`、`render/stage` 与卡点插件的 `beat-common/head`、`beat-common/render`），由流程的段落顺序决定用哪一版。`project/flowprompts.test.ts` 对每个内置流程的组合结果做内容门禁（哪条断言对哪些流程成立写在测试名里），并用 `testdata/flow-prompts.json` 钉住新建口播、卡点、歌曲项目的全文摘要与阶段标题序列（`ONSET_UPDATE_GOLDEN=1` 重写）；`boundary.test.ts` 的「prompts use installed CLI and do not expose executor identity」对每个流程 × 画幅的组合结果检查。

## 流程与站

制作流程拆成「站」（`packages/engine/src/flow`）：一个站带一段或几段制作提示词（`assets/prompts/<站>/<段>.md`）、制作路线页上的站点（含审核关卡与绑定文件）和它会写的文件（`produces`）；流程（片型）是站的有序组合，既定路线（`Flow.stations`）也定提示词的段落顺序（`Flow.prompt`），写在同一个声明里。宿主只有口播（`speech`）；卡点（`beat`）与歌曲讲解（`song`）由各自的内置插件在 `apply` 里登记。项目用哪个流程只看新建时记下的流程（`flow.detectFlow` / `flow.recordedFlow`），流程只在新建时定；记的是第三方插件的流程（`x:<插件 id>`）而这台电脑没装那个插件时抛 `flow.MissingPluginFlowError`，说清缺哪个插件；没有记录的目录直接抛 `flow.MissingFlowRecordError`，说明锁文件里缺哪一段，不按 `beat.yaml`、`song.yaml` 这类功能自己的配置文件推断。设计稿是 `docs/superpowers/specs/2026-11-11-流程插件-design.md`（本地，不进公开树），以后第三方站也挂在这里。

| 约定 | 原因 |
|---|---|
| 段落正文里不写「第六阶段」，写 `{{STAGE:render}}`（只要数字写 `{{STAGE_N:render}}`），由 `flow.composePrompt` 按阶段在提示词里的先后编号；引用了没有的阶段直接报错。`flow.test.ts` 的「leaves no hard-coded stage numbers in the sections」拦着写死的编号 | 换了站或顺序，交叉引用跟着变，不会指错阶段 |
| 每个流程拼自己的提示词（`flow.flowPrompt(id)`：流程的顺序，插件段落按 `after` 插进去，`append` 段接在最后），`{{STAGE:…}}` 按各流程自己的阶段先后编号；流程可以声明 `stage_aliases`（卡点把两边共用段落里的 `sound` 指到自己的 `beat-sound`）。卡点的顺序（卡点插件的 `beatPrompt`）没有口播稿、TTS、对齐三个阶段，开自己的阶段「故事、音乐与节拍」「按小节拆分镜头」「音乐授权和音效」「音乐与音效的混合」；多角色对话的作业规程由多角色插件登记成站 `cast-rules` 的两段（口播稿阶段末尾一句指向附录、口播流程文末「附：多角色叙事作业规程」），只进口播流程。指向附录的段落用 `focusIncludes` 声明依赖，聚焦阶段时一并带上附录。流程自己的配置由登记流程的插件经 `Flow.check(root)` 在组合前核对（歌曲讲解读一遍 `song.yaml`），`project/runprompt.ts` 不 import 任何功能包。内置流程引用了自己没有的阶段直接报错（`flowprompts.test.ts` 的「references only stages of its own flow」） | 每个流程的提示词只说对这个流程成立的话 |
| 流程记录：新建项目（`projectinit.create`，onset init 与客户端共用）在 `onset.flow.json` 写 `production: {id, canvas}`（`flow.FlowRecord`）；`song_init` 给已有项目补歌曲资产时把记录换成 `song`。`runPrompt` 按它组合（`flow.composeFlowPrompt`）：内置插件的段落按流程的段落顺序参与（流程里没有的就不出现），第三方站的 `inserts` 插在那个阶段末尾、`prompt` 接在最后，第三方流程（`x:<站>`）是公共约定（口播流程第一个阶段之前的几段：`host/head`、`host/work`、`host/renderer`）加 `stations` 里内置站的段落加本站 `flow.prompt`，内置段落引用了它没有的阶段时写成「<标题>」那一步（只有第三方流程有这条退路） | 提示词改了，项目下次开工就用上；没有按标记删段、按标题正则插入这类运行期修补 |
| 没有流程记录的目录：`runPrompt`、`/api/progress`（409 `no_flow_record`）照实报错；`/api/state` 不给 `flow` 与 `step`，改给 `flow_error`，路线页显示这句话 | 客户端还没发布，不为旧版建的项目留兼容路径 |
| 讲解形式（`onset init --delivery`）就是流程：可选值来自有段落顺序的内置流程、内置插件流程与已装的第三方插件带来的流程（`x:<插件 id>`，`projectinit.deliveryFlows`；首页的做法是 `projectinit.presets`，第三方的标明来自哪个插件）；新建时写哪个标记文件（`Flow.marker`）、与什么互斥（`Flow.excludes`：插件、别的片型）由流程声明，`projectinit.validate` 不写死片型 | 新片型不用改 projectinit |
| 改过的文件归哪一站由各站 `produces` 决定（`flow.stationOfPath`）：整条路径 > 前缀加文件名 > 只有前缀，同级比前缀长短；只算当前流程里的站 | 不再维护一张按顺序匹配的手写表，新站声明自己的文件即可 |
| 宿主站点做没做的判断函数留在 `studio/progress.ts` 的 `judges`，内置插件的随站登记（`PluginStation.judges`），键都是「站:站点」；普通站漏了判断函数，`stationDefs` 直接报错（`progress.test.ts` 的「judges every station of every builtin flow」） | 引擎的 `flow` 只有声明，不依赖 `studio`；口播与卡点的「拆分镜头」都叫 `plan`，判断不同 |
| 新增一个宿主自己的站：在 `flow/builtin.ts` 加站与段落、在 `assets/prompts/<站>/` 写段落、在用到它的流程的 `prompt`（`speechPrompt`，插件流程在插件里）里排位置、在 `judges` 里加判断。可选功能不走这条路，写成内置插件在 `apply` 里登记（见下面「内置插件」） | `flow.test.ts` 的「has a template for every section and no orphan templates」查模板与声明一一对应、每一段都进了某个内置流程 |
| `flow/builtin.ts` 的 `builtinStations` / `builtinFlows` / `stageTitles` / `speechPrompt` 只有宿主自己的部分（另导出 `planRules`、`tailStations` 给卡点插件复用）；要「全部」时用 `flow/registered.ts` 的 `allStations` / `allFlows` / `allStageTitles` / `flowPrompt`，它们把内置插件登记的站、段落与流程并进来。路线、关卡、文件归站、清单校验、阶段补充都经它们 | 插件的站不写进宿主的表，新增内置功能不用改 `flow/builtin.ts` |

## 制作提示词的写法

- 要像直接写给人类操作者的任务说明，不暴露执行者是 agent、Codex 或 AI，也不使用「主控 agent」这类身份设定；但可以明确说明他需要操作其他 AI。
- 不得出现 `./onset` —— 用户项目里没有这个可执行文件。
- 制作步骤写成 onset 工具服务里的工具调用：`工具名({参数})`，参数一律按名字（例如 `scene_run({"scene": "scenes/scene-001"})`、`align_build({"fps": 30})`、`scene_frames({"scene": "…", "at": "0", "check_blank": true})`），不写 `--flag`。参数名以操作表为准（`tool_help` 里有）。不教 `onset <命令>`，更不写 `$(onset …)` 这样的命令替换——onset 不在编排工具与渲染器的 PATH 里。前置资源缺了一律指向客户端的工具准备页，不写「在终端运行 onset setup」。`gen.test.ts` 的「keeps the orchestrator out of onset internals」「leaves voice tools to onset setup」钉着。
- 这两条由 `packages/engine/src/project/boundary.test.ts` 的「prompts use installed CLI and do not expose executor identity」强制执行，违反会让测试失败。

第三方插件的约定见 `docs/dev/third-party-plugins.md`，内置插件见 `docs/dev/builtin-plugins.md`。
