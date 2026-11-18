# 卡点模式

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

卡点是内置插件 `beat`（`packages/engine/src/plugins/beat`，见「内置插件」）；`packages/engine/src/beat` 是它用的无配音卡点时间契约，以项目根 `beat.yaml` 启用，与 `song.yaml`、`cast.yaml` 互斥。链路是「导入音乐 → 分析出草稿网格 → 试听确认 → 按小节的分镜计划 → `beat_cues` 写镜头时长」。

| 约定 | 原因 |
|---|---|
| 切点帧号只由 `frameOf`（秒 × fps 四舍五入）算出，总帧数只由 `totalFrames` 算出（都在 `frames/`，`beat` 包转出） | 两处取整方式不同，画面与音乐会慢慢错开，而且是那种看半天说不出哪里不对的错开 |
| 分镜计划 `plan.json` 只接受小节数，不接受秒数 | 能写秒数就能写出不在重拍上的切点；切点卡在重拍上要由结构保证，不靠事后对轴 |
| `beat_cues` 写 `duration_seconds`，`beat.verifyCue`（`beat/cue.ts`）对切点做**精确**比对 | 帧号只有一个来源，任何偏差都是有人手改了时长；成片里的 ±1 帧容差属于整片复查，不属于这里 |
| 草稿网格永远不直接生效，只有 `beat.confirm` 能把 `reviewed` 置为 true | 模型最常见的错是重拍整体错位或拍号判错，只有听过试听轨才知道 |
| 分析脚本把结果写进文件，不打印到 stdout | 首次运行下载模型权重，进度输出会污染标准输出，按 stdout 解析时结果直接丢失（实测过） |
| 节拍分析环境是卡点插件登记的前置资源（`ctx.prereq`，实现在 `beat/env.ts`）：`onset setup --only beat` 在 `~/.local/share/onset/beat/venv-<AnalyzerVersion>`（`ONSET_BEAT_ENV_DIR` 可覆盖，插件经 `ctx.childEnv` 登记，`childEnvironment` 显式传）里建 venv、`pip install beat-this==<版本>`、预下载默认 `final0` 权重，全部成功才写完成标记，失败整个删掉重来、重试 3 次。基础 Python 按 `basePythonCandidates` 找 3.10–3.14 的（`ONSET_BEAT_BASE_PYTHON` 可指定）；pip 用用户自己的 pip.conf，`--proxy` 只给权重下载。`beat.yaml` 的 `python` 可选，不写用共享环境，缺了抛 `prereq.MissingError`；卡点流程的制作提示词禁止编排工具自己建环境 | 以前 `beat.yaml` 默认 `python: python3`，系统 Python 里没有 beat-this，编排工具就在对话里自己建 venv、pip install，每个新项目都可能多一套约 800 MB 的 torch（实测两套并存，一套是客户端新建项目时现建的）。系统 `python3` 是 3.15 时 torch 装不上，所以按已知可用的版本挑 |
| 音乐由 ffmpeg 解码成单声道 WAV，脚本用标准库 `wave` 读，再调 `Audio2Beats` | 不走 beat-this 自带的 torchaudio 读文件：它的后端随版本变化，能不能读 MP3 取决于用户机器 |

节拍分析固定 `beat-this` `AnalyzerVersion`（`beat/store.ts`，代码与权重 MIT），不用 librosa（没有重拍）和 madmom（Python 3.12+ 兼容问题，DBN 后处理有专利、限非商用）。CI 不装 torch，真实分析的集成测试（`beat/analyze.test.ts`）只在设置 `ONSET_TEST_BEAT_PYTHON` 时运行，改动分析脚本后要在本机跑一遍：

```bash
ONSET_TEST_BEAT_PYTHON=/path/to/venv/bin/python npx vitest run --root packages/engine src/beat -t RealBeatThis
```

镜头的 `beat` 块与 `song` 块并列（卡点插件的 `block.ts`），它的 `verifyInputs` 在渲染前、复用已有产物前与 `run-all` 里都会执行；启用了卡点却没有 `beat` 块的镜头直接拒绝。`scene_run_all` 渲染前经插件的整批检查（`beatCoverage`）核对全部镜头与网格、分镜计划一致。
