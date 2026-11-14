---
schema_version: 1
canvas:
  width_px: 1080
  height_px: 1440
  fps: 30
  orientation: vertical
safe_area:
  structural: {left_px: 40, right_px: 40, top_px: 96, bottom_px: 60}
  main_content: {left_px: 88, right_px: 88, top_px: 120, bottom_px: 100}
  critical_text: {left_px: 88, right_px: 180, top_px: 120, bottom_px: 260}
  cover_title: {left_px: 88, right_px: 180, top_px: 260, bottom_px: 460}
  subtitles: {left_px: 88, right_px: 180, top_px: 990, bottom_px: 260}
subtitles:
  required: false
  font_size_px: {min: 32, max: 38}
  max_width_px: 812
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

# 画幅：竖屏 1080×1440

本文件由 onset 按新建项目时选的画幅写出，只记录技术信息：画布与帧率（`canvas`）、安全区（`safe_area`）、烧录字幕的版式约束（`subtitles`：字号范围、最大宽度、行数、每行字数、行高与断句规则，`scene-kit` 的 `SceneKit.captions` 读它；字幕的配色由镜头自己定）与混音响度目标（`audio`）。镜头的配色、字体、版式、材质与动效由各镜头自行决定，不从这里取。

镜头产物的画幅、帧率由 `canvas` 决定，`scene_run()` 渲染后按它校验；`canvas` 与 `safe_area` 的数字不要改。

## 安全区

- `structural`：结构元素（边框、背景装饰）不越出这一圈。
- `main_content`：主体内容的排版区。
- `critical_text`：标题、数字、结论等关键文字只放在这里，主动避让抖音右侧互动栏和底部 UI。右侧 180px 和底部 260px 是抖音互动栏与底部 UI。
- `cover_title`：第 0 帧封面标题的位置。
- `subtitles`：烧录字幕的字幕带。
