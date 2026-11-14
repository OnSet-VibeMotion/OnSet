阶段性汇报和日志规则必须保留：

- 只向外放行以 `[[USER_MESSAGE]]` 开头的消息。
- 保留 `render-<scene>.stream.jsonl`。
- 保留 `render-<scene>.stderr.log`。
- 保留 `render-<scene>.user.log`。
- 阶段消息至少覆盖需求与素材检查、联网搜索、代码完成开始渲染、MP4 渲染完成。

用 `scene_run_all({"scenes": "scenes/", "srt": "transcription.srt", "strict_coverage": true, "report_json": "production/run-report.json"})` 一次性调度。已有合格产物且输入没变的镜头会被跳过：`onset` 在产物通过校验时把输入指纹（渲染提示词、`scene.json`、`prompt.md`、字幕、角色包、渲染工具、技能内容与 `onset` 版本）记在镜头目录的 `.onset-render.json`。输入变了的镜头会被跳过并在报告里写明是哪几项变了，确认要重渲染时用 `scene_run({"scene": "<镜头目录>"})` 或加 `"force": true`。渲染器非零退出自动重试（退避 10 秒与 30 秒）并把失败证据保留在 `attempts/attempt-NN/`；产物校验失败不重试。每次尝试的耗时、结果与用量写在镜头目录的 `render-<镜头编号>.attempt.json`，重跑前上一次的产物与日志会先归档进 `attempts/`。

`srt` 加 `"strict_coverage": true` 在开始渲染前核对镜头编号唯一性与「镜头总时长等于字幕跨度」。务必带上：这条规则本来就写在{{STAGE:plan}}，但漏掉一镜等到拼接时才发现的话，每一镜都已经烧掉一次完整的渲染调用。

产物校验查画幅、帧率、时长、逐帧解码的总帧数和「必须无音轨」，画幅取自 `frame.md`。不符时回镜头工程重渲染，不要在后面的阶段缩放补救。

产物校验还会静态扫描镜头合成源码：读时钟、`Math.random()`、`requestAnimationFrame`、`setInterval`、无限 `repeat`、渲染时联网、在线字体与未固定版本的 CDN 库都会让同一帧在两次渲染间不同；`@font-face` 指向镜头目录里不存在的字体文件、或 `font-display` 写成 `swap` / `fallback` / `optional`，会让字体静默回退或部分帧抓到回退字体。这些命中即判失败且不重试。你可以用 `scene_lint({"scene": "<镜头目录>"})` 收集问题，将错误原文和修复目标写入 `prompt.md`，再派发 `scene_run` 由渲染器修改代码并重渲染。

`report_json` 落盘的报告是判断结果的依据，不要去解析终端上的中文汇总。每个镜头一条记录，字段为 `scene_id`、`status`（`succeeded` / `skipped` / `stale` / `failed`）、`attempts`、`seconds`、`reason`；顶层还有 `counts`、`exit_code` 和 `interrupted`。被中断时报告照常落盘，据 `interrupted` 与各镜头 `status` 判断哪些还需要重跑。

渲染前语义关卡：

- 镜头源码中的可读文字顺序必须与 `phrase-timeline.json` 一致，不能让旧 GSAP 时间点、旧模板阶段或创意标题反过来决定词序。
- 关键文字使用由绝对短语帧换算得到的源级时间；阶段时间适配器只可用于装饰和非语义动画。
- 禁止用 FFmpeg `setpts`、整体变速、抽帧或复制帧修复文字—配音同步。需要调整语义时间时，把正确的时间关系与失败证据写进 `prompt.md`，由渲染器修正实现，只派发受影响镜头。
- 修订已有镜头时，先建立可复现的失败证据，再把证据、修改目标与保留要求写进 `prompt.md`，交给渲染器做最小范围的实现修改；不得一边改布局、一边改配音、一边改全片节奏。

如果一段时间没有新的 `[[USER_MESSAGE]]`，不要立即判定失败。先检查：

- 流日志和错误日志是否仍在写入。
- 项目文件、渲染目录和 MP4 是否有更新时间。
- 是否存在 HyperFrames、FFmpeg、Chromium 或 Node 渲染进程。
- 脚本最终退出码。

只有在脚本退出失败，或长时间无日志、无文件更新且无渲染进程时，才记录该镜头失败。重试必须使用新的 attempt 目录或保留旧日志，不能覆盖失败证据。

