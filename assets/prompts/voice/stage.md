## {{STAGE:voice}}：TTS 和断句校对

TTS 工具由 `onset.conf`（或环境变量 `TTS_PROVIDER`）决定，用 `config_get({"key": "TTS_PROVIDER"})` 读取解析结果。可选：

| 取值 | 服务 | 自带时间戳 | 适合 |
|---|---|---|---|
| `minimax` | MiniMax（`mmx`） | 句级 | 非 Apple Silicon 上的默认；中文自然度与发音控制最完整 |
| `bailian` | 阿里云百炼（`bl`） | 无，需识别 | 已有百炼额度 |
| `edge` | 微软 Edge 在线语音（`edge-tts`） | 句级，偏粗 | 免鉴权的预览与草稿 |
| `elevenlabs` | ElevenLabs（官方 CLI） | 字级 | 中英混排、需要字级时间戳 |
| `tencent` | 腾讯云语音合成（`tccli`） | 有 | 已有腾讯云账号 |
| `mlx` | 本机 MLX（`mlx-audio`，仅 Apple Silicon） | 无 | 离线、不产生费用 |
| `breeze` | 本机 Breeze TTS 2（`mlx-audio`，仅 Apple Silicon） | 无 | Apple Silicon 上的默认；离线；从音色库克隆同一个声音，按段落指导语气，可以笑、叹气 |
| `x:<插件>` | 用户加的第三方插件提供的配音 | 见插件说明 | 本说明末尾「第三方站」那一节写了用它的哪个工具 |

各路径的凭据、命令和时间戳获取方式不同，但断句检查、审核关卡和产物要求完全一致。

配音与对齐工具都是前置资源，由客户端按项目配置装好（固定版本，装在用户级目录，不需要 Node、Python 或 Homebrew）。不要自己用 npm、pip、pipx、uv、brew 安装或升级它们；调用时报找不到命令，请用户在客户端的工具准备页（首页的「召集你的摄制组」，或顶栏的「还差几项工具」）里安装，装好后再继续。

无论哪条路径，{{STAGE:voice}}结束时都必须得到 `production/audio/voice.wav` 与毫秒精度的 `production/audio/voice.srt`；自带时间戳为「无」的路径，`voice.srt` 由{{STAGE:timeline}}开头的强制对齐生成。

### 凭据与配置

**MiniMax（`TTS_PROVIDER=minimax`）**

- 配音通过 `mmx` CLI（MiniMax Token Plan）生成，不再直接调用原始 HTTP API。
- 先确认已登录：`mmx auth status`；未登录时用 `mmx auth login --api-key sk-xxxxx` 完成鉴权。
- 凭据保存在用户目录 `~/.mmx/config.json`，不进入项目目录，也不写入脚本、Markdown、JSON、命令行参数或日志。
- 密钥（sk-xxxxx）只存在于登录命令与 `~/.mmx/config.json`，不得写入项目 `.env`、脚本、Markdown、JSON、命令行参数或日志；日志只能记录是否已登录、额度等状态，不得打印密钥值或包含密钥的 URL。
- 若登录后调用报 401，用 `mmx config set --key region --value cn`（国内版）或 `global`（海外版）手动指定服务区域，再用 `mmx auth status` 确认。
- 用 `mmx quota` 查看 Token Plan 剩余额度。

**百炼（`TTS_PROVIDER=bailian`）**

- 配音通过 `bl` CLI（阿里云百炼）生成，使用 CosyVoice 模型。
- 先确认已登录：`bl auth status --output json`；未登录时用 `bl auth login --console`（浏览器授权）或 `bl auth login --api-key <key>` 完成鉴权。
- 凭据保存在用户目录 `~/.bailian/config.json`，不进入项目目录，也不写入脚本、Markdown、JSON、命令行参数或日志。
- 密钥只存在于登录命令与 `~/.bailian/config.json`，不得写入项目 `.env`、脚本、Markdown、JSON、命令行参数或日志；日志只能记录是否已登录、额度等状态，不得打印密钥值或包含密钥的 URL。
- 用 `bl usage free` 或 `bl usage stats` 查看剩余额度。

