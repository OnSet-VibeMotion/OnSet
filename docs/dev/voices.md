# 音色库

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

`packages/engine/src/voice` 是用户级的音色库（`<数据目录>/onset/voices`，`ONSET_VOICES_DIR` 覆盖），所有项目共用：每个音色是 `reference.wav`（经 mediaprobe 转成 24kHz 单声道，3–30 秒）加逐字一致的文字稿，`library.json` 记默认音色。Breeze 配音时从它克隆（`--ref_audio` / `--ref_text`），项目里只记音色名（`production-config.json` 的 `ttsVoice`、角色包的 `voice.breeze.voiceId`）。

| 约定 | 原因 |
|---|---|
| 正式配音一律克隆，描述（`--instruct`）只用来设计新声音的试听 | 2026-11 实测（Resemblyzer 余弦）：同一句描述三次生成只有 0.69 / 0.69 / 0.82，听起来像换了人；从参考音频克隆新文案 0.93 / 0.89 |
| 编排工具有 `voice_synthesize` / `voice_catalog` / `voice_design` 与 `voice_list` / `voice_get` / `voice_save` / `voice_default`（`packages/cli/src/voice_cmd.ts`），删除只在客户端的音色页（`DELETE /api/voices/{名字}`）；`voice_save` 同名不覆盖，要 `overwrite` | 音色是用户长期积累的声音，一句话删掉或顶掉就找不回来。`voice_cmd.test.ts` 的「no way to delete a voice」钉着 |
| 音色页（`Voices.tsx`，后端 `studio/voices.ts`）在进程里直接读写音色库，不占项目写锁、不进轮次快照；上传录音先走 `/api/uploads` 再转存 | 与安装页、记忆面板相同：写的是用户级目录，不是项目文件 |
| `ONSET_VOICES_DIR` 经 `childEnvironment` 显式传下去，并进 `orchestratorAccess` 的 `writableDirs`；测试的 testutil / testsupport / e2e fixtures 都指到临时目录 | 理由同记忆库：子进程会算出另一个目录，codex 沙箱写不进去；测试不能动开发者真实积累的声音 |
| 语气指导（克隆参数加 `--instruct` 与 `--cfg_scale 4`）按段落分组合成再拼接，语气说明写进 `production/audio/directions.md`；说明只写语气、情绪、语速，不写音色 | 实测同一参考音频下「沉重」「兴奋」「亲切」三种说明，相似度仍有 0.90 / 0.90 / 0.94，时长与音高明显变化；「兴奋」把音高从 132 Hz 抬到 223 Hz，所以提示词要求先试听 |
| 声音事件只能写成 `<\|[笑]>` 这类只读标记（`align.VocalEvents`，`Piece.event`）：进 `tts-text.txt`，不进 `align-text.txt`、不是朗读单元、不显示；正文里直接写 `[笑]` 解析时报错。第四阶段对齐一律用 `align-text.txt` | 实测把事件留在对齐文本里，对齐器会把「叹」「笑」塞进几十毫秒、产生零长度的字；去掉后每个字一样准。`align.test.ts` 的「vocal events」用那次真实对齐结果（`testdata/breeze-events-align.json`）钉着 |
| 音色页能直接做新声音，不经项目对话、不管项目配音选的是谁：「录我的声音」用麦克风念 `voice.SampleText`（`POST /api/voice-record`，逐字稿就是那段字，念错了让用户改）；「按描述设计」用本机 Breeze 念试听（`voice.design`，`POST /api/voice-design`，试听放在库目录的 `.drafts/`、一天后清掉，挑中的经 `/api/voice-drafts/{id}/save` 存进库）；「上传录音」照旧 | 以前做新声音只能在项目里把配音设成 Breeze 再走对话，用户在 Studio 里找不到入口 |
| 「按描述设计」要的 Breeze 在安装页单独一项 `voice:breeze`（项目配音本来就是 Breeze 时用 `tts:breeze`，`/api/voices` 的 `design.install_id` 告诉页面是哪一项），音色页里能直接点安装 | 安装页的配音项按项目配置挑，项目不用 Breeze 时根本不列它 |
| 音色页每个声音画波形、放的时候文字稿逐字点亮（`apps/desktop/src/renderer/voiceTiming.ts`、`components/VoiceWave.tsx`）：字的时间在界面里按能量包络估——找出停顿，用动态规划让标点落在停顿上，小句里按字数平分；整页共用一个隐藏的 `<audio>`，点波形或点字从那里放。高亮不加过渡 | 音色库只有参考音频与逐字稿、没有字级时间戳，为十几秒的试听跑强制对齐要装几个 GB 的模型；跟读差一两个字看不出来，配音的时间轴仍由第四阶段对齐给。过渡在后台窗口（e2e）里会停住，高亮与波形对不上 |
| 打包的 .app 要 `NSMicrophoneUsageDescription`（`apps/desktop/package.json` 的 `mac.extendInfo`）；e2e 启动时加 `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` | 没有这条说明 macOS 直接拒绝麦克风；测试不能碰真麦克风、也不能弹系统授权 |
| Breeze 的非商用许可与「只克隆本人或已授权的声音」只写在 README 里；界面、提示词、配置注释与工具说明都不另行提示，也不让编排工具找用户确认 | 软件开源，怎么用是用户自己的事；反复提示只是打断（用户要求） |
| mlx-audio 0.6.1 的命令行没有 `--seed`：同一段重生成结果会变，不能靠种子复现 | 上游 PyTorch 版与 API 有 seed，换到它们时再接 |
