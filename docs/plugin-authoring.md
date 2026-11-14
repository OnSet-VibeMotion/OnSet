# 写一个片场插件

插件（代码里叫「第三方站」）是给片场的制作流程加的一站，例如成片做好后自动发布。片场不分发、不维护第三方插件；用户在客户端设置页「我的插件」里填来源装上，装一次对这台电脑上的所有项目生效（没打开项目也能装）；它带来的片型与风格在首页新建项目时就能选。

插件的代码不进片场的进程。它能做的事全写在一份清单 `onset-station.json` 里，添加时与设置页里都照实列给用户看：

- 一段交给 AI 的制作说明（接在项目的制作说明后面）；
- 制作路线上的站点，按文件判断做没做；
- 它会写哪些项目文件；
- 几条操作，在子进程里执行；
- 几个页面，在客户端里以沙箱 iframe 打开。

本文的字段说明与解析器一致：解析器只认 `packages/engine/src/flow/manifest.ts` 的 `ManifestFields` 里列出的顶层字段，`manifest.test.ts` 核对下面「顶层字段」表与它一一对应。

## 最小的例子

目录结构：

```
my-publisher/
  onset-station.json
  prompt.md
  bin/send
```

`onset-station.json`：

```json
{
  "manifest_version": 1,
  "requires": { "onset": "0.2.0" },
  "id": "my-publisher",
  "version": "0.1.0",
  "name": "自动发布",
  "description": "成片确认后发到平台",
  "after": "publish",
  "prompt": "prompt.md",
  "nodes": [
    { "id": "my-publish", "label": "自动发布", "step": "publish", "outputs": ["production/my-publisher/receipt.json"], "stale_after": ["review"] }
  ],
  "produces": [{ "prefix": "production/my-publisher/" }],
  "ops": [
    {
      "name": "send",
      "summary": "把成片发到平台",
      "trigger": "user",
      "command": ["bin/send"],
      "params": { "platform": { "type": "string", "description": "平台，例如 douyin", "required": true } }
    }
  ]
}
```

`bin/send`（要有执行权限）：

```sh
#!/bin/sh
input=$(cat)                       # 一行 JSON：params、settings、project_root……
echo "onset-progress 0.3 正在上传"
mkdir -p production/my-publisher
echo '{"ok": true}' > production/my-publisher/receipt.json
echo 'onset-result {"url": "https://example.com/v/1"}'
```

`prompt.md` 是写给 AI 的说明，例如「成片确认后，请用户在发布页点『把成片发到平台』」。

开发时用 `link:/绝对路径` 装上，改动立即生效；发布后让用户用 `github:作者/仓库#v0.1.0` 添加。

## 字段分级

| 分级 | 含义 |
|---|---|
| 稳定 | 承诺兼容：以后的版本不改它的意思，要改就升 `manifest_version` |
| 实验性 | 以后的版本可能调整。用到了的插件，设置页「详情与设置」与添加时的输出会写明「用到了实验性能力：…，以后的版本可能调整」 |

## 顶层字段

