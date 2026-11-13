# 兼容态清单（任务 I，临时文件，任务结束时删除）

前提：客户端未发布、只有主人在用，不做向后兼容。归类：甲 = 直接删；乙 = 要删但动静大，先给方案再问；丙 = 不是兼容，保留。
「归 G / 归 H」表示在另外两个任务的文件组里，这里只列不动。

## 甲（直接删）

| # | 位置 | 兼容什么 | 删掉的影响 |
|---|---|---|---|
| A1 | `filmstyle/install.ts`（`LegacySkillName`、`legacyManifest`、`legacyDir`、`Manifest.legacy`）、`cli/src/filmstyle.ts` 的「旧版目录」提示、`studio/filmstyle.ts` 的 legacy 注释、`scene/skills.ts` 的 `resolveFilmStyle` 循环里的 `LegacySkillName`（H 的文件，只删这一个名字）、`filmstyle.test.ts` / `scene/filmstyle.test.ts` 的 legacy 用例、AGENTS.md「早先只有一个来源时…」一行 | 只有 lemo 一个来源时装在 `.agents/skills/lemo-film-style/`（`lemo-upstream.json`）的项目 | 那种目录不再被认出；新装的风格都在 `am-film-style/`，行为不变 |
| A2 | `tools/usage.ts` 的 `usageNormalized`（及 `usageAdd`、`formatUsage`、`memory/report.ts` 里的调用）、`usage.test.ts` 的换算用例、AGENTS.md「没有它的老记录读时经 `usageNormalized` 换算」 | 统一口径之前没有 `basis` 字段的用量记录 | 老记录按原数字相加。`basis` 字段继续写（新记录都带，作为口径标记） |
| A3 | `ledger.SourceRun`、`usage_cmd.ts` 的「命令行（旧）」标签与说明里「早先命令行版本记下的旧账照样统计」（H 的文件，只改这两处）、`Preview.tsx` 的 `usageSources.run`、AGENTS.md 对应半句 | 命令行 `am run` 时代记下的编排账 | 旧账仍会按来源原样统计，只是没有中文标签 |
| A4 | `studio/studio.ts` 的 `inspectProject`：`media`（audio/final/publish）、`issues`（读 review.json 的 `issues`）、`projectMetadata` 的 `style_id` / `style_name` 与「画幅写成标量」分支；`types.ts` 的 `ProjectState.media` / `issues`；`Preview.tsx` 的 review `issues`「早期写法，照样认」 | 旧界面读的 `/api/state` 字段、旧版 review.json 字段名、旧项目 frame.md 的标量 `canvas` | 界面只用 `metadata.canvas` 与 `film_style`，其余字段没人读 |
| A5 | `studio/scenes.ts` 的 `sceneRendering`：没有进行中标记时退回看日志静默 | 旧版 am 起的渲染（没有 `render-<id>.live.json`） | 只认标记；`usage.test.ts` 里按日志判断的用例改成钉「没有标记就不算渲染中」 |
| A6 | `cli/src/reuse.ts` 的修改时间判定、`scene_cmd.ts` 说明里那句（H 的文件，只改这一句）、`scene/record.ts` `loadRecord` 注释 | 引入渲染指纹之前、没有 `.am-render.json` 的老产物 | 没有记录或指纹算不出来时一律标 Stale（要 `force`），不再按 mtime 跳过 |
| A7 | `project/rules.ts`：模板缺失时返回空串 | 老版本 `am init` 出来、没有 `templates/project-rules.md` 的项目 | 缺模板直接报错（新建项目必有） |
| A8 | `memory/importer.ts`：`production/failed-attempts/` 与「只有产物、没有尝试记录」的归档重判（`reverify`、`dropRetimed`、`findOutput`、`linkTree` 等）；对应测试；AGENTS.md「`am memory import` 导入已有项目」一行改写 | 老版本 am 留下的、没有尝试记录的归档 | 导入只读尝试记录（当前与 `attempts/` 归档里的）、review.json 与 reads 清单 |
| A9 | 各文件头与行内的「移植自 internal/…go」出处注释（G、H 文件组除外） | Go 版历史 | 只删注释。「Go 版…」这类解释编码细节的注释随乙档 B2 处理 |

## 乙（要删，先给方案再问；本任务未动）

### B1 旧版内置风格体系

