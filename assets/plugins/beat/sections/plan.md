### 分镜计划与镜头

1. 网格确认后，把 story.md 的段落表改成小节范围，按小节写 `production/beat/plan.json`（每个镜头 {"id", "bars"}，小节合计必须等于网格的小节数），运行 `studio_show({"page": "beat"})` 让用户在节拍页看切点。
2. 建好镜头目录后运行 `beat_cues({"scenes": "scenes/"})` 写入镜头时长与拍点，再 `validate_beat()`。镜头时长只能由这条命令写，不得手改 duration_seconds。
3. 镜头说明里写清楚哪一拍发生什么、画面里的字与字幕逐字照 story.md。成片音轨就是导入的音乐，可另加音效，不加配音。
4. 核心表达需要特定动效手法时，在 `scene_prepare()` 清单或对应镜头 `scene.json` 的 `motion_effects` 字段显式选型（支持简写如 `"005"` 或完整 `"来源:id"`，单镜最多 3 条，守住「一拍一个焦点」；渲染时片场自动展开动效配方并联动配套插件技能）。高频精选速查：

{{MOTION_MENU}}

5. 每个镜头的 `prompt.md` 写好后，过{{STAGE:render}}的「分镜审核关卡」：`studio_show({"page": "storyboard", "note": "分镜写好了，请看一遍"})`，用户确认之前不渲染。