| 字段 | 分级 | 说明 |
|---|---|---|
| `manifest_version` | 稳定 | 清单格式版本，整数，现在是 1；不写按 1 读。比这一版片场认得的新时，报「要更新的片场」 |
| `requires` | 稳定 | 对片场的要求：`{"onset": "0.2.0"}` 是最低版本（x.y.z，按 semver 比较）。比的是客户端的版本号（命令行里是 onset 的版本号）；不满足时报错、不加载。本地开发构建（版本号是 dev）不查 |
| `id` | 稳定 | 必填。小写字母开头，小写字母、数字与连字符，2–40 个字符；不能与内置站、内置插件重名 |
| `version` | 稳定 | 必填。插件自己的版本号 |
| `name` | 稳定 | 必填。给用户看的名字 |
| `description` | 稳定 | 一句话说明它做什么（设置页显示） |
| `after` | 稳定 | 站点排在制作路线上哪个站点之后（站点 id，例如 `publish`）；不写或找不到排在最后。带了 `flow` 的插件不写 `after`、`replaces` 时，站点只出现在它自己的流程里 |
| `replaces` | 稳定 | 整站顶替一个自带的站（站 id，例如 `sound`）。顶替后那一站的站点换成本插件的 |
| `prompt` | 稳定 | 插件目录里的 Markdown 文件，接在制作说明最后，自带一节标题和来源说明；与上面的约定冲突时以上面为准 |
| `nodes` | 稳定 | 制作路线上的站点，见「站点」（站点里的 `state`、`guide` 两项是实验性的） |
| `produces` | 稳定 | 插件会写的项目文件，见「会写的文件」 |
| `ops` | 稳定 | 操作，见「操作」 |
| `pages` | 稳定 | 页面，见「页面」 |
| `settings` | 稳定 | 设置项，见「设置」 |
| `permissions` | 稳定 | 页面要的权限，见「权限」 |
| `hooks` | 实验性 | 事件钩子：`[{"on": "film.approved", "op": "notify"}]`。`on` 取 `turn.finished`、`task.finished`、`gate.confirmed`、`film.approved`；`op` 必须是 `trigger: agent` 且没有必填参数的操作。项目正忙时这次不跑，不排队 |
| `schedules` | 实验性 | 定时：`[{"every_minutes": 30, "op": "sync"}]`，5–1440 分钟，只限 agent 操作。客户端开着时在当前打开的项目里跑，不补跑 |
| `slots` | 实验性 | 把页面嵌进自带页面：`[{"at": "publish", "page": "mini", "height": 140}]`。`at` 取 `script`、`storyboard`、`scene`、`final`、`publish`、`progress`；`height` 80–1200，缺省 240 |
| `commands` | 实验性 | 对话框的斜杠命令：`[{"name": "publish", "description": "打开发布面板", "page": "dashboard"}]`，`page`（打开本插件的页面）与 `prompt`（填进输入框的一段话）二选一 |
| `inserts` | 实验性 | 插进制作说明某个阶段末尾的补充：`[{"stage": "render", "file": "prompts/render.md"}]`。`stage` 取 `intake`、`script`、`voice`、`timeline`、`plan`、`render`、`visual-qc`、`assemble`、`sound`、`mix`、`review`、`publish`、`wrapup` |
| `flow` | 实验性 | 整套流程（新片型）：`{"name": "快剪", "stations": ["intake", "render", "my-publisher"], "first_page": "script", "prompt": "prompts/flow.md"}`。`stations` 写自带站的 id 与本插件的 id；`first_page` 取自带流程的第一步页（口播是 `script`，卡点是 `beat`）或本插件页面的 id；它是新建项目时的一个做法（首页的「做法」里标明来自你的插件），用它新建的项目流程记成 `x:<插件 id>`，制作路线、顶栏第一步与各阶段说明都是它的，公共约定照旧；已有项目不能中途换流程，插件去掉后用它新建的项目开不了工。`stations` 里写的自带站会带上自带站的那几段说明（引用了你的流程里没有的阶段时写成那一步的标题），你的 `prompt` 只需要写你自己那几站 |
| `provides` | 实验性 | 提供配音或字幕对齐：`{"tts": {"name": "某配音", "op": "speak", "timestamps": "none"}, "align": {"name": "某对齐", "op": "align"}}`。`timestamps` 取 `none`、`sentence`、`word`；项目把 `TTS_PROVIDER` / `ALIGN_PROVIDER` 设成 `x:<插件 id>` 时 AI 用这条操作 |
| `renderer_skills` | 实验性 | 给渲染镜头的技能：`[{"name": "caption-kit", "dir": "skills/caption-kit", "summary": "字幕卡片的写法", "scenes": "opt-in"}]`。`dir` 下必须有 `SKILL.md`；`scenes: all` 每个镜头都带（装上后所有项目里已渲染的镜头要重渲染），`opt-in`（缺省）只给 `scene.json` 的 `plugin_skills` 点名的镜头 |
| `film_styles` | 实验性 | 整片风格库：`{"name": "我的风格库", "dir": "styles"}`。`dir` 下每个子目录是一种风格（`STYLE.md` 必需，`SKILL.md`、`poster.jpg`、`style.json` 可选），装进项目时整个子目录拷进去。加 `"only_referenced": true`（实验性）时只带用到的：风格目录与风格库根目录下的 `assets/` 只带风格的脚本与页面里出现过名字的文件（模型目录按目录名认），`node_modules/three/` 只带脚本 import 到的模块；风格库根的这两个目录给几种风格共用 |
| `skins` | 实验性 | 界面皮肤：`["skins/mint.json"]`，每个文件一套皮肤，格式见下面「界面皮肤」。换的是这台电脑上客户端与桌宠的样子，用户在设置页「外观」里选 |

