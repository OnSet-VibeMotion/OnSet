### 渲染器配置

- 开始前读取仓库根目录的 `onset.conf`，并考虑当前环境变量或 `.env` 的覆盖值，确定本次使用的 `RENDERER`。
- 把解析后的渲染器写入 `production/production-config.json` 和执行日志。整批镜头按「工作边界」用 `scene_run_all({"scenes": "scenes/"})` 调度，省略 `jobs` 以读取配置的并发上限；只有明确的单镜头试渲染或返修才用 `scene_run({"scene": "<镜头目录>"})`。两种调用都由 `onset` 从配置解析渲染器；需要单独指定时写入该镜头 `scene.json` 的 `renderer` 字段，不能静默回退到其他渲染工具。
- 如果配置的渲染工具不可用，停止并明确报告缺失的 CLI；未经用户确认不得替换渲染器。

