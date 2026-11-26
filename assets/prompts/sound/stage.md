## {{STAGE:sound}}：选择 BGM 和 SFX

### 素材选择

- BGM 应与内容气质一致，优先选择克制、不会遮挡讲述的氛围音乐。
- SFX 只用于开场钩子、信息出现、确认反馈、关键转场和结论等明确节点。
- 不要为每个元素移动都添加音效。
- 音效挂在它回应的那个画面事件上，不挂在镜头切换上：不要因为又切了一次镜头就重复同一个音效，重复会把这个音效的含义用完。
- 音乐在人名、数字和关键论断处让位；刻意的安静同样是表达，不要用音乐把每一段空白都填满。
- 只使用授权明确且来源可追溯的素材。
- 下载前记录作品页、作者、素材 ID、授权页面和是否存在额外限制。
- 保存原始下载文件和解码后的工作文件，并计算 SHA-256。
- 缺基础质感或常用转场音效时，可用 `assets_generate_base()` 一键生成零版权基础质感（暖纸/颗粒/网格）与基础转场音效（`whoosh`/`impact`），也可用 `sfx_search({"query": "<关键词>"})`、`sfx_download({"sound_id": <ID>})` 检索并下载音效，参考返回的防削波安全增益 `safe_gain_db`；混音时 `audio_mix()` 会自动做单轨真峰值夹取与末端 `alimiter` 砖墙限幅。

在 `production/audio/asset-ledger.json` 中记录：

- 本地文件名和用途。
- 原始 URL、作者、素材 ID。
- 授权类型和授权证据路径。
- 下载时间和 SHA-256。
- 是否需要署名及建议署名文字。

### Cue Sheet

建立 `production/audio/cue-sheet.json`：

- 每个 cue 必须以整数帧定位，再换算为音频采样点。
- 记录素材、开始帧、持续时间、增益、淡入淡出和用途。
- 每条音效 cue 写明它回应的 `event_id`（取自 `visible-event-inventory.json`）或 `phrase_id`（取自 `phrase-timeline.json`），开始帧由该事件或短语的帧号推出，不另行手估；说不出回应哪个事件的音效删掉。
- 不允许 cue 越过节目终点。
- 同一时间的音效数量应受控，避免高频叠加和听觉拥挤。


清单使用 `{"schema":1,"cues":[...]}`。音乐行填 `kind: "music"`、项目内 `asset`、`start_frame`、`duration_frames`、`gain_db`、`fade_in_frames`、`fade_out_frames`。音效用 `kind: "sfx"`，起点从绑定的事件或短语读取。素材可用 `source_start_frame` 指定从哪一帧开始取用。无音乐与音效时提交空 `cues`。