片场自己的内置功能（音乐卡点、歌曲讲解、多角色对话、发布……）也用这份清单（只写名字与说明），它们带来的代码在片场进程里登记，不经清单，所以没有给内置插件专用的字段。内置功能常开、不能关：它们的工具与说明对每个项目都在，一个项目用不用得上由片型（流程）决定，例如口播项目的制作说明里没有卡点的那几段。

写了不认识的字段直接报错（「有不认识的字段」）。所有路径都是相对路径：插件目录里的（`prompt`、命令、页面、技能、风格库）不能跑出插件目录；项目里的（`outputs`、`gate_files`、`state.file`、`produces`、`reads`）不能是绝对路径、不能有 `..`，也不能是片场自己的文件（`production/studio/`、`production/usage/`、`production/memory-exams/`、`.agents/`、`.env`）。

### 站点（`nodes`）

| 字段 | 分级 | 说明 |
|---|---|---|
| `id` | 稳定 | 必填，小写字母、数字与连字符；同一条路线里不能与别的站点重名 |
| `label` | 稳定 | 必填，路线上显示的名字 |
| `step` | 稳定 | 必填，属于顶栏哪一步：`script`、`storyboard`、`scene`、`final`、`publish`，以及内置插件登记的步骤（音乐卡点的 `beat`） |
| `gate` | 稳定 | `true` 是审核关卡（等用户确认），缺省 `false` |
| `page` | 稳定 | 点这个站点时打开的页面：本插件页面的 id，或客户端自带的页面 |
| `outputs` | 稳定 | 这些文件里有一个存在就算做完（取最新的修改时间）。普通站点 `outputs` 与 `state` 至少写一个 |
| `stale_after` | 稳定 | 站点 id：那些站点的产物比本站新时，标「上游改过」 |
| `gate_files` | 稳定 | 关卡必填：用户确认的是哪些文件，之后这些文件变了就是「确认后又改过」 |
| `state` | 实验性 | 按项目文件里一个字段的值定这一站的状态、说明与在等谁，见下面「按文件内容定状态」；关卡不能写 |
| `guide` | 实验性 | 这一站是「现在在这」时，对话顶上「接下来」卡片的说法与按钮，见下面「接下来」 |

#### 按文件内容定状态（`state`）

`outputs` 只能说「文件在不在」。发布这类站点做没做看的是文件里的一个字段（例如 `publish.md` frontmatter 的 `publish_status`），用 `state` 声明：

```json
"state": {
  "file": "publish.md",
  "frontmatter": "publish_status",
  "cases": [
    { "is": "ready", "status": "done", "detail": "可以发布" },
    { "is": "pending_manual_checks", "status": "doing", "detail": "还剩人工检查", "waiting": "user" },
    { "is": ["draft", "blocked"], "status": "doing", "detail": "还在写" }
  ],
  "otherwise": { "status": "doing", "detail": "状态：{value}" },
  "missing": { "status": "todo" },
  "invalid": { "status": "doing", "detail": "写坏了" },
  "no_field": { "status": "doing", "detail": "还没有状态" }
}
```

| 字段 | 说明 |
|---|---|
| `file` | 必填，项目里的相对路径；只能是本插件 `produces`、站点 `outputs` 或页面 `reads` 里的文件，不能是片场自己的文件。超过 256 KB、或真实路径（符号链接）跑出项目的，按读不了处理 |
| `json` / `frontmatter` | 二选一：读 JSON 文件，或 Markdown 开头 `---` 之间的 YAML；值是用 `.` 分隔的键路径（`publish.status`） |
| `cases` | 必填，按顺序比较，第一个 `is` 命中的那项生效。`is` 是一个值或几个值的数组（字符串、数字、布尔），只做相等比较，类型也要相同（`3` 与 `"3"` 不相等） |
| `otherwise` | 字段有值、但不在任何 `cases` 里 |
| `missing` | 文件不在 |
| `invalid` | 文件太大、读不了、解析不了，或顶层不是对象 |
| `no_field` | 字段不在，或值不是字符串、数字、布尔 |

