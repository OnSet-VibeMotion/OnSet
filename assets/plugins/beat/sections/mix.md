## {{STAGE:beat-mix}}：音乐与音效的混合

从 `production/beat/track.json` 取已确认的音乐文件名，按 `production/beat/<文件名>` 传给 `audio_mix({"primary_music":"production/beat/<文件名>","expect_frames":<网格总帧数>})`。工具保留音乐原速和顺序，只在节目终点补不足一帧的静音。混音采用 `amix` 的 `normalize=0`，自动做两遍响度和编码后采样数、真峰校验。

输出保存在 `production/audio/`，含 `music.wav`、`sfx.wav`、`premaster.wav`、`candidate.mp4`、`machine-qc.json`。试听并填写 `sound-checklist.json`。输入相同直接复用，修改音效后用 `"replace":true` 归档前一版并生成新候选。
