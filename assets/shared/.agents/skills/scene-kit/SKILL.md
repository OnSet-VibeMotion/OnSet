---
name: scene-kit
description: HyperFrames 镜头的按帧驱动工具库——缓动与淡入淡出、按短语帧取时间窗、按 frame.md 安全区取版式矩形、按 frame.md 字幕规范烧录字幕。写任何镜头合成时都可以用；镜头要内嵌字幕（frame.md 的 subtitles.required 为 true，或镜头本身需要烧录字幕）时必须用它，不得手写字幕代码。库文件是本目录下的 scene-kit.js。
---

# Scene Kit

每个镜头都要重新写一遍缓动函数、安全区换算和字幕，结果是镜头之间字幕位置、字号、断行各不相同，frame.md 里的字幕规范实际上没有任何共用代码去执行。`scene-kit.js` 把这些收成一个小库：**输入帧号，输出画面**，与 seek 顺序无关。

它不替你设计画面，也不建时间线。它只负责三件容易各写各的、写错了又不报错的事：时间换算、版式取值、字幕排版。

## 接进镜头

### 1. 使用镜头目录里的库

片场会在渲染前把 `scene-kit.js` 以相对软链接准备到镜头目录，不支持链接时使用副本。提示词有「共享渲染资源」段且列出该文件时直接用，不要再次复制、下载或改写。要改库就另存为镜头自己的文件并改引用，不要通过链接修改共享内容。

只有独立使用本技能、上层没有准备库文件时，才按下面的方式复制：

渲染只服务镜头目录内的文件，`<script src>` 指到镜头目录外会静默 404——字幕根本不出现，渲染却成功、退出码为 0：

```bash
cp <本技能目录>/scene-kit.js ./scene-kit.js
```

`<本技能目录>` 的本机绝对路径由 `onset` 写在镜头提示词的「镜头工具库」一段里，直接用那一条，不要猜路径，不要引用镜头目录之外的文件。只复制 `scene-kit.js`；`example.html` 是写法参考，不要放进镜头目录（它会被当成第二个合成入口）。

### 2. 先加载 onset-scene.js，再加载 scene-kit.js

`onset-scene.js` 由 `onset` 在渲染前写进镜头目录，定义 `window.ONSET_SCENE`：画布尺寸、帧率、总帧数、frame.md 的安全区与字幕规范、本镜头的字幕时间轴（`cues`）与短语时间窗（`phrases`）。分镜计划定了全片配色时还有 `look`（`background`、`ink`、`accent`，以及可选的 `surface`、`accent_2`，均为 `#RRGGBB`），颜色从这里读，不要在代码里另写一份；没定时这个键不存在。**不要自己写或改这个文件**，它每次渲染前都会被重新生成。

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script src="onset-scene.js"></script>
<script src="scene-kit.js"></script>
```

没加载 `onset-scene.js` 时，任何读数据的接口都会抛出「onset-scene.js 未加载」。

### 3. 把 render(frame) 挂到时间线上

```js
var K = window.SceneKit;
var subs = K.captions(document.getElementById('root'));

function render(frame) {
  // 这里写所有「帧号 -> 画面」的取值
  subs.render(frame);
}

