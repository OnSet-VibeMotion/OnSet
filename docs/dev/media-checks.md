# 媒体校验与拼接

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

`packages/engine/src/mediaprobe` 是所有 ffprobe / ffmpeg 调用的唯一入口，别在其他包里直接拼这两个命令。

| 类型 | 作用 |
|---|---|
| `Spec` | 期望规格。**零值字段表示不检查**，只需填写要检查的字段。分辨率检查要求 `widthPx` 和 `heightPx` 同时为正数 |
| `checkSpec` | 返回**全部**不符项，不是第一条。每次只报一条会让调用方「修一条、重跑一次、再发现下一条」 |
| `Toolchain.verify` | 完整校验流程，返回 `Report`。抛错只表示「检查没跑成」，「跑了但不合格」是 `Report.ok === false` |
| `FrameStats` | 单帧灰度均值与标准差。`isBlank` 只看 `isFlat`，**不叠加 `isDark`** |

空白帧阈值（`flatStdDev = 2.0`）刻意取得极保守。不能凭「真实帧标准差通常很高」来定：深色背景上只有一行标题时亮部占比不到 1%，标准差会低到 20 出头，那是合法封面。误判它比漏判一个真空白帧更糟——前者会让人很快不再信任这个检查。`mediaprobe.test.ts` 的「frameStats does not flag sparse text on dark background」钉着这个上界。

`packages/engine/src/concat` **刻意不提供重定时能力**。PROMPT 第八阶段写着「禁止通过 `setpts` 或改变帧率让镜头追赶配音」——提示词里的禁令可以被忽略，不存在的能力不能。所以分辨率或帧率不符归入 `Plan.blocking` 要求重渲染，只有编码和像素格式差异走 `Plan.normalize`。**不要为了「方便」给它加缩放或变速参数。** 唯一会改画面的是抹平交界（`Runner.smoothSeams`，`concat` 的 `smooth_seams` 缺省打开）：约定了交接的交界拼接前先量前一镜末帧对后一镜首帧（`Toolchain.frameDifferenceBetween`，口径与 `review` 相同），到 `review.HandoffLooseDifference` 就在交界两边各 `SeamBlendSeconds` 里叠上对方那一帧再淡掉（交界处一半一半），只叠画面、不增删帧，总帧数与时长不变，抹平的片段按 target 重编码、顺带完成规范化。它是兜底：两侧渲染器只拿到文字约定，Qoder 这类较弱的模型常常交界那帧对上了、运动却断开（2026-11 实测）。更好的修法是拼接前的 `scene_seams`（见「镜头时长、局部数据与复用」的镜头交接）。

镜头产物校验（`scene.verifyOutput`，`scene/run.ts`）查画幅、帧率、时长、逐帧解码的总帧数、无音轨，不查编码和像素格式：PROMPT 第八阶段明确允许镜头产物规格不一致，由拼接前的规范化统一，在镜头层拦下会和那条既定流程打架。

校验失败抛 `VerificationError`（`scene/verification.ts`），命令行把它包成 `schedule.FatalError`（经 `schedule.fatal`）停止重试。规格不符是确定性的，重跑只会得到同样的产物，而每次重试都是一次完整的 AI CLI 调用。**新增确定性失败时记得走同一条路。**

`scene.verifyOutput` 还会跑 `packages/engine/src/determinism` 的源码扫描：从合成入口沿本地引用展开，只扫渲染真正加载的文件，命中同样抛 `VerificationError`。规则只收「上游禁令里有、HyperFrames lint 不查、几乎没有合法用途」的写法；`setTimeout` 刻意不收，等字体就绪的代码里太常见。新增规则前先拿内置技能与上游技能的示例跑一遍——`determinism/scan.test.ts` 的「embedded viewer template passes」钉着 algorithmic-art 的 viewer 模板，它的交互路径靠逐行 `onset-allow-nondeterministic` 豁免。误判一次，这道门就没人信了。

`@font-face` 只判两种确定的错误：`src` 指向镜头目录里不存在的文件，以及 `font-display` 显式写成 `swap` / `fallback` / `optional`。没写 `font-display` 不判（Chrome 的 `auto` 按 `block` 处理），`local()` 不判（常见写法是 `local()` 后接 `url()` 兜底）。

成片级检查有两条：`onset review` 比对音视频流时长、总帧数与镜头帧数之和、镜头交界帧并出联系表，并解码成片实测积分响度与真峰（只进 hints：平台响度规范各不相同，frame.md 的目标是缺省建议）；`onset audio check` 用能量包络独立校验字幕时间轴。两者把切黑转场、字幕延长停留这类「机器分不清有意还是事故」的情况放进 hints，不改变退出码。

桌面复查默认执行交付校验。总帧数优先从当前冻结的镜头计划计算，没有镜头时读取时长报告。交付校验与复查使用同一份影片副本，成功报告记录影片摘要、交付规格和所用镜头计划的摘要。桌面确认发布时会重新核对原影片、当前规格与镜头计划。旧报告仍可在复查页查看，确认发布前需要重新通过交付复查。

`onset validate reads`（`packages/engine/src/reads`）读 `visible-event-inventory.json` 检查每个可读元素的停留时长、短语绑定与顺序。阈值取 Netflix 简体中文字幕规范（每秒 9 字、每条至少 5/6 秒），那是固定位置字幕的下限；画面元素还要先被找到，所以只能放宽不能收紧——收紧会把合法的快节奏镜头判死。字数按阅读单位算（一个英文词算一个），同理是为了不高估。两个 JSON 的字段名写死在制作提示词第四阶段，改字段要同步改那里。

`mediaprobe` / `concat` 的集成测试需要真实 ffmpeg，缺失时自行跳过。CI 装了 ffmpeg——不装的话测试仍然「通过」，真正跑外部命令的代码再没被验证过。CI 装的是客户端安装页同一份钉死的静态构建（`.github/scripts/install-ffmpeg.mjs` 从 `toolinstall` 的 `ffmpegAssets` 读地址与 sha256、核对后放进 PATH），不用 `brew install ffmpeg`：后者每台机器 30 多秒，e2e 分在三台上就是三遍。