现状：`frame.md` 同时承载画幅（`canvas` 宽高帧率朝向、`safe_area`、`audio` 响度目标）与旧风格 token（配色、字体、版式、`style_id`/`style_name`）；后者 2026-10-20 起不再进渲染提示词。

拆分：
- **画幅还在用的部分**：`preset/table.ts` 画幅表（宽高、帧率、安全区、`platform`、`layoutNotes`）；项目里 `frame.md` 的 `canvas`、`safe_area`、`audio` 三块；读取方 `scene.sceneCanvas` / `styleSource` / `canvasOf` / `audioTargets`、`studio.projectMetadata` 的画幅、`validate.reads` / `review` 的响度目标、`PROMPT-PRODUCTION.md` 里的画幅文字（G）。
- **纯兼容的风格部分**：`assets/styles/<风格>/<画幅>/`（风格说明书、示例 SVG/PNG、风格独有字体）、`templates/styles/*`（含 `custom-draft`）、`preset/style.ts` 的风格表与 `CustomStyle`、`assets/fontpool/` 与 `preset.allFonts`（如只为风格服务）、`styleimage`（SVG→PNG，只给示例图）、`am init --style/--style-brief/--style-brief-file`、`cli/src/canvas.ts` 的 `resolveStyle` 与 `docs/style-brief.md`、`validate.style` / `regenerateExamples` / `validate_style` 操作、`style_cmd.ts`（`am style fonts/add-font`）、`scene.json` 的 `style_guide` 字段与 `defaultCanvas` 回退、`studio/api_ui.ts` 的风格选项（`/api/styles` 只剩画幅）、生成器里的风格 × 画幅组合与 `-examples`、相关测试（`validate.test.ts`「accepts every builtin preset」、`trees.test.ts`、`custom_style.test.ts`、`style_guide.test.ts`、`style_cmd.test.ts`、`style.test.ts`、`gen.test.ts` 的风格部分）、AGENTS.md「画幅预设与风格」「自定义风格」两节大半。

方案：
1. 画幅信息改由 `assets/presets/<画幅>/frame.md` 下发（只含 `canvas`、`safe_area`、`audio`，生成器从画幅表写），`assets/styles/` 整棵删除；`project.initialize` 只叠 shared + preset 两棵树。
2. `frame.md` 保留文件名（读取方、提示词、项目规则都按这个名字找），但只剩画幅三块；`readStyleTokens` 收窄成画幅与响度。`scene.json` 删 `style_guide`，画幅一律就近找项目 `frame.md`，找不到报错（不再回退 1080×1440）。
3. 删 `--style*` 参数、`resolveStyle`、`validate_style`、`style_*` 操作、`styleimage`、风格模板与示例图、fontpool（若只服务风格；中文正文字体在 `assets/shared/assets/fonts/` 不动）。
4. 测试随之删改；`gen.test.ts` 字节比对重新生成。
估计：删 300+ 个资产文件（示例图、说明书）、约 15 个源文件、改 20 余个文件，2000–4000 行净删。会碰 G 的生成器与 `PROMPT-PRODUCTION.md` 产物（画幅文字来自画幅表，不受影响，但生成器入口在 G 文件组），需与 G 协调合并顺序。

### B2 `gojson` / `gofmt` / `rawjson` / `memory/yaml` 的 Go 字节兼容

存在理由：与 Go 版写出的 JSON / YAML / 数字 / 错误文案逐字节一致，渲染指纹、`.am-render.json`、记忆快照摘要都依赖它们的输出。Go 版已不存在；但这些输出现在就是指纹格式本身。
方案：保留「确定性序列化」这一层（同一版本内同输入同输出是硬要求），只是去掉「对齐 Go」的包袱：把 `gojson` 改名并收窄成确定性 JSON 写出（固定键序、HTML 转义规则保持）、`gofmt` 只留真正用到的数字/路径错误格式；删「Go 版…」注释。一次性改变指纹格式会让主人所有已渲染镜头变 Stale（可接受，但应在同一提交里改 `ToolVersion` 或明说）。估计：两包约 600 行、引用点 100+ 处。建议排在 B1 之后单独做，或不做（收益只是去名字）。

## 丙（不是兼容，保留）