**Edge 在线语音（`TTS_PROVIDER=edge`）**

- 免鉴权。
- 它调用的是微软 Edge 浏览器的朗读接口，不是有服务承诺的商用 API，随时可能失效或限流。只用于预览和草稿；正式交付前确认用户接受这一点，否则换其他路径。

**ElevenLabs（`TTS_PROVIDER=elevenlabs`）**

- 先用 `elevenlabs auth login` 登录，凭据存进系统钥匙串，不进入项目目录。不得在项目 `.env` 写 `ELEVENLABS_API_KEY`：这个 CLI 会自动加载当前目录的 `.env`，`onset` 也会拒绝在 `.env` 里出现密钥的项目。
- 密钥不得写入脚本、Markdown、JSON、命令行参数或日志。

**腾讯云（`TTS_PROVIDER=tencent`）**

- 用 `tccli configure` 交互配置凭据，凭据保存在用户目录，不进入项目目录；不得把 SecretId / SecretKey 写进项目文件、命令行参数或日志。

**本机 MLX（`TTS_PROVIDER=mlx`）**

- 仅限 Apple Silicon。免鉴权；首次运行会下载模型到用户缓存目录。

**Breeze TTS 2（`TTS_PROVIDER=breeze`）**

- 仅限 Apple Silicon。免鉴权，不联网。
- 模型由客户端预先下好（约 4.6 GB），本地目录用 `config_get({"key": "TTS_MODEL"})` 读取；它返回的不是本地目录（而是 `mlx-community/…` 仓库名）时说明还没下好，请用户在客户端的工具准备页（首页的「召集你的摄制组」，或顶栏的「还差几项工具」）里安装，不要让工具在合成时现下载。
- 声音来自音色库：用户确认过的声音存成「参考音频 + 逐字一致的文字稿」，放在用户级目录、所有项目共用，配音时从它克隆。只靠一句描述设计的声音每次生成都会变，同一个账号的片子之间、甚至同一部片子的几段之间听起来像换了人；克隆出来的始终是同一个声音。开工先运行 `voice_list()` 看库里有什么。

### 试听和正式生成

- 音色尚未确定时，先列出可用音色，选择中文（普通话）真诚成年男声对应的 voice ID，记录到 `production/production-config.json` 的 `ttsVoiceId`。
  - MiniMax：`mmx speech voices`
  - 百炼：`bl speech synthesize --list-voices --model cosyvoice-v3-flash`
  - Edge：`edge-tts --list-voices | grep zh-CN`
  - ElevenLabs：`elevenlabs voices search --format json`
  - 腾讯云：CLI 没有列表命令，按官方「音色列表」文档选择 `VoiceType`
  - MLX：Qwen3-TTS 预置中文音色 `Vivian`、`Serena`、`Uncle_Fu`、`Dylan`（北京话）、`Eric`（四川话）
  - Breeze：先看音色库。有默认音色时直接用它，不再试听选音色：`voice_get()` 返回参考音频路径与文字稿，音色名记进 `production/production-config.json` 的 `ttsVoice`；用户想换别的就用 `voice_get({"name": "<音色名>"})`，库里的音色也可以在客户端的「音色」页试听（`studio_show({"page": "voice"})`）。库是空的、或用户想要一个新声音时，用一句中文描述设计音色（`--instruct`），试听时换描述而不是换 voice ID，文件名用 `try-<序号>.wav`，试听文案存进 `production/audio/try-text.txt`；用户选定后，把选中的那段试听连同这份文案存进音色库：`voice_save({"name": "<给它起的名字>", "audio": "production/audio/try-<序号>.wav", "text_file": "production/audio/try-text.txt", "source": "designed", "instruction": "<当时的描述>"})`，问用户要不要设成以后的默认音色（要就加 `"make_default": true`），之后的正式配音也从它克隆。用户想用自己的声音、或想自己挑一个新声音时，请用户打开「音色」页（`studio_show({"page": "voice"})`）：那里能直接对着麦克风录、按描述生成几段试听挑一个、或上传录音，存好后再用 `voice_get` 取；用户把录音发到对话里的，用 `voice_save` 存（`"source": "recorded"`）
