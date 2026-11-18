## {{STAGE:beat-sound}}：音乐授权和音效

### 素材选择

- 成片音乐就是{{STAGE:beat}}导入、确认过网格的那一首，不另选 BGM。
- SFX 只用于开场钩子、信息出现、确认反馈、关键转场和结论等明确节点。
- 不要为每个元素移动都添加音效。
- 音效挂在它回应的那个画面事件上，不挂在镜头切换上：不要因为又切了一次镜头就重复同一个音效，重复会把这个音效的含义用完。
- 只使用授权明确且来源可追溯的素材，导入的音乐也一样。
- 下载前记录作品页、作者、素材 ID、授权页面和是否存在额外限制。
- 保存原始下载文件和解码后的工作文件，并计算 SHA-256。

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
- 每条音效 cue 写明它回应的 `event_id`（取自 `visible-event-inventory.json`），开始帧由该事件的帧号推出，不另行手估；说不出回应哪个事件的音效删掉。
- 不允许 cue 越过节目终点。
- 同一时间的音效数量应受控，避免高频叠加和听觉拥挤。


`cue-sheet.json` 使用 `{"schema":1,"cues":[...]}`。每行 `kind` 写 `"sfx"`，填项目内 `asset`、`event_id`、`duration_frames`、`gain_db`、`fade_in_frames` 和 `fade_out_frames`。可用 `source_start_frame` 指定素材裁切起点。主音乐单独交给混音工具，无音效时用空 `cues`。
