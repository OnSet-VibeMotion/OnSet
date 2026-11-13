### 分镜审核关卡

分镜计划 `production/beat/plan.json`、每个镜头的 `scene.json` 与 `prompt.md` 都写好、`beat_cues()` 与 `validate_beat()` 跑通之后，任何渲染之前（包括代表性镜头的试渲染），运行 `studio_show({"page": "storyboard", "note": "分镜写好了，请看一遍"})`，并停下来等用户确认或修改。客户端的分镜页按镜头列出时长和完整的 `prompt.md`，节拍页（`studio_show({"page": "beat"})`）显示每个镜头占的小节与切点。汇报：

- 镜头数与总时长。
- 每章讲什么、靠什么接到下一章。
- 需要用户拍板的地方：没把握的画面方案、要用的素材、和故事理解可能不一致的镜头。

用户提出修改时改 `treatment.md`、`plan.json` 或对应镜头的 `prompt.md`，小节分配变了就重跑 `beat_cues()`，再请用户看一遍。用户没有点头之前不渲染。确认之后单独重做某个镜头时不必再过这道关。