- 用同一段 10–20 秒代表性文案生成 2–3 个试听版本（`--out production/audio/try-<voiceId>.wav`），文件名包含 voice ID。
- 音色、语速确认后再生成正式配音。
- 优先按完整语义段落调用 TTS，避免按字幕行逐条生成造成语调碎裂。
- 正式生成前，先扫描终稿全文，把容易误读的英文单词、英文缩写、产品名、模型名、专有名词、数字和多音字逐一列出并确定预期读音，再写入对应 TTS 的发音控制；同一词出现多次也要统一。不要靠生成后试听再补。
- 四位数年份一律逐位读：`1972 年` 读「一九七二年」，`2025 年` 读「二零二五年」，`2026 年 2 月` 读「二零二六年二月」，`1970 年代` 读「一九七零年代」；不得读成「一千九百七十二年」「两千零二十五年」。扫描时把全文每一个四位年份都列入发音控制，不要交给 TTS 自行判断：同一音色对不同年份、不同上下文的处理并不一致。其余数量数字（`16 个`、`815 字`、`64KB`）仍按数值读。
- 多音字按上下文定读音，不要交给 TTS 自行判断：同一个字在不同词里读法不同，例如「过分」读 guò fèn、「十分」读 shí fēn，「重要」读 zhòng、「重新」读 chóng，「行业」读 háng、「行动」读 xíng。扫描时逐句看多音字，把每一处的词和预期拼音（带声调）列进生成报告；同一个词全篇读法一致。钉住读音的写法分两类：
  - 能写拼音的路径（MiniMax 的 `--pronunciation`、百炼 SSML 的 `alphabet="py"`）直接写拼音，见下面各自的参数。`--pronunciation` 会替换全文所有匹配处，匹配串写整个词（`过分`），不要只写一个字（`分`），否则别处的「分钟」也被改读。
  - 其余路径（Edge、MLX、Breeze、腾讯云、ElevenLabs）在终稿里写 `<显示|朗读>` 标记，朗读侧换成读音相同、但只有这一个读音的字，例如 `<过分|过份>`、`<重新|虫新>`。替换字要和原字同声母、同韵母、同声调；整词找不到合适的写法时，换掉整个词（朗读侧写成同音的另一个词）。字幕照样显示原文，对齐用的是朗读侧，所以不影响时间轴。
- 用 `align_text()` 从终稿生成 `production/audio/tts-text.txt` 与 `production/audio/align-text.txt`：标记已换成朗读写法，`#` 标题行已去掉。送进 TTS 的是 `tts-text.txt`，{{STAGE:timeline}}强制对齐用 `align-text.txt`（去掉了声音事件，没有事件时两份相同）；各路径的发音控制（`--pronunciation`、SSML）只处理文本改写也读不准的词。语法写错时它会报出行号和列号。
- 保留原始请求命令（去掉密钥）、CLI 返回的元数据（时长、采样率、大小）、原始音频和时间戳文件，写入生成报告。
- 不得手工伪造服务返回的时间戳。

**MiniMax 固定参数**

