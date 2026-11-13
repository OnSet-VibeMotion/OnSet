## {{STAGE:mix}}：配音优先的声音混合

- 统一使用 48kHz 双声道工作格式。
- 总音频每声道采样数必须由最终节目时长精确推导。
- 人声保持原速；画面需要更长展示时用停顿和音乐延展，不拉慢人声。
- BGM 从开场自然淡入，在结尾自然淡出；不要硬切。
- 使用侧链或等效自动压低，让有人声时的 BGM 明显低于无人声区间。
- SFX 的存在感服从信息层级，不能覆盖关键词、数字、模型名或结论。
- 用 FFmpeg `amix` 混多路时显式写 `normalize=0`。默认会按输入路数压低每一路，混出来整体偏小，后面的响度规范化只能硬拉；各路电平应由前面的增益与闪避决定。
- 控制峰值并执行两遍响度规范化。若无平台专用规范，使用项目的音频目标配置，不从视觉风格文件读取。
- 成片 AAC 码率不低于 `384k`。低码率会在编解码时把采样之间的峰值抬高，瞬态密集的音乐能抬 3 dB 以上：`premaster.wav` 达标不代表成片达标，真峰要量编码后的候选成片。
- AAC 编码后必须按解码得到的真实采样数检查节目终点，不能只相信容器显示的舍入时长。

至少生成：

- `production/audio/voice.wav`
- `production/audio/music.wav`
- `production/audio/sfx.wav`
- `production/audio/premaster.wav`
- `production/audio/candidate.mp4`
- `production/audio/machine-qc.json`
- `production/audio/sound-checklist.json`