| 位置 | 为什么留 |
|---|---|
| `envutil.addToolsLocation` 放在 PATH 最前的只会报错的 `am`（也遮住旧的 `~/.local/bin/am`） | 安全措施：agent 只能经工具服务调 am |
| `CONVENTIONS.md` 的 JSON / 数字 / 正则写法、`gojson`（见 B2） | 指纹与渲染确定性 |
| `boundary.test.ts`、子进程环境白名单、`.env` 禁读、页面沙箱 | 安全 / 公开树边界 |
| `scene.timing` 可为空（`verifyTimingInputs` 放行、`timingSection` 为空） | 卡点、歌曲、第三方流程、测试里的镜头本来就没有 timing 块；要强制只能按流程判断，另起任务。疑点：口播镜头理论上都该有 |
| `scene/record.ts` 没有召回时不加 `memory` 指纹项 | 理由写的是老镜头，但行为本身是「空输入不进指纹」，改了只会让全部镜头 Stale |
| `studio/scenes.ts` 镜头列表的 `stale` 按 mtime | 列表里不算指纹（贵），是现行的轻量判断 |
| `studio.stepOf` 没有标记时按产物推 | 新项目第一轮之前也没有标记 |
| `studio/progress.ts`「没有确认记录但下游已做的算已经过了」 | 用户在对话里点头而不点按钮是现行用法 |
| `studio/storyboard.ts`、`scenes.ts` 没有分镜计划时按镜头目录列 | 卡点项目没有 scene-plan.json |
| `studio/script.ts` 没有终稿时显示原稿 | 第二阶段之前的正常状态 |
| `filmstyle/lemo/fill.ts` 硬链接后 `chmod 0644` | 修的是本机风格库（用户级数据）里早先设成只读的文件，不是项目格式；删了主人现有的风格库会让渲染器的副本变只读。疑点：可在风格库重建后删 |
| `filmstyle/lemo/library.ts` 风格库按 commit 分目录 | 固定版本、可复现 |
| `scene/blocks/cast.ts`、`validate/cast.ts`、`validate_cast.ts`「对老镜头零影响」 | 单人口播镜头本来就没有 cast 块，措辞是旧理由但行为是现行的（cast 相关文件归 H） |
| `procgroup`、`toolpath`、`shellpath`、`prereqs` 里的「退回」 | 运行时降级（Windows、找不到运行时），不是兼容 |
| `studio.ts` / `Preview.tsx` / `studioview` / `flow/builtin.ts` 同时认 `final.mp4` 与 `production/final.mp4` | 疑点：提示词只写根目录 `final.mp4`，`production/final.mp4` 可能是旧位置；`flow/builtin.ts` 归 G，没核实前不动 |
| `version` 包的「兼容检查」、`flow/manifest.ts` 的 `manifest_version` / `requires.am` | 第三方插件清单的格式版本，是对外契约 |
| `memory/lint.ts`、`recall.ts` 里的「旧版」 | 说的是经验的上一版，不是兼容 |
| `beat/env.ts`、`hyperframes/cli.ts`、`prereq`、`studio/setup.ts`、`toolsmcp.ts` 里「以前…」 | 解释现行设计的历史理由，没有兼容代码 |

## 归 G（提示词兼容路径）

`project/runprompt.ts` 的 `legacyRunPrompt` / `promptSource === 'legacy'`、`flow/promptparts.ts`（`applyPluginMarkers`、`insertStageSections`）、`flow/lock.ts` / `flow/flow.ts` 没有流程记录时按标记文件推断、`flow/builtin.ts` 口播顺序里的「卡点分支」、`flow/registered.ts` 的 append 注释、`legacyflow.golden.test.ts`、`composeflow.test.ts` 的 legacy 对照、`flow/types.ts` 的 `marker` 注释、生成器 `preset/gen/gen.ts` 的提示词部分。

## 归 H（插件认领）

`studio/stations.ts` 的 `active_flow.first_tab` / `flow.first_tab`；`scene/skills.ts` 的 `hyperframes` `requiredFiles` 含 `references/*.md`（0.8.14 旧项目的降级告警）与「老镜头指纹不变」注释；`flow/builtinplugins.ts` 的 `am_ops` / `am_skills` / `am_stations`；`plugins/song` 里「与老项目一致」；`scene/blocks/*` 注释；cli `*_cmd.ts` 里的「移植自」注释（本任务只在 A3、A6 动了两处说明）。