- 模型使用 `--model speech-2.8-hd`，音量默认 `--volume 1`、音高默认 `--pitch 0`。语速不得被模板永久硬编码为已确认值：可从 `0.98` 开始试听，但必须让用户根据代表性密集段落和完整试听确认，最终值写入项目配置。情绪由音色本身表达（`mmx` 不提供 `emotion` 参数），选择偏平静、真诚的音色，不通过变调模拟。
- 需要双声道 PCM 时，加 `--format wav --channels 2` 输出，便于后续统一混音。MiniMax WAV 采样率仅支持 `8000/16000/22050/24000/32000/44100`，不支持 48000；需要 48kHz 时用 `--sample-rate 44100`，或改用 MP3 输出。
- 用 `--subtitles` 同时取得真实句级时间戳，例如：
  `mmx speech synthesize --text "..." --voice <voiceId> --speed <confirmedSpeed> --subtitles --out production/audio/voice.wav`
  该命令会额外产出 `production/audio/voice.srt`（毫秒精度），作为{{STAGE:timeline}}重建字幕的真实依据。
- 用 `--pronunciation 原文/替换内容` 钉住上面的易误读词（可重复传入多条）。替换内容按词的语言和意图选择记音法：
  - 英文词用括号包裹的 IPA 音标，例如 `--pronunciation "MiniMax/ˈmɪniˌmæks"`、`--pronunciation "AI/ˌeɪˈaɪ"`。
  - 中文多音字用括号包裹的拼音带声调，例如 `--pronunciation "处理/(chu3)(li3)"`。
  - 缩写按字母念或作文本展开时用纯文本，例如 `--pronunciation "API/诶屁爱"`、`--pronunciation "omg/oh my god"`；仍要按中文读音读的品牌/产品名直接写汉字，例如 `--pronunciation "MiniMax/米尼麦克斯"`。
  - 四位年份连同「年」字一起替换成逐位汉字，例如 `--pronunciation "2025年/二零二五年"`、`--pronunciation "1972年/一九七二年"`；带上「年」是为了不误伤同样四位、但表示数量的数字。原文里数字与「年」之间有空格时，匹配串照原文写。

**百炼固定参数**

- 模型 `--model cosyvoice-v3-flash`（CLI 默认值）、语速 `--rate 0.98`、音量 `--volume 50`、音高 `--pitch 1.0`。情绪通过 `--instruction "平静、真诚的语气"` 控制，选择偏平静、真诚的音色，不通过变调模拟。
- 需要 48kHz WAV 时，加 `--sample-rate 48000 --format wav` 输出，便于后续统一混音。
- 百炼 TTS 不直接产出时间戳，需要两步取得真实句级时间戳：
  1. 合成音频：`bl speech synthesize --text "..." --voice <voiceId> --rate 0.98 --format wav --sample-rate 48000 --out production/audio/voice.wav`
  2. 识别时间戳：`bl speech recognize --url production/audio/voice.wav --language zh --out production/audio/voice-asr.json`
  从 ASR 结果中提取句级开始/结束时间，转换为 `production/audio/voice.srt`（毫秒精度），作为{{STAGE:timeline}}重建字幕的真实依据。
- 用 SSML `<phoneme>` 钉住上面的易误读词（需加 `--enable-ssml`）。`alphabet` 必须匹配词的语言：中文词用 `py`（拼音），英文词必须用 `ipa`（国际音标）——用拼音去近似英文只会得到中式英文。
  - 英文词用 `alphabet="ipa"`，例如 `<phoneme alphabet="ipa" ph="ˈmɪniˌmæks">MiniMax</phoneme>`、`<phoneme alphabet="ipa" ph="ˌeɪˈaɪ">AI</phoneme>`。
  - 中文多音字用 `alphabet="py"`，例如 `<phoneme alphabet="py" ph="he2">和</phoneme>`。
- 四位年份：在送进 TTS 的文本里直接写成逐位汉字（`2025 年` 写「二零二五年」），不依赖 SSML 数字读法。字幕仍显示原文的阿拉伯数字：年份在终稿里写成 `<2025年|二零二五年>`，换回原写法由{{STAGE:timeline}}的 `align_build()` 完成。

**Edge 固定参数**

