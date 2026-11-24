## {{STAGE:timeline}}：依据实际语音重建 SRT

### 强制对齐与时间轴校验

配音与终稿确认后调用 `align_run({"publish": true})`。片场按 `ALIGN_PROVIDER` 使用已准备的 MLX 或 FunASR，完成音频转换、逐字对齐、短语时间轴和独立音频校验，无需编写脚本或打印字级 JSON。缺少模型或工具时请在工具准备页补齐。

首次生成会写入规范路径。已有规范产物或已确认分镜时用 `align_run()` 生成候选；核对候选和受影响的下游文件再替换。输入未变时会复用校验通过的候选。失败先读诊断并修复原因，再用 `retry: true`。

已有可信字级时间戳时，直接用 `align_run({"evidence":"<字级时间戳 JSON>","publish":true})`，例如 `voice_synthesize()` 返回的 ElevenLabs `alignment` 路径。第三方对齐器按「第三方站」一节调用，输入用 `align_text()` 导出的对齐文本，输出也可作 `evidence`。只有句级时间戳时仍需强制对齐。

长配音（>180 秒）且由 `voice_synthesize()` 生成（带 `*.tts/report.json`）时，`align_run()` 会自动按段落静音边界切段、逐段对齐并合并整片时间轴，不要手写 Python 切分或合并脚本。非内置配音的超长录音若需分段对齐，可用 `align_build()` 的 `align: ["production/audio/align-01.json", "production/audio/align-02.json@312.48"]`，偏移取实际音频，切点选发声之间的停顿。

缺省读 `production/script-final.md` 与 `production/audio/align.json`，写出 `production/audio/voice.srt`、`production/phrase-timeline.json` 和 `production/audio/align-report.json`。它把终稿的每个朗读单元与对齐结果逐字匹配，标出漏读、多读与读错的位置：

- 受保护短语里有字在对齐结果中找不到（TTS 漏读或对齐丢了），或整体匹配率低于 85%，会进 `problems` 并以非 0 退出。先重新合成或检查送进对齐的文本，不要改时间码。
- 多出来的字、读错的字和置信度低于 0.9 的短语进 `hints`，逐条带终稿行号，试听确认。
- 确实是对齐器把某个短语的边界判错时，把修正写进 `production/phrase-adjust.json`：`{"schema": 1, "adjustments": [{"phrase_id": "...", "edge": "start", "frame": 63, "reason": "..."}]}`。每条必须写理由；修正只叠加在测量结果上，被修正的短语标为 `adjusted` 并记为已复核。不要直接改 `phrase-timeline.json` 的帧号，下次重跑会被覆盖。
- 重跑时保留 `phrase-timeline.json` 里已填的 `visible_event_ids` 和 `reviewed`。

**绕过 `align_run()` 生成字幕，或之后改动 `voice.srt` 时，用配音做一次独立校验：**

```bash
audio_check({"audio": "production/audio/voice.wav", "srt": "production/audio/voice.srt", "report_json": "production/audio/voice-check.json"})
```

它不识别文字，只用能量包络判定每一刻有没有声音，所以与时间戳来自哪里无关。判断结果读 `voice-check.json`：

- `problems` 里是字幕早于或晚于发声、整段落在静音里、发声没有字幕覆盖等问题，必须修掉再继续。优先换用强制对齐或修正对齐输入，不得手工挪时间码凑数。
- `hints` 里的「整体偏移」说明时间戳来源有系统误差，要整体校正；「结尾停留」对 TTS 或对齐直接产出的 `voice.srt` 说明它偏晚。
- `transcription-production.srt` 生成后同样跑一次。终稿字幕按可读单元延长停留是允许的，所以它的「结尾停留」提示可以保留，但 `problems` 必须为空。

- 参考 SRT 只用于理解原始内容和大致节奏。没有已录配音时，不把参考时间码当作最终时间码。
- 以 `production/audio/voice.srt` 的真实时间戳生成 `transcription-production.srt`。`voice.srt` 由对齐生成，已是毫秒精度的句级时间戳，可作为基础，再按可读语义单元微调。
- 字幕按可读语义单元切分，不能直接照搬 TTS 请求分段。
  - 复合词、人名、机构名、修饰语与中心词、数量与单位、英文短语不拆到两条字幕或两行里。
  - 不要连续出现很碎的两三字字幕条。
  - 先按语义定分组和断行，再单独决定哪些词做强调；不为了突出某个词去改断行。
  - 整句说完后仍留在画面上的标题属于画面排版，不属于字幕，不写进 SRT。
