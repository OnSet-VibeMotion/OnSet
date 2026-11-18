# 试镜与模型互学

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

`packages/engine/src/audition` 实现「同一镜头、多个渲染器」的对比，以及在它上面的模型互学：同一份冻结输入交给几位选手（渲染工具 + 模型，`renderer[:model]`，只按第一个冒号切；两段式写「实现者<设计者」）各渲染一遍，由人盲评，再决定采用哪一份；评判跨项目累积成「谁在哪类镜头上赢了谁」，人确认学习关系后，学生向老师学、带上老师的范例，经人评考试确认。**任何模型都可以当老师或学生，谁是老师只由人的评判定，代码里不写死任何一家。** 操作在 `packages/cli/src/audition_cmd.ts`（`scene_audition` / `scene_audition_retry` / `scene_audition_vote` / `scene_audition_adopt` / `scene_design` / `audition_learn`），接口在 `studio/auditions.ts` 与 `studio/learning.ts`，界面是「试镜」页（`Audition.tsx`，镜头页「⋯」菜单进入）与「进化」页的「谁向谁学」（`Learning.tsx`）。

| 约定 | 原因 |
|---|---|
| 一场试镜在 `production/studio/auditions/<编号>/`，每位选手一个子目录（随机标号 A、B……，人评考试的老师是 R），里面是 `freezeInput` 冻结的镜头输入；镜头列表（`discoverScenes`）、`sceneIDs` 跳过整个 `production/studio`，记忆导入跳过 `auditions` | 选手目录里有 scene.json，不跳过就会被当成项目的镜头；放在 Studio 状态目录里，渲染器写的合成代码不进每轮快照 |
| 选手的工具与模型经 `{...cfg, renderer, rendererModel}` 盖掉项目配置，`scene.json` 不动 | `rendererModelFor` 只在工具相同时用 `rendererModel`，这样每位选手拿到的就是它自己的模型 |
| 盲评由后端守：评判之前 `blindJSON` 只给标号、进度、成没成与产物路径；人评考试的老师（参照）公开，两份学生作品不说哪份带了经验 | 界面拿不到就漏不出去；用量、耗时也看得出是谁 |
| 试镜选择页由 `AuditionCompare` 默认同时展示全部已有画面，共用时间轴，可慢放、单份放大和铺满窗口；新选手出片自动加入，保留比较时间。按实际比例完整显示，画面区不叠卡片边框。过程和重试位于下方，展开日志不能挤动画面；仍只使用后端提供的盲评身份 | 多人比较不能限制为两份；画面、日志混排会缩小视频。老师参照不能作为考试胜者 |
| 试镜实时过程由 `GET /api/auditions/{编号}/activity` 提供（`studio/audition_activity.ts`），复用镜头流日志的增量解析，每位选手按自己的目录读取，设计阶段读 `design-*`，实现阶段读 `render-*`。盲评时只返回固定动作标签与步骤状态，不返回模型、路径、日志原文、思考字数、时间与用量；评判后才给步骤正文。页面每两秒整场刷新，区分工具执行、等待模型、排队、完成与中断 | 只显示「正在拍」看不出卡在哪里；直接暴露日志会提前泄露模型身份与人评考试的对照分组。并行调用未结束时，后来的思考或已完成调用不能盖掉它 |
| 试镜相关操作的 scopes 只有 cli；`audition_learn` 在 `director.KeyOps` 里 | 试镜是好几次完整渲染，谁来比、选谁、向谁学由人定，编排工具不能自己发起、不能替人投票。`audition_learn` 会起整理者，编排是制作人时要经 stdin 交 key |
| 单人重试经 `POST /api/auditions/{编号}/retry` → `scene_audition_retry`，沿用原标号、选手配置与冻结目录；只允许未评判且尚无合格产物的选手。初次与重试共用整场租约和 live 标记，客户端另占项目写锁，其他选手运行时不能重试；重启后无活进程的 running / pending 显示中断并允许重试 | 每场共写 audition.json，并行重试会覆盖别人的结果；不能改写已经用于评判、范例和考试结论的作品。死亡进程的租约可恢复，已有合格作品不重跑 |
| 试镜的 `Scene.audition` 是运行期边界，不写 scene.json、不改输入指纹；macOS 即使开了不安全模式，也套试镜目录沙箱，只能读自己的冻结目录、解析到的技能、共享资源、明确提供的范例与 onset 运行配置，不能读其他选手或项目原镜头，软链接按真实路径拦。重试不续接旧模型会话，以免继续使用先前看到的其他选手内容；Windows 沿用既有全放开约定，仅提示词限制，不能宣称系统隔离 | 多目录副本本身不是隔离。曾有选手一直读取另一位的代码和截图，既没完成自己的画面，也污染了对照 |
| 渲染失败保留流里的终止错误（含 result.errors），不能只看退出码：工具可能报 is_error 却退出 0。服务错误发生在出片后，必须过完整资源、规格、帧数、确定性与接缝检查，才接受视频；真实退出码与服务错误保留在 attempt.warning。重试时输入指纹一致的已有视频先本机验收，保留旧日志与用量。取消不作成功处理 | 额度不足、登录失效、空响应不是画面质量不合格；已完成的视频不能因为最后一次模型请求失败就丢掉。盲评接口把原因投影为固定中文文案，不泄露模型与日志原文；历史笼统错误从流日志补读 |
| 试镜的渲染不写记忆经历 | 同一镜头连着渲染几遍是人为安排的对照，混进统计会让一次通过率失真（与考试经历同理） |
| 评判写进 `audition.json`，同时经 `afterVote`（命令行与客户端同一个函数）追加进记忆库目录的 `auditions.jsonl`（同一场改判以最后一行为准）、同步范例库、落人评考试的结论。选手在记录里叫「渲染工具/模型」（`contestantKey`：指定了模型用指定的，否则用实际读到的），两段式的叫「实现者<设计者」，记录带项目目录与每位的标号 | 谁在哪类镜头（`features`）上赢了谁要跨项目累积；向老师学要回项目里读两边的代码 |
| 采用（`adoptFiles`）只收评判过、产物合格、不是人评考试的选手，镜头输入摘要（`inputDigest`）对不上就拒绝；先 `archiveAttempt`，再拷入除项目镜头输入、`frame.md`、渲染记录、设计稿日志以外的文件（选手的 `design.md` 跟着进去）；随后把 `scene.json` 的 `renderer` 改成胜者的工具，按项目里的镜头（同样召回记忆与范例）重写渲染记录 | 渲染工具在指纹里，不改的话采用完马上 Stale；模型不在指纹里，以后重渲染按设置的模型 |
| 两段式：镜头目录有 `design.md`（`scene.DesignFile`）时它是镜头的输入（`inputFiles`），提示词在 prompt.md 之后加「设计稿（强制参考）」；`Scene.designOnly` 时 `buildPrompt` 换成 `designPrompt`（把实现者会拿到的完整说明放进定界块，只要求写 design.md），`scene.run` 不归档、不写尝试记录与渲染记录，日志写 `design-<镜头>.*`，校验 design.md 非空。没有 design.md 的镜头提示词与指纹逐字不变 | 设计者看到的约束与实现者完全一样，写出来的稿才做得出来；只写设计稿不能动镜头已有的产物 |
| 学习关系在记忆库目录的 `learning.json`（`confirmRelation` / `removeRelation` / `dismissProposal`），由人在「进化」页确认；`proposals` 从评判里两两比胜负提议（总体说不清、某类题材说得清时单独提一条），样本少（少于 `ProposalMinMatches` 场或胜率低于 `ProposalMinRate`）照样列出、标「样本少」；两段式的选手、人评考试不进胜负统计 | 不自动认定老师：照别人设计稿做出来的说明不了实现者自己的本事 |
| 向老师学（`learn`）：取老师赢了学生、两边目录都在、还没学过（经验的 `from_auditions`）的试镜，最多 `MaxPairs` 组，代码拷进记忆库 `learn/<run>/pairs/`，交给整理者（与记忆整理同一个 Drafter、同一套 `lint`，被拒的改一稿）。收下时 onset 写定 `checked_by: [audition.judged]`、`applies_when.renderers/models`（学生）、`learned_from`（老师）、`from_auditions`；不写 consolidate 事件 | 范围与出处不能交给整理者写；consolidate 事件会挪动「上次整理」的时间，下一次整理就漏了失败经历 |
| `audition.judged`（`memory.CheckerAudition`）是「人在试镜里判的」：只给带 `learned_from` 的经验（`lint` 拦着），`examinable` 为 false（机器考试不考它），由人评考试定。记忆文件的 `learned_from` / `from_auditions` 没写时文件逐字不变，不进 `ruleDigest` | 画面好坏只有人判得了；出处不该让召回它的镜头 Stale |
| 人评考试：`scene_audition` 给 `exam`（关系编号）时出三份——学生不带新经验（control）、学生带（trial，召回时 `extra` 加上要考的试用经验，其余逐字相同）、老师作参照（reference，R）。人只能从两份学生作品里选；选中 trial 经 `memory.promoteExamined` 生效（试镜编号记进 `verified_by`），选中 control 经验被拒，差不多或都不行留在试用；结论生效后不能改判 | 校验器分不出动画好坏（真实数据一次通过率 97%），学得对不对只能人看 |
| 范例库在记忆库目录的 `exemplars/`：评判的胜者（不含人评考试）拷一份合成源码（只拷文本、跳过日志与尝试记录、限大小）带 `exemplar.json`，改判换胜者就换、改成差不多就删。渲染时（`attachMemory`、试镜各选手）按学习关系 `pickExemplars`：学生匹配（模型前缀）的关系里老师的范例，按共同题材、新旧挑最多 `MaxExemplars` 份，同项目同镜头的不给；经 `Scene.exemplars` 进提示词（召回段之后）与指纹（`exemplars` 一项，没有就不加），目录加进沙箱的可读目录 | 没有学习关系的渲染工具提示词与指纹都不变；同一个镜头给自己的答案等于抄 |
| 按镜头分派（`recommend`，`GET /api/auditions/recommend`）：与这个镜头有共同题材的试镜里谁赢得最多（出场不到两次不推荐，两段式的组合也在内），只在试镜页给一句推荐，不改任何设置 | 换不换由人定 |
