## {{STAGE:render}}：建立镜头目录、并发调度渲染工具

把新镜头的文案和任务书写到 `production/scene-briefs.json`，格式为 `{"scenes":[{"id":"scene-001","text":"本镜头文案","prompt":"创意、交接和验收要求"}]}`，id 与分镜计划一致。调用 `scene_prepare()` 一次生成目录、`scene.json`、`prompt.md`、全片字幕副本和渲染器规则。已有镜头直接修改受影响的任务书；不要重建镜头或写批处理脚本。随后用 `scene_cues()` 写入正式时长。字幕始终使用全片时间。

- 批量渲染或同时返修 2 个及以上镜头时，**必须**用一次 `scene_run_all({"scenes": "scenes/", "srt": "transcription.srt", "strict_coverage": true, "report_json": "production/run-report.json"})`（返修指定镜头传 `only_scenes` 与 `force: true`）由片场统一并发调度，禁止拆成多次 `scene_run()` 逐个派发和轮询；调用 `job_wait` 等待长任务时省略 `wait_seconds`（按当前客户端默认等待时长等待，避免短轮询）。`scene_run()` 仅用于明确的单镜头试渲染或单镜头返修。

- 渲染工具用项目中的技能，HyperFrames 版本固定为 `{{HYPERFRAMES_VERSION}}`，缺失时从客户端工具准备页补齐。检查用 `hyperframes({"subcommand": "<子命令>"})`，镜头执行由片场调度。
- 如果项目提供 `frame.md`，只把它当作画布、帧率和安全区等技术信息的来源；不得把其中的配色、字体、版式、示例图或动效文字当作创作命令。
- 用户需要的图片放进使用它的镜头目录。共用字体提前放到项目的 `assets/fonts/`，固定版本的 JS/CSS 库放到 `assets/vendor/`，引擎在渲染前分别共享到镜头的 `assets/fonts/` 与 `vendor/`；不得逐镜头重复下载或复制。所有引用仍使用镜头内相对路径，不引用全局缓存或系统字体；共享文件只读，改动另存为镜头自己的文件。
- 在 `prompt.md` 中写入创意描述，使艺术方向和视觉概念贴合当前文案，但不能改动 `onset` 保证的执行契约。配色不在 `prompt.md` 里另定：写了 `look` 时，`onset` 把全片配色写进渲染提示词和 `onset-scene.js`。创意描述从 `treatment.md` 和本镜头在 `scene-plan` 中的视觉角色推出，写明画面要证明或解释的是哪句台词。
- 在 `prompt.md` 中写明镜头交接：入场状态（承接上一镜头的哪个持续物件、它在第 0 帧的位置、大小与状态）与出场状态（最后一帧留给下一镜头的物件、位置与状态）。各镜头分别渲染、互相看不到，交接只能靠这两段约定；相邻两个镜头的出场状态与入场状态必须逐项对得上。写了 `handoff` 的交界，`onset` 会把同一份约定写进两侧的渲染提示词，`prompt.md` 里的入场、出场状态要与 `bridge` 一致，可以补充细节，不得另起一套。第一个镜头没有入场状态，最后一个镜头的出场状态就是全片收束画面。
- 在 `prompt.md` 中提醒画面文字与字幕分工：标题与关键词只做命名、归纳和给结构，不复述正在读的台词。
- 要求输出 {{CANVAS}}、30fps、静音、无音轨的 MP4。
- 不要在 `prompt.md` 里手抄帧号：镜头的全局起止帧、本镜头的短语表与字幕（换算成镜头局部帧）、最小可读帧数由 `onset` 写进渲染提示词，并在渲染前写成镜头目录里的 `onset-scene.js`。`prompt.md` 只写结尾停留要求和哪些短语不得提前出现等创意层面的约束。
- 画面内烧录字幕、按安全区排版时，用新建项目时下发的 `scene-kit` 技能（`SceneKit.captions`、`SceneKit.safeRect`），不要每个镜头各写一套字幕代码。
- 派发前在镜头任务书中写明 `visible-events.json` 的交付要求。每镜用 `{"schema": 1, "fps": 30, "events": [...]}`，事件字段与全片清单相同；`event_id` 加镜头编号前缀，四个帧号以本镜头第 0 帧为原点。纯装饰文字标记为 `decorative`。