- 命令：`edge-tts -v <voiceId> --rate=<±N%> -f production/audio/tts-text.txt --write-media production/audio/voice.mp3 --write-subtitles production/audio/edge.srt`。语速写成百分比，负数必须用等号连写（`--rate=-2%`），否则被当成另一个参数。
- 只输出 24kHz 单声道 MP3，用 FFmpeg 转成 `voice.wav`（48kHz 双声道）供后续混音。
- 不支持自定义 SSML，发音控制只能改写送进 TTS 的文本：年份写成逐位汉字，易误读的英文写成能读对的形式，多音字换成只有一个读音的同音字，一律写成终稿里的 `<显示|朗读>` 标记；字幕显示终稿原文由 `align_build()` 保证。
- `edge.srt` 是句级时间戳，实测起点比发声早约 0.1–0.2 秒，结尾还把句间停顿算进去。它只能做参考，`voice.srt` 必须由{{STAGE:timeline}}的强制对齐生成。

**ElevenLabs 固定参数**

- 用带时间戳的合成命令：`elevenlabs text-to-speech convert_with_timestamps --voice-id <voiceId> --model-id eleven_multilingual_v2 --text "..." --voice-settings.speed <confirmedSpeed> --output-format mp3_44100_128 --format json > production/audio/tts-001.json`。
- 返回 JSON 里同时有 base64 编码的音频和字级对齐（`alignment` 下的 `characters`、`character_start_times_seconds`、`character_end_times_seconds`）。先打印 JSON 的字段名确认结构再解析：解码音频后转成 `voice.wav`，把字级时间转成{{STAGE:timeline}}的标准对齐结构存成 `production/audio/align.json`，`voice.srt` 由 `align_build()` 生成。
- 数字读法用 `--apply-text-normalization on` 交给服务处理，但四位年份仍在文本里预先写成逐位汉字。

**腾讯云固定参数**

- 单次请求最多 150 个汉字（全角标点也算一个字），必须按句切段，每段一次请求：`tccli tts TextToVoice --region ap-guangzhou --Text "..." --SessionId <uuid> --VoiceType <voiceId> --Codec wav --SampleRate 16000 --Speed <confirmedSpeed> --EnableSubtitle True > production/audio/tts-NNN.json`。`--Speed` 取值 -2 到 6，0 是正常语速。
- 每段输出里的 `Audio` 是 base64 音频，`Subtitles` 是该段内的时间戳（毫秒）。各段音频按顺序拼接；字幕时间要加上该段在整条配音中的起点，起点用 `ffprobe` 实测前面各段的时长累加，不得按字数估算。拼接后的整条时间戳只能作为参考，`voice.srt` 仍以{{STAGE:timeline}}强制对齐为准。

**MLX 固定参数**

- 命令：`mlx_audio.tts.generate --model mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit --text "..." --voice <voiceId> --lang_code Chinese --output_path production/audio --file_prefix voice --join_audio --audio_format wav`。`--lang_code Chinese` 必须显式传，缺省按英文合成；不加 `--join_audio` 时会按文本分段输出多个文件。输出是 24kHz 单声道，用 FFmpeg 转成 48kHz 双声道再混音。
- 不产出时间戳，`voice.srt` 由{{STAGE:timeline}}强制对齐生成。
- 发音控制同 Edge，只能改写送进 TTS 的文本。

**Breeze 固定参数**

Breeze 有四种用法，同一部片子里可以组合：

| 用法 | 参数 | 用在哪 |
|---|---|---|
| 克隆 | `--ref_audio` + `--ref_text` | 正式配音的默认做法：音色库里的声音，原样的语气 |
| 语气指导 | 克隆的参数 + `--instruct "<语气>"` + `--cfg_scale 4` | 同一个声音，按段落指挥语气、情绪、语速：讲到转折处沉下来、讲到好消息时轻快 |
| 音色设计 | `--instruct "<音色描述>"` + `--cfg_scale 4`，不给参考音频 | 只用来试听、挑新声音，挑中后存进音色库 |
| 声音事件 | 终稿里的 `<\|[笑]>`、`<\|[叹气]>` 等 | 在某个位置笑一声、叹口气；与上面三种都能叠加 |

