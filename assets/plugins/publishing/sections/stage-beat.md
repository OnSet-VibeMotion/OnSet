## {{STAGE:publish}}：刷新发布配置

### 平台封面

交付前按发布平台另做封面图。这些是上传时单独提交的封面，不能拿成片截帧代替：截帧的构图是按 {{CANVAS}} 排的，换成另一个比例必然裁掉标题或主体。

| 平台 | `platform` | 要出的封面 | 推荐尺寸（宽 × 高） | 构图要点 |
|---|---|---|---|---|
| 抖音 | `douyin` | 横 4:3 + 竖 3:4，两张都要 | 宽 1440、高 1080；宽 1080、高 1440 | 竖封面用于个人主页与双列信息流 |
| 小红书 | `xiaohongshu` | 竖 3:4（也接受 1:1、4:3） | 宽 1080、高 1440 | 其他比例会被裁成 3:4 或 4:3 |
| 微信视频号 | `channels` | 竖 3:4（横版视频可加 16:9） | 宽 1080、高 1440 | 主体与标题集中在中间 |
| B 站 | `bilibili` | 横 16:10 | 宽 1920、高 1200 | 各展示位会再裁成 16:9 或 4:3：标题与主体放进居中的宽 1600、高 1080 安全区 |
| 知乎 | `zhihu` | 横 16:10 | 宽 1920、高 1200 | 同 B 站 |

同一张 3:4 竖封面可以同时登记给抖音、小红书与视频号；B 站与知乎的 16:10 必须单独构图，不能拿 4:3 拉伸。

1. 封面沿用本片已经形成的视觉语汇与画面主体；配色、字体和构图由封面根据主题自由决定，定格在全片最有戏剧性、最能说明主题的一刻。标题用已确认的封面标题，必要时加一到两个短钩子（数字、反差），不新增片中没有的事实。
2. 文件命名为 `covers/<平台>-<宽>x<高>.png`，例如 `covers/douyin-1440x1080.png`、`covers/bilibili-1920x1200.png`。源文件放在 `covers/src/<同名>/index.html`，各自是一个 `data-duration` 为 1 秒的 HyperFrames 合成。字体与脚本复制进各自目录、用目录内路径引用，不得用 `../` 引用目录外的文件，否则字体与脚本不会被加载。
3. 每种比例分别构图，不要把一张缩放成另一张：横版通常文字在左、主体在右，竖版通常标题在上、主体在中、钩子在下。标题与主体都不得出画，文字不得压在主体上。
4. 每张先跑 `hyperframes({"subcommand": "check", "args": ["covers/src/<目录>"]})` 直到通过，再用 `hyperframes({"subcommand": "snapshot", "args": ["covers/src/<目录>", "--at", "0.5"]})` 出图，复制为上面的文件名，打开看一遍。
5. 在 `publish.md` 的 `cover.images` 里逐张登记 `{platform, ratio, path, width_px, height_px}`，`cover.source_type` 写 `designed_image`；「封面文字」章节写出封面标题并列出每张图的路径。`validate_publish()` 会按上表核对平台是否接受该比例、实测尺寸与比例、短边不小于 1080，并在 `ready` 时检查发布平台要的封面是否齐全。封面预览（`manual_checks.cover_preview`）仍需人工在平台上确认。

### 发布配置

最终交付后刷新根目录 `publish.md`：

- 用 FFprobe、完整解码和 SHA-256 实测 `final.mp4`，填入实际规格和最终哈希；新视频与新哈希验证完成后才把 `video.replacement_in_progress` 恢复为 `false`。
- 从真实项目文件填入发布平台、主标题、介绍、话题、已确认封面文字、素材署名和 evidence。署名必须由素材账本和授权证据支持，不得凭印象补写。
- 主标题按发布平台的字数上限写：抖音不超过 30 个字，小红书不超过 20 个字（汉字、字母、标点都按一个字算）。同一条视频发多个平台时，在 `copy.platform_titles` 里按「平台: 标题」逐个写；`validate_publish()` 会逐条核对字数，超长时报出实际字数。
- 话题写在 `copy.hashtags`，所有平台通用。某个平台要用自己的话题（例如小红书正在办的活动话题）时，可以另写 `copy.platform_hashtags`，按「平台: [话题…]」写这个平台完整的话题列表，通常是通用话题加上它自己的；没写的平台照用 `copy.hashtags`。只在用户提到或确有平台专属话题时才写，不要为每个平台都抄一份。
- 读取 `production/approval.json` 的 `expected_delivery.sha256`，并在存在时校验 `delivery_verification.actual_sha256`。它们必须与 `publish.md` 和实际成片哈希一致。
- 可复用工具不得硬编码某个 revision 名称、旧总帧数、旧总采样数或旧候选哈希。当前合同值必须从活动的 `production/beat/grid.json`、`production/beat/plan.json` 和 `approval.json` 推导；只有不可变备份的哈希可以显式冻结。
- 将耳机、手机外放、封面预览、版权确认四项人工检查写入 `manual_checks`；机器检查不能代替人工检查。
- 按合同计算且只使用 `draft`、`pending_manual_checks`、`blocked`、`ready`。没有成片或非人工字段/证据缺失时用 `draft`；替换、解码、哈希、规格、审批、失败检查或署名证据异常时用 `blocked`；只有非人工信息完整且仍有适用检查待执行时才用 `pending_manual_checks`。
- YAML 必须使用支持安全模式的 YAML 库序列化。先在与目标文件同一文件系统写临时文件，执行 `validate_publish({"file": "<临时文件>", "project_root": "."})`，验证通过后才原子重命名为 `publish.md`。
- 不得用无效临时文档覆盖最后一个有效 `publish.md`。如果无法构造合同有效的状态文档，保留旧文件并在最终汇报中明确刷新失败，绝不声称 `ready`。

