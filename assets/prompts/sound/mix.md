## {{STAGE:mix}}：配音优先的声音混合

用 `audio_mix()` 读取定稿配音、静音母版、时长报告和已确认的 cue sheet。片场自动生成 48kHz 双声道音乐、音效和混音 WAV，按人声闪避音乐（`amix` 的 `normalize=0`）、做单轨真峰值夹取、两遍响度规范化与末端 `alimiter` 砖墙限幅，再用 384k AAC 合成候选。它会校验编码后的真峰、解码采样数和总帧数，摘要写到 `production/audio/machine-qc.json`。

输出为 `production/audio/music.wav`、`sfx.wav`、`premaster.wav` 和 `candidate.mp4`。输入相同会复用通过校验的候选；修改素材或音量后用 `audio_mix({"replace":true})` 保留上一版并生成新候选。填写 `production/audio/sound-checklist.json`，记录听感、关键词是否被遮蔽和需要返修的 cue。