每一项（`cases` 里的每条与后面四个）可写：`status`（`todo` 没做、`doing` 进行中、`done` 做完，缺省 `todo`）、`detail`（路线上那一站下面的一句话；`cases` 与 `otherwise` 里的 `{value}` 换成读到的值）、`waiting`（这一站是「现在在这」时在等谁：`user` 等你、`ai` AI 在做，缺省 AI）、`guide`（停在这一项时换用的「接下来」，写法同下）。没写的那几项一律是「没做」、没有说明。

规则：站点的 `outputs` 里有文件时直接算做完，不再看 `state`（产物是最硬的证据）；没有时按 `state` 落到的那一项。`done` 的完成时间取状态文件的修改时间（`stale_after` 拿它比）。`doing` 与 `todo` 在路线上都显示为没做完，区别是后面的站都做了时，`todo` 显示为「跳过」，`doing` 不会。片场不运行插件的任何代码来判断状态，判断只看这份声明。

#### 「接下来」（`guide`）

```json
"guide": {
  "ai": "AI 在做封面和发布信息。",
  "user": "发布前还剩几项人工检查。",
  "actions": [
    { "label": "核对完了", "draft": "发布前的人工检查我核对完了：" },
    { "label": "发出去", "op": "send_now" },
    { "label": "看发布看板", "page": "dashboard" }
  ]
}
```

`ai` 是 AI 在做时的说法，`user` 是等你时的说法；`actions` 是等你时卡片上的按钮，每个按钮写 `label` 加下面四个之一：`say`（直接发给 AI 的一句话）、`draft`（填进输入框，让用户接着写）、`page`（本插件页面的 id，或客户端自带的页面）、`op`（本插件一条 `trigger: user`、没有必填参数的操作；点了先在卡片上问一次，用户点「执行」才跑）。`state` 落到的那一项写了 `guide` 时用那一份，否则用站点的。

### 会写的文件（`produces`）

每项写 `{"path": "整条路径"}`，或 `{"prefix": "目录/"}`，可加 `"base": "文件名正则"`。客户端据此把每轮对话里改过的文件归到这一站，页面也能读这些文件。

### 操作（`ops`）

| 字段 | 说明 |
|---|---|
| `name` | 必填，小写加下划线（`send`、`sync_status`） |
| `summary` | 必填，一句话说明 |
| `description` | 完整说明（AI 用 `tool_help` 查到的） |
| `examples` | 调用例子，按工具写法：`x_my_publisher_status({})` |
| `command` | 必填，命令与参数。第一个元素带 `/` 时是插件目录里的相对路径，否则按 PATH 找（`node`、`python3`）；参数里的 `{station_dir}` 换成插件目录 |
| `params` | 参数：`{"名字": {"type": "string", "description": "…", "required": true, "default": …}}`，`type` 取 `string`、`boolean`、`integer`、`number`、`strings`（字符串数组） |
| `trigger` | `agent`（缺省）：AI 能调，登记成工具 `x_<插件 id 的连字符换成下划线>_<操作名>`；`user`：只有用户在客户端里点按钮才执行，发布这类对外、不能撤回的动作用它 |

### 页面（`pages`）

| 字段 | 说明 |
|---|---|
| `id` | 必填，小写字母、数字与连字符；客户端里的页面 id 是 `x:<插件 id>:<页面 id>` |
| `label` | 必填，页面名字 |
| `entry` | 必填，插件目录里的 `.html` 文件；页面只能加载 entry 所在目录里的文件 |
| `reads` | 页面能读的项目文件：以 `/` 结尾是目录前缀，否则是整条路径 |

### 设置（`settings`）

| 字段 | 说明 |
|---|---|
| `key` | 必填，小写加下划线 |
| `label` | 必填 |
| `type` | 必填：`string`、`number`、`boolean`、`select`、`secret` |
| `description` | 说明 |
| `options` | `select` 必填，可选值 |
| `default` | 缺省值，类型要与 `type` 相符；`secret` 不能有缺省值 |

设置存在用户级目录（`<数据目录>/onset/stations/<插件 id>/config/`），所有项目共用；`secret` 存在 0600 的文件里，只经 stdin 交给插件的子进程，客户端界面与页面只知道「填没填」。

### 权限（`permissions`）

| 字段 | 说明 |
|---|---|
| `project` | `true` 时页面能用 `onset.project()` 拿项目摘要（镜头、制作路线、发布信息、画幅、风格） |
| `network` | 页面能连的地址，只写到域名（与端口）：`["https://api.example.com"]`，只认 `https://` 与 `wss://`。不写就完全不能连网 |
| `uses` | 页面能请用户确认后调的片场操作（`onset.call()`），例如 `review`、`scene_run`。归档、记忆回滚与导入、节拍确认、`station_*`、`config_set` 等不能申请 |

