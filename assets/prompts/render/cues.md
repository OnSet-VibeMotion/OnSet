全部镜头目录与 `scene.json` 建好后，由分镜计划推出每个镜头的时长：

```bash
scene_cues({"scenes": "scenes/", "plan": "production/scene-plan.json", "srt": "transcription-production.srt", "phrases": "production/phrase-timeline.json", "total_frames": "<总帧数>"})
```

它把全片切成首尾相接的整数帧区间，写入每个镜头的 `duration_seconds`（帧数 ÷ 帧率，6 位小数）与 `timing` 块，并把短语时间轴复制进镜头目录；合计不等于总帧数、锚点不递增或有镜头不足一帧时整体失败、不写任何文件。之后不得手改 `duration_seconds`：改分镜就改 `scene-plan.json` 再重跑本命令。渲染前用同样的参数加 `"check": true` 复核一次，有人手改过时长会被逐条列出。

