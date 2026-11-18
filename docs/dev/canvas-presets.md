# 画幅预设

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

画幅在 `onset init` / 客户端新建时选一次（`--canvas`），之后不再改。它决定画布、帧率与安全区；配色、字体、版式、材质与动效不由项目文件规定，由各镜头自主决定或由「整片风格」统一。旧版的内置风格体系（风格表、风格说明书、示例图、自定义风格草稿、`--style` / `--style-brief`、`onset validate style`、`onset style fonts` / `add-font`、字体池）已整套删除。

项目根的 `frame.md` 是画幅的唯一落点，只有四块技术信息：`canvas`（宽高、帧率、朝向）、`safe_area`（五个安全区的像素内缩）、`subtitles`（烧录字幕的版式约束：字号范围、最大宽度、行数、每行字数、行高与断句规则，`scene-kit` 的 `SceneKit.captions` 读它；没有配色、圆角与内边距，字幕文字缺省跟随整片配色的 `look.ink`，底框与颜色由镜头经 `captions` 的选项自己定）与 `audio`（混音与成片响度目标，`onset review` 读 `final_*` 三项）。正文说明这些是技术信息、不是视觉命令。

镜头的画幅一律经 `scene.sceneCanvas` 取（`scene/scene.ts` 的 `frameSource`）：就近找 `frame.md`——镜头目录，再逐级向上到项目根（有 `onset.conf` 的那一层），找不到项目根时只看镜头目录。**哪儿都没有就报错，不回退任何默认画幅**：静默落到某个默认值的话，提示词、`onset-scene.js` 与产物校验三处一起错，选了 9:16 的项目整片出成 3:4 还照样「通过」（2026-11 实测）。`scene.json` 没有画幅字段（旧的 `style_guide` 已删，写了会报未知字段）。`scene.test.ts` 的「reads the project frame.md」「fails without any frame.md」钉着。记忆的考试重放时，`freezeInput` 把镜头当时就近读到的 `frame.md` 一起冻结进输入，重放按当时的画幅。

`assets/presets/<画幅>/frame.md` **由 `npm run generate -w @onset/engine` 生成，不要手改**。真相源是 `packages/engine/src/preset/table.ts` 的画幅表与 `packages/engine/src/preset/gen/templates/frame.md` 模板；生成器（`preset/gen/gen.ts`）整块替换 `canvas` 与 `safe_area`，再填占位符，不做 YAML 重序列化。安全区在画幅表里用 anchor 声明（贴顶 / 贴底 / 上下固定），构建期推导成绝对像素——anchor 不进项目文件，渲染工具读到的始终是现成像素值。`project.initialize` 把共用树与选中画幅的树叠加拷贝，`frame.md` 逐字节来自这里（`projectinit/index.test.ts` 的「writes the canvas frame.md and nothing of the old styles」）。

改完画幅表或模板后必须重跑生成器并提交产物，CI 的 `generated-assets` job 会校验二者一致（`gen.test.ts` 的「matches the committed assets byte-for-byte」在本地也能先拦下）。

模板里随画幅变化的东西一律写占位符，不写死：`{{SUBTITLE_MAX_WIDTH_PX}}` 等像素由生成器从安全区推导（可带整数偏移，如 `{{CONTENT_LEFT_PX+8}}`）；`{{ORIENTATION}}`、`{{PLATFORM_UI}}`、`{{AVOIDANCE_ZONES}}` 取自画幅表的 `platform`；`{{CANVAS}}` 是全角乘号写法的画幅。未知占位符会让生成器直接报错。同一个 `substituteCanvas` 也给运行期组合的制作提示词换画幅占位符。

新增画幅要动的地方：`packages/engine/src/preset/table.ts` 加一条（安全区、`platform` 平台措辞，必要时加 `layoutNotes` 构图要点，它接在 `frame.md` 正文末尾），跑生成器并提交 `assets/presets/<新画幅>/`。`scene.buildPrompt` 与产物校验只读 `frame.md` 的数字，不持有画幅常量。`assets/trees.test.ts` 查 `assets/presets/` 的目录与画幅表一一对应。

SVG 转 PNG（角色包预览，`packages/engine/src/svgimage`）必须走 `rsvg-convert`，**不能用 ImageMagick**：多数 ImageMagick 构建自带内置 XML SVG 渲染器，会抢在 rsvg 委托前接管 `.svg`，渲染不出文字也画不对背景填充，却返回退出码 0。