var tl = gsap.timeline({ paused: true });
// …其它 tween 照常挂在 tl 上…
K.attach(tl, render);
window.__timelines['main'] = tl; // 键名与根节点 data-composition-id 一致，建完再注册
```

完整写法见本目录的 `example.html`。

## API

所有帧号都是**镜头本地帧**：第 0 帧是本镜头第一帧，与 `cues` / `phrases` 的坐标系一致。

### 数学（不读 onset-scene.js）

| 接口 | 说明 |
|---|---|
| `clamp(v, lo, hi)` | 钳位 |
| `lerp(a, b, t)` | 线性插值 |
| `ease(name, t)` / `ease(name)` | 求缓动值（t 先钳到 [0, 1]）/ 取缓动函数。可选：`linear`、`sineIn/Out/InOut`、`quadIn/Out/InOut`、`cubicIn/Out/InOut`、`expoIn/Out/InOut`、`backIn/Out/InOut`，以及三条强张力曲线：`snappyOut`（入场/落定，`0.23,1,0.32,1`）、`smoothInOut`（画面内移动/形变，`0.77,0,0.175,1`）、`drawerOut`（大面板推入，`0.32,0.72,0,1`）。未知名字抛错 |
| `cubicBezier(x1, y1, x2, y2, t?)` | 通用三次贝塞尔缓动；省略 `t` 返回缓动函数，传 `t` 直接求值（`x1`/`x2` 须在 `[0, 1]`） |
| `spring(frame, startFrame, options?)` | 按帧确定性物理弹簧（0 → 1，可过冲）。`options` 支持 `{duration, bounce, durationFrames, fps}`：`duration` 为感知时长（秒，默认 `0.5`），`bounce` 在 `(-1, 1)`（默认 `0.2`；`0` 临界阻尼无回弹，`0.1–0.3` 轻弹，`<0` 过阻尼柔缓）；未传 `fps` 时自动读 `ONSET_SCENE.fps` |
| `stagger(index, count, totalFrames, easeName?)` | 非均匀交错偏移帧（默认 `sineOut`，间隔逐项递减成波浪感而非等差排队）；返回整数帧偏移，可直接加到进场帧或 `phraseText` 的 `enterFrame` |
| `progress(frame, start, end)` | frame 在区间里的进度，钳在 [0, 1] |
| `fade(frame, inStart, inEnd, outStart?, outEnd?)` | 淡入淡出系数；省略后两个参数表示不淡出 |
| `rng(seed)` | mulberry32 固定种子伪随机数，返回 `() => [0, 1)`。种子可以是数字或字符串 |

### 数据

| 接口 | 说明 |
|---|---|
| `scene()` | 返回 `window.ONSET_SCENE`；缺失或 schema 不符时抛错 |
| `frameOf(seconds)` | 时间轴秒数换本地帧号：`Math.round(秒 × fps)`。全库只有这一处换算 |
| `phrase(id)` | 短语时间窗 `{phrase_id, text, start_frame, end_frame_exclusive, min_readable_frames}`；未知 id 抛错并列出已有 id |
| `phraseActive(id, frame)` | `start_frame <= frame < end_frame_exclusive` |
| `phraseText(element, id, options?)` | 正文独立文字层，共用短语定义生成逐帧显隐与阅读事件；见下节 |
| `cueAt(frame)` | 该帧所在的原始字幕条目（不含 lead/tail 放宽），重叠时开始得晚的胜出；没有则 `null` |

### 正文文字层

正文标题、标签和多行文字优先用同一份定义驱动绘制与清单，避免只写入场位移、首帧露字、回跳残留或重复加全局起点：

```js
var labels = [SceneKit.phraseText(document.getElementById('label'), 'phrase-id', {
  text: SceneKit.phrase('phrase-id').text,
  readableStartFrame: SceneKit.phrase('phrase-id').start_frame + 6,
  endFrame: SceneKit.scene().frames
})];
function render(frame) {
  // 先更新其他动画，再逐帧重算文字显隐。
  labels.forEach(function (label) { label.render(frame); });
}
var localEvents = labels.map(function (label) { return label.event(); });
var filmEvents = labels.map(function (label) { return label.event({global: true}); });
```

- 元素必须有稳定 `id`，创建时就隐藏；`render(frame)` 只在 `[enterFrame, endFrame)` 显示，默认从短语开始到镜头结束。`enterFrame` 不能早于短语，返回后仍须接进逐帧回调。
- `text` 默认用短语文字。每个独立可读项分别定义；多行属于同一短语时对全部文字层调用，不给共用画布只绑一次。
- 可选 `readableStartFrame`、`readableEndFrame` 声明实际稳定可读窗口；库不自动测量动画的可读性，淡入、遮罩或位移耗时须如实填写，阅读时长仍用正式检查核对。`event()` 输出局部帧，`event({global:true})` 才加一次全片起点；不要再手工加偏移。
- 画布文字须独占一层并提供 `draw(frame, phrase, context)`；每帧先清除该层，只有时间窗内才绘制。回调仍须按帧计算、保持绘制与申报的 `text` 一致。不要把含其他图形的共用画布交给它清除。
- 可选 `eventId`、`selector`、`role` 定义事件身份；正文不能标为 `decorative`。纯装饰或语义图形单独登记，不为了凑清单硬加文字。
- 已核实批准的封面主题预告按项目例外独立实现；不要为了使用此函数给封面随意绑定第一个短语，也不能修改冻结字幕或短语合同。

### 版式

`safeRect(name)` 返回 `{left, top, right, bottom, width, height}`，单位 px。`left/top/right/bottom` 是**距画布左上角的坐标**（`right = left + width`），不是 frame.md 里那种距各边的内缩量。`name` 取 frame.md `safe_area` 下的键，常见的有 `structural`、`main_content`、`critical_text`、`cover_title`、`subtitles`；未知名字抛错并列出已有键。

### 字幕

```js
var subs = SceneKit.captions(rootElement, options);
subs.render(frame);   // 返回当前显示的 cue 或 null
subs.element;         // 字幕层根元素
subs.layouts;         // 每条字幕的排版结果：{cue, fontSize, lines, overflow, from, until}
subs.events();        // 按实际布局导出字幕事件，局部帧
subs.events({global: true}); // 导出全片帧，仅加一次 start_frame
```

- **位置**：字幕层铺满 `safe_area.subtitles`，字幕框默认贴底居中。
- **版式**来自 `ONSET_SCENE.subtitles`（frame.md 只规定这些技术约束）：字号取 `font_size_px.max`，行高取 `line_height.max`，`max_width_px`（再与安全区宽度取小）、`max_lines`、`max_fullwidth_chars_per_line`。字体族继承自 `rootElement`。
- **配色**由镜头自己定，frame.md 不规定：文字颜色缺省取整片配色的 `ONSET_SCENE.look.ink`（分镜计划定了 `look` 时），否则继承 `rootElement`；没有底框。要底框、换颜色、加内边距或圆角，用下表的 `color`、`background`、`padding`、`radius`，跟随本镜头或整片风格的配色，并保证字幕在画面上读得清。
- **断行**：宽度按全角字计，汉字与全角标点算 1、ASCII 算 0.5，每行不超过 `max_fullwidth_chars_per_line`。不拆英文词、不拆数字与单位（`3.5 秒`、`98%`、`GPT-4`）、不拆《》“”""「」括起来的整段；优先在 `；，、。！？：` 之后断；两行时尽量等长；逗号句号不落行首。
- **超长**：放不进 `max_lines` 时逐像素缩小字号，最小到 `font_size_px.min`（每行可容纳字数按比例放宽，行的像素长度不变）；仍放不下才多出行数，并按字幕序号各 `console.warn` 一次。看到这条告警要回去把字幕拆短，而不是改库。
- **交接**：同一时刻只显示一条字幕，后一条一出现就截断前一条。
- **纯函数**：DOM 只在 `captions()` 时建一次；`render(frame)` 每次都把文字、字号、显隐全部写成该帧应有的值，任意帧、任意顺序调用结果相同。
- **阅读事件**：`events()` 读取实际 `layouts` 的行文字与 `from/until`，事件编号为 `subtitle-<cue.index>`、角色为 `subtitle`。跨层顺序检查时与正文 `phraseText(...).event()` 合并导出，不手抄另一套字幕时间。它不证明正文清单完整；只有字幕而没有待检查的正文或绑定图形时，不代表正文类经验已得到验证。
- **字幕是否实际烧录**：考试清单的 `subtitle_cues` 填实际字幕的 `subs.layouts.map(l => l.cue.index)`；镜头未烧录字幕时填 `[]`。字幕可选时，不因为存在 SRT 就假定画面已有字幕，也不只为交清单增加字幕。项目明确要求烧录时仍须按要求制作。

| options | 默认 | 说明 |
|---|---|---|
| `fontSize` | `font_size_px.max` | 首选字号；缩字号的下限仍是 `font_size_px.min` |
| `lineHeight` | `line_height.max` | 行高倍数 |
| `fontFamily` / `fontWeight` | 继承 | 只在字幕要用与根节点不同的字体时设 |
| `color` | `look.ink`，没有 look 时继承 | 字幕文字颜色 |
| `background` | 透明 | 字幕框底色（例如本镜头配色里的深色加透明度） |
| `padding` / `radius` | 0 / 0 | 字幕框内边距 `{vertical, horizontal}`（px）与圆角（px） |
| `leadFrames` / `tailFrames` | 0 | 让字幕提前出现 / 延后消失，但不侵入相邻字幕本来的显示区间 |
| `align` | `bottom` | 字幕框在安全区内的竖直位置：`bottom` / `center` / `top` |
| `safeArea` | `subtitles` | 换用别的安全区 |
| `cues` | `ONSET_SCENE.cues` | 换一组字幕时间轴（本地帧） |
| `className` / `zIndex` | — / 50 | 追加类名 / 层级 |

`ONSET_SCENE.subtitles` 为 `null`（frame.md 没有字幕规范）时 `captions()` 直接抛错，不凭空编一套样式。

### 接入时间线

`attach(timeline, render)` 把 `render(帧号)` 挂到一条 `gsap.timeline({ paused: true })` 上，立即出一次第 0 帧，返回一个无参 `draw()`（按时间线当前位置补出一帧）。帧号取 `Math.round(timeline.time() × fps)`，钳在 `[0, frames - 1]`。

只靠 `onUpdate` 不够：GSAP 的 `tl.seek(t)` 默认 `suppressEvents=true`，`onUpdate` 一次都不触发；宿主走 `window.__hf.seek` 时子时间线自己的 `seek` 也不会被调用。所以 `attach` 做三层（与 HyperFrames 0.8.14 的上游示例 `hyperframes-animation/examples/messaging-multi-phrase.html` 和本项目 `character-rig` 的 `cast.js` 同一做法）：

1. 一条覆盖整镜的驱动 tween，`onUpdate` 里出帧；
2. 时间线自己的 `seek` / `pause` 包一层，调用后补出一帧；
3. `window.__hf` / `window.__player` 的 `seek` 包一层，补出所有已接入的帧。

自检时推进时间线一律用 `tl.time(t)` 或 `tl.seek(t, false)`。同页还用 `cast.js` 时，先 `await cast.mount(...)`，再调 `SceneKit.attach`。

## 确定性规则

- `render(frame)` 必须只由 `frame` 决定：不读时钟，不用未播种随机数（要随机就用 `rng(固定种子)`，并且在 render 之外一次取好），不在两帧之间累积状态，不靠「播过去了」翻标志位。
- 不用 `requestAnimationFrame`、定时器或 CSS `transition` / `@keyframes` 驱动画面；它们不受时间线管，成片要么静止要么乱。
- 不在 render 里创建或删除 DOM 节点，只改已有节点的属性与文字。
- 不手抄 frame.md 的像素与字号：版式用 `safeRect`，字幕用 `captions`，时间用 `phrase` / `cueAt`。frame.md 改了，手抄的那份不会跟着改。
- 第 0 帧必须已经是完整画面：`attach` 会立即画出第 0 帧，但入场动画写成「第 0 帧透明」的话照样是空封面。

`scene-kit.js` 自身通过 `onset` 的确定性源码扫描；你在镜头里写的代码同样会被扫。
