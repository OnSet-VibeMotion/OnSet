---
schema_version: 1
canvas:
  width_px: 1920
  height_px: 1080
  fps: 30
  orientation: landscape
safe_area:
  structural: {left_px: 48, right_px: 48, top_px: 40, bottom_px: 40}
  main_content: {left_px: 120, right_px: 120, top_px: 80, bottom_px: 96}
  critical_text: {left_px: 160, right_px: 160, top_px: 96, bottom_px: 200}
  cover_title: {left_px: 160, right_px: 160, top_px: 220, bottom_px: 340}
  subtitles: {left_px: 240, right_px: 240, top_px: 840, bottom_px: 90}
subtitles:
  required: false
  font_size_px: {min: 32, max: 38}
  max_width_px: 1440
  max_lines: 2
  max_fullwidth_chars_per_line: 16
  line_height: {min: 1.30, max: 1.40}
  break_rules:
    - keep_proper_nouns_intact
    - keep_english_phrases_intact
    - keep_numbers_and_units_intact
    - preserve_real_speech_gaps
audio:
  sample_rate_hz: 48000
  channels: 2
  voice_integrated_lufs: {min: -18, max: -16}
  bgm_integrated_lufs: {min: -30, max: -26}
  bgm_ducking_db: {min: 6, max: 10}
  ducking_attack_seconds: {min: 0.04, max: 0.12}
  ducking_release_seconds: {min: 0.25, max: 0.60}
  bgm_fade_seconds: {min: 0.80, max: 1.50}
  sfx_gain_db: {min: -18, max: -12}
  sfx_max_simultaneous: 2
  final_integrated_lufs: -16
  final_lufs_tolerance: 1
  true_peak_max_dbtp: -1
  lra_lu: {min: 2, max: 6}
---

# 画幅：横屏 1920×1080

本文件由 onset 按新建项目时选的画幅写出，只记录技术信息：画布与帧率（`canvas`）、安全区（`safe_area`）、烧录字幕的版式约束（`subtitles`：字号范围、最大宽度、行数、每行字数、行高与断句规则，`scene-kit` 的 `SceneKit.captions` 读它；字幕的配色由镜头自己定）与混音响度目标（`audio`）。镜头的配色、字体、版式、材质与动效由各镜头自行决定，不从这里取。

镜头产物的画幅、帧率由 `canvas` 决定，`scene_run()` 渲染后按它校验；`canvas` 与 `safe_area` 的数字不要改。

## 安全区

- `structural`：结构元素（边框、背景装饰）不越出这一圈。
- `main_content`：主体内容的排版区。
- `critical_text`：标题、数字、结论等关键文字只放在这里，主动避让播放器底部控制栏与进度条。底部 200px 是播放器控制栏、进度条与弹幕输入区。
- `cover_title`：第 0 帧封面标题的位置。
- `subtitles`：烧录字幕的字幕带。

## 横屏构图要点

本项目是 16:9 横屏（1920×1080），画面的主方向是左右而不是上下。竖屏习惯的版式落到横屏时按下面的原则改排：

- 左右分栏优先于上下堆叠：命题型用「左文右图」或「左大字、右主视觉」；对照型直接左右对开；流程型沿水平方向展开，最多 5 步，超过就分两行；系统总览用横向网格。
- 不要把竖屏版式原样居中：中间一条窄栏、两侧大面积空白，是横屏最常见的「没排完」。
- 一行文字不超过 22 个汉字：横屏宽度大，单行过长会让视线来回扫，宁可断行。
- 标题字号以画面高度 1080px 为基准，与竖屏的同级字号保持一致，不因为画面变宽而放大。
- 底部控制栏与进度条是关键避让区：标题、数字、结论和字幕都不得进入 critical_text 下沿以下的区域；字幕带贴在进度条上方。