## 子进程协议

操作在子进程里执行：

- 工作目录是项目根。
- stdin 是一行 JSON：`{"params": {…}, "settings": {…}, "project_root": "…", "station_dir": "…", "data_dir": "…"}`；由事件钩子触发时另有 `"event": {"name": "film.approved", …}`。参数已按清单校验并补上缺省值，`settings` 含 `secret` 的值。
- 环境变量只有 `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG`、`LC_ALL`、代理（`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及小写写法）、证书（`SSL_CERT_FILE`、`SSL_CERT_DIR`），以及：
  - `ONSET_STATION_DATA`：插件自己的数据目录（`<数据目录>/onset/stations/<插件 id>/data`），凭据、缓存放这里；
  - `ONSET_PROJECT_ROOT`：项目根；
  - `ONSET_STATION_DIR`：插件目录。

  项目的 `.env`（配音、模型服务的凭据）一概不传。
- stdout、stderr 原样显示给用户（任务日志、工具输出）。
- 进度：打印 `onset-progress <0–1 的小数> <说明>` 一行，显示成任务进度条。
- 结果：最后一行打印 `onset-result <JSON>`，是结构化结果（AI 拿到的工具结果、界面上的「上次运行」）。这一行不显示给用户；不是合法 JSON 算失败。
- 退出码非 0 算失败，错误信息取 stderr 最后几行。用户取消时整组结束子进程。

## 页面桥 `window.onset`

页面在 `sandbox="allow-scripts"` 的 iframe 里，内容安全策略只许加载 entry 所在目录里的文件与宿主的 SDK，不能请求片场的接口，`permissions.network` 之外不能连网。页面里加：

```html
<script src="/station-ui/_sdk.js"></script>
```

之后用 `window.onset`。除 `ready`、`mediaURL`、`onRefresh` 外都返回 Promise，被拒绝时 reject：

| 方法 | 说明 |
|---|---|
| `onset.ready` | 宿主的配色交过来之后完成；页面可以 `await onset.ready` 再显示 |
| `onset.info()` | 项目名、本插件信息、操作、设置（不含密钥）与嵌入位上下文（嵌在镜头页时带镜头编号） |
| `onset.project()` | 项目摘要：镜头、制作路线、发布信息、画幅、风格（要 `permissions.project`） |
| `onset.read(path)` | 读一个项目文件：`{path, size, text}`，图片另有 `data_url`。只给 `reads`、`produces` 与站点 `outputs` 里的文件 |
| `onset.mediaURL(path)` | 项目里视频、图片的地址，可以直接放进 `<video>`、`<img>`（同样只给能读的文件） |
| `onset.run(op, params)` | 执行本插件的一条操作：宿主先在页面上方弹确认条，用户点「执行」才跑 |
| `onset.call(op, params)` | 调一条片场自带的操作（要在 `permissions.uses` 里申请），同样先请用户确认 |
| `onset.send(text)` | 把一段话作为一条消息发给 AI，先请用户确认 |
| `onset.ask(text)` | 把一段话填进对话输入框，不发送 |
| `onset.open(page)` | 打开本插件的另一个页面 |
| `onset.onRefresh(fn)` | 项目有变化（任务跑完、一轮对话结束）时回调，页面据此重读 |

页面里的按钮可以被脚本自己点，所以凡是对外、花钱或改项目的动作，宿主都要用户在宿主界面上再点一次。

页面一加载就可以调这些方法，不用等任何「就绪」事件：宿主在插入 iframe 的同一次提交里就挂好了监听。宿主 15 秒内没有回应的请求以「片场没有回应这个请求」reject，不会一直挂着；`run`、`call`、`send` 一弹出确认条宿主就先回一声「收到了」，之后等用户多久都不算超时。确认条盖在页面顶部，不会把页面往下推。

## 装在哪、来源与更新

插件装在用户级，不进任何项目。已装的插件记在 `<数据目录>/onset/stations/installed.json`（`ONSET_STATIONS_DIR` 可覆盖）：

```json
{
  "version": 1,
  "plugins": [
    { "id": "my-publisher", "version": "0.1.0", "source": "github:someone/my-publisher#v0.1.0", "commit": "…", "digest": "sha256:…",
      "role": { "flow": false, "replaces": "", "after": "publish", "nodes": true } }
  ]
}
```

装上之后它对所有项目生效：站点进每个项目的制作路线（`after` / `replaces`），说明接在每个项目的制作说明后面（带了 `flow` 的插件例外：没写 `after`、`replaces` 时，站点、说明与阶段补充只进它自己的流程），AI 能用的操作是每个项目的工具，页面、小窗、斜杠命令处处都在；钩子与定时只在当前打开的项目里跑。`scenes: all` 的渲染技能会让所有项目里已渲染的镜头标成要重渲染，添加时会照实告诉用户。项目里只记「这个项目选了什么」：新建时选的做法（流程，`onset.flow.json` 的 `production`）、配音与对齐的取值、镜头的 `plugin_skills`、装进项目的整片风格。

添加分两步：设置页（或 `station_add`）先把插件取到用户级目录的暂存处、校验清单，给用户看它的实情——AI 能用的工具与要用户点的按钮、页面权限、用到的实验性能力、钩子与定时、渲染技能（`scenes: all` 会让所有项目重渲染）、带来的做法与风格库、在路线上的位置；这时它还不在已装插件清单里，不参与任何项目。用户点「装上」（`station_install`）才装上，点取消（`station_discard`）就清掉暂存。所以清单里的 `name`、`description`、操作的 `summary` 要写成用户看得懂的话：用户就是凭这些决定装不装。

`role` 是装上时按清单记下的「它在制作里出现在哪」。插件后来读不出来（本机目录没了、内容被改过、清单写坏）时，只有它参与的项目（用它的流程新建的、它顶替或接进了那条路线的）开工报错，其余项目照常开工并提示一声；设置页「我的插件」列出问题，给「更新 / 去掉」。

来源有三种写法：

| 来源 | 说明 |
|---|---|
| `link:/绝对路径` | 本机目录，开发用：改动立即生效，不核对内容，不需要更新 |
| `github:owner/repo#ref` | 按 ref（tag、分支或 commit）克隆 |
| git 地址`#ref` | `https://`、`git@`、`ssh://`、`file://` |

