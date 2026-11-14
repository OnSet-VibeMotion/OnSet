### 渲染器配置

- 开始前读取仓库根目录的 `onset.conf`，并考虑当前环境变量或 `.env` 的覆盖值，确定本次使用的 `RENDERER`。
- 把解析后的渲染器写入 `production/production-config.json` 和执行日志。每个镜头用 `scene_run({"scene": "<镜头目录>"})` 调用，渲染器由 `onset` 从配置解析；需要单独指定时写入该镜头 `scene.json` 的 `renderer` 字段，不能静默回退到其他渲染工具。
- 如果配置的渲染工具不可用，停止并明确报告缺失的 CLI；未经用户确认不得替换渲染器。

