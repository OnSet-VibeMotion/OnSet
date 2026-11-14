## {{STAGE:timeline}}：依据实际语音重建 SRT

### 强制对齐与时间轴校验

文稿是现成的，把它逐字对到配音上比语音识别更准，也不会把专有名词识别错。对齐工具由 `ALIGN_PROVIDER` 决定，用 `config_get({"key": "ALIGN_PROVIDER"})` 读取：缺省在 Apple Silicon 上是 `mlx`，其余平台是 `funasr`；以 `x:` 开头时是第三方插件提供的对齐工具，用法见本说明末尾「第三方站」那一节，结果照样交给 `align_build()`。

送进对齐的文本必须是 `align_text()` 生成的 `production/audio/align-text.txt`（声音事件发出的是笑声、叹气，不是字，所以对齐文本里没有它们）。对齐结果不手工映射回原文：由 `align_build()` 逐字匹配回终稿，生成 `voice.srt` 和短语时间轴（见下文）。先用 FFmpeg 把 `voice.wav` 转成 16kHz 单声道的 `production/audio/voice-16k.wav`。

**`mlx`（Qwen3-ForcedAligner）**

- 模型由客户端预先下好，本地目录用 `config_get({"key": "ALIGN_MODEL"})` 读取；它返回的不是本地目录（而是 `mlx-community/…` 仓库名）时说明还没下好，请用户在客户端的工具准备页（首页的「召集你的摄制组」，或顶栏的「还差几项工具」）里安装，不要让工具在对齐时现下载。
- 命令：`mlx_audio.stt.generate --model <ALIGN_MODEL 的本地目录> --audio production/audio/voice-16k.wav --text "$(cat production/audio/align-text.txt)" --language Chinese --output-path production/audio/align --format json`，结果写到 `production/audio/align.json`（`--output-path` 是不带扩展名的文件路径，不是目录）。
- `--language Chinese` 必须显式传，缺省是英文。
- 输出按单字给出开始、结束秒数，粒度约 0.08 秒；标点会被丢掉。`align_build()` 直接读这份 JSON。
- 单次最多 5 分钟音频。更长的配音在句间停顿处切段分别对齐，存成 `align-01.json`、`align-02.json`……，交给 `align_build()` 时写明各段起点（`"align": ["production/audio/align.json", "production/audio/align-02.json@312.48"]`）；切点从下面 `audio_check()` 报告的 `speech` 区间之间选，不要切在发声中间。

**`funasr`（时间戳预测）**

- 没有命令行入口：客户端把它装进专用的 Python 环境，用 `funasr-python` 运行下面的 Python（写成脚本文件后 `funasr-python 脚本.py`，不要用系统的 `python3`）：

  ```python
  from funasr import AutoModel
  model = AutoModel(model="iic/speech_timestamp_prediction-v1-16k-offline")
  result = model.generate(input=("production/audio/voice-16k.wav", open("production/audio/align-text.txt").read()), data_type=("sound", "text"))
  print(result)
  ```

- 先打印结果确认结构，把它原样存成 `production/audio/align.json`。`align_build()` 认得 funasr 的 `text` 加 `timestamp`（毫秒）结构。

服务自带字级时间戳时（ElevenLabs 的 `alignment`），可以把它转成标准结构 `[{"text": "字", "start": 秒, "end": 秒}, ...]` 存成 `align.json` 代替强制对齐；只有句级时间戳的路径（MiniMax `--subtitles`、百炼 ASR、`edge.srt`）仍要跑强制对齐，句级结果只作参考。

然后由终稿和对齐结果生成 `voice.srt` 与短语时间轴：

```bash
align_build({"fps": 30})
```

缺省读 `production/script-final.md` 与 `production/audio/align.json`，写出 `production/audio/voice.srt`、`production/phrase-timeline.json` 和 `production/audio/align-report.json`。它把终稿的每个朗读单元与对齐结果逐字匹配，标出漏读、多读与读错的位置：

- 受保护短语里有字在对齐结果中找不到（TTS 漏读或对齐丢了），或整体匹配率低于 85%，会进 `problems` 并以非 0 退出。先重新合成或检查送进对齐的文本，不要改时间码。
- 多出来的字、读错的字和置信度低于 0.9 的短语进 `hints`，逐条带终稿行号，试听确认。
- 确实是对齐器把某个短语的边界判错时，把修正写进 `production/phrase-adjust.json`：`{"schema": 1, "adjustments": [{"phrase_id": "...", "edge": "start", "frame": 63, "reason": "..."}]}`。每条必须写理由；修正只叠加在测量结果上，被修正的短语标为 `adjusted` 并记为已复核。不要直接改 `phrase-timeline.json` 的帧号，下次重跑会被覆盖。
- 重跑时保留 `phrase-timeline.json` 里已填的 `visible_event_ids` 和 `reviewed`。

**每次得到或改动 `voice.srt` 后，都要用配音本身做一次独立校验：**

```bash
audio_check({"audio": "production/audio/voice.wav", "srt": "production/audio/voice.srt", "report_json": "production/audio/voice-check.json"})
```

它不识别文字，只用能量包络判定每一刻有没有声音，所以与时间戳来自哪里无关。判断结果读 `voice-check.json`：

- `problems` 里是字幕早于或晚于发声、整段落在静音里、发声没有字幕覆盖等问题，必须修掉再继续。优先换用强制对齐或修正对齐输入，不得手工挪时间码凑数。
- `hints` 里的「整体偏移」说明时间戳来源有系统误差，要整体校正；「结尾停留」对 TTS 或对齐直接产出的 `voice.srt` 说明它偏晚。
- `transcription-production.srt` 生成后同样跑一次。终稿字幕按可读单元延长停留是允许的，所以它的「结尾停留」提示可以保留，但 `problems` 必须为空。

- 参考 SRT 只用于理解原始内容和大致节奏。没有已录配音时，不把参考时间码当作最终时间码。
- 以 `production/audio/voice.srt` 的真实时间戳生成 `transcription-production.srt`。`voice.srt` 由上面的 `align_build()` 生成，已是毫秒精度的句级时间戳，可直接作为基础，再按可读语义单元微调。
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

生成 `production/timing-report.json`，至少包含：

- 帧率、总帧数和总时长。
- 音频采样率和每声道目标采样数。
- 每条字幕的开始、结束和文本。
- 所有无文字停顿区间。
- 参考 SRT 与新 SRT 的总时长差异。

### {{STAGE:timeline}}补充：短语级语义时间轴

句级 SRT 只能用于字幕和粗排，不能直接证明一句话内部的视觉顺序。凡一条字幕包含两个以上会分别显示的概念、动作、条件、结论或专有名词，必须把这些单位在终稿里标成受保护短语（`@{短语编号}…@{/短语编号}`），由 `align_build()` 依据真实音频生成 `production/phrase-timeline.json`，不要手写帧号；再生成 `production/visible-event-inventory.json`：

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