git 来源克隆后记下 commit 与整个目录的内容摘要，存进用户级目录 `<数据目录>/onset/stations/<插件 id>/<commit>`（`ONSET_STATIONS_DIR` 可覆盖）。之后内容与摘要对不上（被改过）就不再使用，设置页提示更新或重新添加。插件目录里不能有符号链接。

更新：设置页的「更新」按钮（`station_update`）按已装插件清单里记的来源重新取到暂存处——来源写的是分支时拿到它现在的 commit，写的是 tag 时 tag 被移动过才会变——先列出版本、commit、新申请的权限与新用到的实验性能力，用户点「换上」才写回清单。所以发布新版本时，建议让用户用分支来源，或者让用户以新 tag 重新添加。

## 兼容性

- 清单格式有变时升 `manifest_version`；旧版片场读到新格式的清单会报「要更新的片场」，而不是「不认识的字段」。
- 用到了新版片场才有的能力时写 `requires.onset`。
- 实验性字段可能在以后的版本里调整；只用稳定字段的插件，升级片场不用改。

## 界面皮肤（`skins`）

一套皮肤是一份 JSON，换客户端（主窗口与桌宠）的配色、字体与桌宠工作室的样子。皮肤只能是数据：不能带样式表与脚本，每个值都逐个校验，颜色只认 `#rrggbb`（3、4、6、8 位）、`rgb()`、`hsl()`，字体只认用逗号隔开的本机字体名，所以皮肤里写不进 `url()`、`@import` 这类会去连网或读文件的东西。

```json
{
  "id": "mint",
  "name": "薄荷",
  "description": "浅绿底，适合白天",
  "scheme": "light",
  "tokens": { "bg": "#f2faf5", "panel": "#fafffc", "text": "#13261b", "accent": "#2f8f5b" },
  "fonts": { "serif": "'Songti SC', serif" },
  "radius": 8,
  "pet": {
    "filter": { "hue": 100, "saturate": 0.9 },
    "materials": { "wood": ["#9cc9a8", "#7fae8c", "#679476"] },
    "crew": { "director": { "coat": "#ffffff", "hatColor": "#2f8f5b" } },
    "room": { "backdrop": "#e9f6ee" }
  }
}
```