- 克隆：`mlx_audio.tts.generate --model <TTS_MODEL 的本地目录> --text "$(cat production/audio/tts-text.txt)" --voice S0 --ref_audio <voice_get 返回的参考音频> --ref_text "<voice_get 返回的文字稿>" --output_path production/audio --file_prefix voice --join_audio --audio_format wav`。`--ref_text` 原样照抄，一个字都不改。
- 语气指导：先读终稿，按情绪把段落分组（大多数段落不需要指导，用纯克隆），在 `production/audio/directions.md` 里列出每组的段落范围与一句中文语气说明，例如「语速放慢，语气沉重、克制」「语气亲切温和，像在和朋友聊天」。每组单独合成一次（克隆参数不变，加 `--instruct` 与 `--cfg_scale 4`，`--file_prefix voice-<组号>`），再按顺序用 FFmpeg 拼成 `voice.wav`，组与组之间按原文的段落停顿留出间隔。语气说明只写语气、情绪、语速，不写音色（音色由参考音频决定，写了反而会拉偏）；也不要写到极端，「兴奋、激动」这类说明会把音高抬得很高（实测抬高七成），先试听再用。正式生成前把有指导的几组各挑一段试听，和纯克隆放在一起让用户比较，用户认可再整篇生成。
- 声音事件写在终稿里（见{{STAGE:script}}的标记），`align_text()` 已经把它们放进 `tts-text.txt`、从 `align-text.txt` 里去掉，合成时什么都不用另加。
- 中英混排直接写，不用 `--lang_code`（Breeze 不看它）；产品名、缩写照样按「发音控制」处理。语气说明与音色描述用中文写，和正文的语言一致。
- 设计新声音的试听：`mlx_audio.tts.generate --model <TTS_MODEL 的本地目录> --text "$(cat production/audio/try-text.txt)" --voice S0 --instruct "<音色描述>" --cfg_scale 4 --output_path production/audio --file_prefix try-<序号> --join_audio --audio_format wav`。音色描述写中文，说清性别、年龄段、音色与语气，例如「一位三十多岁的男性，声音沉稳清晰，语气平静、真诚，语速适中」。试听文案控制在 5 到 25 秒（存进音色库的参考音频要 3 到 30 秒）。只靠描述的声音每次生成都会变，所以它只用来挑声音，不用来做正式配音。
- 输出是 24kHz 单声道，用 FFmpeg 转成 48kHz 双声道再混音。
- 不产出时间戳，`voice.srt` 由{{STAGE:timeline}}强制对齐生成。
- 发音控制同 Edge，只能改写送进 TTS 的文本。

### 断句检查

重点检查：

- 产品名、模型名或短语是否被错误拆开。
- "主语—谓语""动词—宾语""条件—结论"是否被不自然地切断。
- 数字、英文缩写、专有名词和多音字是否读对（多音字对照生成报告里列的拼音逐个听）；英文词应为标准英文发音，不能是拼音近似的中式英文。
- 每个四位年份是否逐位读出（「二零二五年」），没有读成「两千零二十五年」。
- 长句是否有足够呼吸。
- 句尾是否留出画面展示时间。

发现断句或发音问题时，先修改稿件标点、分段或发音控制，再重新生成受影响段落；不要只靠后期剪切掩盖。发音控制必须覆盖生成前扫描列出的全部易误读词，同一词出现多次也要统一。

### 配音审核关卡

正式时间轴冻结前，至少交付：

- 完整配音试听文件。
- 本次音色和参数。
- 断句与发音检查结果。
- 需要人工确认的疑点。

试听必须同时覆盖开场、信息最密集段落、英文或数字最多的段落和结尾。仅听一小段不能证明整篇口播速度合适。语速确认必须早于正式时间轴和镜头渲染。

正式配音一旦变更，旧的 SRT、词级对齐、总帧数、分镜、镜头时长、cue sheet、混音和候选视频全部标记为失效并重新生成；不得把旧画面整体拉伸去追新配音。