- 时间使用毫秒精度，不得四舍五入或截断为整数秒。
- 字幕之间的无文字间隔必须保留，用作呼吸、元素展示、镜头收尾或转场。
- 根据画面信息密度延长节奏：元素越多，进入、停留、退出所需时间越长。不要让字幕刚读完就立即切镜头。
- 最终节目时长必须对齐整数帧。30fps 下，先确定总帧数，再由 `总帧数 ÷ 30` 得到视频时长。
- 配音不足整帧节目终点时，用静音补齐；不得拉伸人声来填充展示时间。
- 节目终点必须由“最后一个有效语音词的结束帧 + 已批准的结尾停留帧数”推导，不能继承旧模板、旧 BGM 淡出点或旧候选时长。
- 在配置中记录 `closingHoldFrames` 和允许的最大尾留白。候选交付前实测最后一个有效语音词到节目终点的帧差；异常长的结尾留白必须先确认，不能默认保留。

定稿字幕通过检查后，用 `timing_report({"closing_hold_frames": 15, "max_closing_hold_frames": 30})` 生成 `production/timing-report.json`。把示例帧数替换成已批准的值；有参考字幕时传 `reference_srt`。后续分镜与混音直接使用报告的总帧数和每声道采样数。

### {{STAGE:timeline}}补充：短语级语义时间轴

句级 SRT 只能用于字幕和粗排，不能直接证明一句话内部的视觉顺序。凡一条字幕包含两个以上会分别显示的概念、动作、条件、结论或专有名词，或包含不能在字幕切条/换行时劈开的专有名词与核心词组，必须把这些单位在终稿里标成受保护短语（`@{短语编号}…@{/短语编号}`，单条控制在 2–12 字）：`align_build()` 会避开短语内部切分 `voice.srt`，`SceneKit.captions()` 会把短语锁成单行不可拆原子块，并依据真实音频生成 `production/phrase-timeline.json`（不要手写帧号）；再生成 `production/visible-event-inventory.json`：

- `production/phrase-timeline.json`（`align_build()` 产出）
- `production/visible-event-inventory.json`

两个文件的字段名固定，`validate_reads()` 按这些名字读取；帧号一律是全片全局帧。

`phrase-timeline.json`：顶层 `{"schema": 1, "fps": 30, "phrases": [...]}`，每个受保护短语记录：

- `phrase_id`、`subtitle_index`（字幕编号）、`source_text`（原文）、`semantic_order`（语义顺序）。
- `start_ms`、`end_ms`，以及 `start_frame`、`end_frame_exclusive`。
- `alignment_source`（对齐来源）、`confidence`（置信度）、`reviewed`（人工复核状态）。
- `visible_event_ids`（对应的可见事件 ID）。

`visible-event-inventory.json`：顶层 `{"schema": 1, "fps": 30, "events": [...]}`，每个可见事件记录：

- `event_id`、`scene_id`（所属镜头）、`selector`（DOM selector 或稳定元素 ID）、`text`（显示文本）、`role`（语义角色；纯装饰元素写 `decorative`）。
- `phrase_id`（绑定的短语）。
- `enter_frame`、`readable_start_frame`、`readable_end_frame_exclusive`、`exit_end_frame`（退出完成帧）。

必须验证：

- 非装饰性的可读元素不得早于绑定短语开始帧出现。
- 视觉事件顺序必须与真实口播短语顺序一致。
- 一个元素不得包含尚未说出的未来信息。
- “条件—结论”“主语—谓语”“看谁—传什么—最终结论”等不可颠倒结构必须分别绑定。
- 复合标题如果包含多个先后出现的受保护短语，必须拆成独立可控元素，或推迟到整句说完后作为总结出现。
- 每个受保护短语至少生成“开始前一帧、开始帧、稳定可读帧”三联证据。
- 每个非装饰元素的可读区间必须够观众读完：不短于 5/6 秒，也不短于「字数 ÷ 每秒 9 字」（一个汉字、一个英文词或一个数各算一个字）。这是字幕的下限，画面元素还要先被找到，信息越密集留得越长。一次只给观众一个信息点：前一个还没读完，不要让下一个开始。