| 字段 | 说明 |
|---|---|
| `id` | 小写字母开头的小写字母、数字与连字符；对外的标识是「插件 id/皮肤 id」 |
| `name` / `description` | 设置页「外观」上的名字（24 字以内）与一句话 |
| `scheme` | `dark`（缺省）或 `light`：原生控件（滚动条、输入框）跟着它 |
| `tokens` | 界面的颜色，键取 `bg` `panel` `raised` `well` `chip` `hover` `line` `line-strong` `text` `text-2` `text-3` `muted` `faint` `accent` `accent-hover` `accent-ink` `accent-soft` `accent-line` `accent-text` `ok` `stale` `bad` `add-bg` `del-bg`；没写的沿用放映室的默认值。浅色皮肤要把底（`bg` 到 `hover`）、线、字与强调色一起换 |
| `fonts` | `sans`（正文）、`serif`（标题）、`mono`（数字与小标签） |
| `radius` | 圆角像素，0–24 |
| `pet.filter` | 整间工作室一起调色：`hue`（-180–180 度）、`saturate`（0–2）、`brightness`、`contrast`（0.5–1.5） |
| `pet.materials` | 家具材质，每种三个颜色（顶面、朝左下的面、朝右下的面）：`wood` `walnut` `metal` `dark` `canvas` `brass` `paper` `plant` `pot` `lit` `rec` `roof` |
| `pet.crew` | 人的衣着：`director` `op1` `op2` `op3` `editor` `voice`，每人可换 `coat` `coatShade` `trousers` `shoe` `hair` `skin` `skinShade` `hatColor` |
| `pet.room` | 房间本身：`slab` `slab-left` `slab-right`（地台三面）、`wall-left` `wall-back`、`cap`（墙头）、`backdrop`（影棚背景纸） |
| `pet.page` | 整个换掉工作室：本插件 `pages` 里的一个页面 id。页面在桌宠的画布位置（400×326）以沙箱 iframe 打开，不能连网、不能直接调接口，但能经下面的消息做桌宠能做的一切；卡片、底下的批准与选项、脚注照旧由客户端画 |

用页面换掉工作室时，页面拿到桌宠的全部状态，也能做桌宠能做的一切——答批准、替用户发话、停下这一轮、切页。这些动作不再要用户在客户端上确认：用户选了这套皮肤，就是把桌宠交给你的插件，装插件时设置页会照实说明。

```js
// 收：{onset: 'pet', signal, skin: {scheme, tokens}}
//   signal.mood 取 idle / thinking / reading / writing / storyboarding / running / filming / editing / voicing / waiting / done / failed / stopped
//   signal.line 是导演此刻在做什么的一句话，project 是项目名，rendering 是正在渲染的镜头编号
//   signal.asks 是等批准的调用 [{id, text, always}]（always 为真才能「以后都允许」）
//   signal.choices 是上一轮回复末尾的选项、signal.question 是选项前那句问话
//   signal.running 是这一轮还在跑，signal.canSend 是此刻能不能发话
window.addEventListener('message', (e) => {
  if (e.data && e.data.onset === 'pet') draw(e.data.signal);
});
// 发：
const tell = (command) => parent.postMessage({ onset: 'pet-command', command }, '*');
tell({ kind: 'answer', id: ask.id, decision: 'allow' }); // 或 'always'、'deny'
tell({ kind: 'say', text: '换成白板手绘风' });            // 替用户发一句话（这一轮在跑时排到它之后）
tell({ kind: 'stop' });                                    // 停下这一轮
tell({ kind: 'open', page: 'scene', target: 'scene-003' }); // 切到客户端的某一页
tell({ kind: 'focus' });                                   // 回到客户端
tell({ kind: 'type' });                                    // 页面里有输入框时先发它，桌宠窗口才收得到键盘
tell({ kind: 'hide' });                                    // 收起桌宠
```

桌宠能拖动：客户端发这个页面时会插进一小段脚本，在空白处按住挪动就拖桌宠窗口；按钮、链接、输入框照常能点，别的元素不想被当成拖动处就加 `data-no-drag`。

`open` 的 `page` 取客户端的页面 id（`progress`、`script`、`storyboard`、`scene`（`target` 写镜头编号）、`final`、`publish`……）。拿去当桌宠的页面不进顶栏的「插件」菜单。

