### 分镜审核关卡

分镜计划、`scene-plan.md`、每个镜头的 `scene.json` 与 `prompt.md` 都写好、`scene_cues()` 跑通之后，任何渲染之前（包括代表性镜头的试渲染），运行 `studio_show({"page": "storyboard", "note": "分镜写好了，请看一遍"})`，并停下来等用户确认或修改。客户端的分镜页按镜头列出章节、口播、时长、视觉角色、一句话说明、交接手法和完整的 `prompt.md`。汇报：

- 镜头数与总时长。
- 每章讲什么、靠什么接到下一章。
- 需要用户拍板的地方：没把握的画面方案、要用的素材、和稿子理解可能不一致的镜头。

用户提出修改时改 `treatment.md`、`scene-plan.json` 或对应镜头的 `prompt.md`，锚点变了就重跑 `scene_cues()`，再请用户看一遍。用户没有点头之前不渲染。确认之后单独重做某个镜头时不必再过这道关。

若项目在 `project.json`、`production/production-config.json` 或 `onset.flow.json` 中开启了可选的单镜真视频打样闸门（`pilot_gate: true`），分镜审核确认后进入 `gate-pilot`（单镜打样审核）：先只渲染第 1 镜（或 `pilot_scene` 指定的代表镜）真视频 MP4 供用户审看，待用户通过 `studio_confirm({"gate": "gate-pilot", "said": "<用户原话>"})` 确认方向正确后再全量调度 `scene_run_all`。未开启 `pilot_gate` 的项目在分镜确认后直接进入全量渲染。

