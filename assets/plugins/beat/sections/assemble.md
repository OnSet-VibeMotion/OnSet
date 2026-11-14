## {{STAGE:assemble}}：规范化和拼接静音母版

拼接之前先修镜头交界：`scene_seams({"scenes": "scenes/"})`。约定了交接、却没接顺的交界，它会让后一个镜头按前一个镜头真实的最后画面重做开头约半秒，再按帧核对接上了没有；没修成的会恢复原样并在输出里说明。修完再拼接；拼接时仍没接上的交界会被自动抹平成一次很短的溶解，输出里会列出来，那几道交界在{{STAGE:review}}要重点看。

用 `concat({"scenes": "scenes/", "out": "production/silent-master.mp4"})` 完成规范化和拼接；母版就叫 `production/silent-master.mp4`，不要另起名字，客户端按这个位置找。先加 `"dry_run": true` 跑一次，看有哪些镜头规格不一致，再正式执行。

这条命令按镜头目录名字典序拼接，规格一致时全程 `-c copy` 不重新编码；只有编码或像素格式与目标不同的片段会先生成规范化副本，渲染工具的原始 MP4 保留在原处。拼完会自证时长等于各片段之和、无音轨、画幅与帧率符合目标。

规范化只用于编码、像素格式和封装统一，不承担语义重定时。分辨率或帧率不符时命令会直接失败并要求回镜头工程重渲染——缩放会损失画质，改帧率会动到时间轴。禁止用 `setpts`、整体变速或抽帧复制帧让镜头追赶音乐；命令本身不提供这些能力，也不要绕过它自己拼 FFmpeg 去做。

只有一个镜头时同样用这条命令。母版生成后跑：

```bash
validate_video({"video": "production/silent-master.mp4", "silent": true, "decode": true, "expect_frames": "<各镜头帧数之和，即网格的总帧数>", "report_json": "production/silent-master-check.json"})
```

`expect_frames` 会完整解码精确统计帧数，容器声明的 `nb_frames` 可能缺失或不准，不能用来断言时间轴。`decode` 发现截断和损坏：`moov` 在文件头时，截断一半的文件照样能读出正确规格。判断结果读 `report_json` 落盘的文件，不要解析终端输出。

