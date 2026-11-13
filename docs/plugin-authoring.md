# 写一个 ArticleToMotion 插件

插件（代码里叫「第三方站」）是给 ArticleToMotion 的制作流程加的一站，例如成片做好后自动发布。ArticleToMotion 不分发、不维护第三方插件；用户在客户端设置页「流程插件」里填来源加进某个项目，只对那个项目生效。

插件的代码不进 ArticleToMotion 的进程。它能做的事全写在一份清单 `am-station.json` 里，添加时与设置页里都照实列给用户看：

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
  am-station.json
  prompt.md
  bin/send
```

`am-station.json`：

```json
{
  "manifest_version": 1,
  "requires": { "am": "0.2.0" },
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
echo "am-progress 0.3 正在上传"
mkdir -p production/my-publisher
echo '{"ok": true}' > production/my-publisher/receipt.json
echo 'am-result {"url": "https://example.com/v/1"}'
```

`prompt.md` 是写给 AI 的说明，例如「成片确认后，请用户在发布页点『把成片发到平台』」。

开发时用 `link:/绝对路径` 加进项目，改动立即生效；发布后让用户用 `github:作者/仓库#v0.1.0` 添加。

## 字段分级

| 分级 | 含义 |
|---|---|
| 稳定 | 承诺兼容：以后的版本不改它的意思，要改就升 `manifest_version` |
| 实验性 | 以后的版本可能调整。用到了的插件，设置页「详情与设置」与添加时的输出会写明「用到了实验性能力：…，以后的版本可能调整」 |

## 顶层字段

| 字段 | 分级 | 说明 |
|---|---|---|
| `manifest_version` | 稳定 | 清单格式版本，整数，现在是 1；不写按 1 读。比这一版 ArticleToMotion 认得的新时，报「要更新的 ArticleToMotion」 |
| `requires` | 稳定 | 对 ArticleToMotion 的要求：`{"am": "0.2.0"}` 是最低版本（x.y.z，按 semver 比较）。比的是客户端的版本号（命令行里是 am 的版本号）；不满足时报错、不加载。本地开发构建（版本号是 dev）不查 |
| `id` | 稳定 | 必填。小写字母开头，小写字母、数字与连字符，2–40 个字符；不能与内置站、内置插件重名 |
| `version` | 稳定 | 必填。插件自己的版本号 |
| `name` | 稳定 | 必填。给用户看的名字 |
| `description` | 稳定 | 一句话说明它做什么（设置页显示） |
| `after` | 稳定 | 站点排在制作路线上哪个站点之后（站点 id，例如 `publish`）；不写或找不到排在最后 |
| `replaces` | 稳定 | 整站顶替一个自带的站（站 id，例如 `sound`）。顶替后那一站的站点换成本插件的 |
| `prompt` | 稳定 | 插件目录里的 Markdown 文件，接在制作说明最后，自带一节标题和来源说明；与上面的约定冲突时以上面为准 |
| `nodes` | 稳定 | 制作路线上的站点，见「站点」 |
| `produces` | 稳定 | 插件会写的项目文件，见「会写的文件」 |
| `ops` | 稳定 | 操作，见「操作」 |
| `pages` | 稳定 | 页面，见「页面」 |
| `settings` | 稳定 | 设置项，见「设置」 |
| `permissions` | 稳定 | 页面要的权限，见「权限」 |
| `hooks` | 实验性 | 事件钩子：`[{"on": "film.approved", "op": "notify"}]`。`on` 取 `turn.finished`、`task.finished`、`gate.confirmed`、`film.approved`；`op` 必须是 `trigger: agent` 且没有必填参数的操作。项目正忙时这次不跑，不排队 |
| `schedules` | 实验性 | 定时：`[{"every_minutes": 30, "op": "sync"}]`，5–1440 分钟，只限 agent 操作。客户端开着、项目打开着才跑，不补跑 |
| `slots` | 实验性 | 把页面嵌进自带页面：`[{"at": "publish", "page": "mini", "height": 140}]`。`at` 取 `script`、`storyboard`、`scene`、`final`、`publish`、`progress`；`height` 80–1200，缺省 240 |
| `commands` | 实验性 | 对话框的斜杠命令：`[{"name": "publish", "description": "打开发布面板", "page": "dashboard"}]`，`page`（打开本插件的页面）与 `prompt`（填进输入框的一段话）二选一 |
| `inserts` | 实验性 | 插进制作说明某个阶段末尾的补充：`[{"stage": "render", "file": "prompts/render.md"}]`。`stage` 取 `intake`、`script`、`voice`、`timeline`、`plan`、`render`、`visual-qc`、`assemble`、`sound`、`mix`、`review`、`publish`、`wrapup` |
| `flow` | 实验性 | 整套流程（新片型）：`{"name": "快剪", "stations": ["intake", "render", "my-publisher"], "first_page": "script", "prompt": "prompts/flow.md"}`。`stations` 写自带站的 id 与本插件的 id；`first_page` 取 `script`、`beat` 或本插件页面的 id；用户在设置页选用后，制作路线、顶栏第一步与各阶段说明都换成它的，公共约定照旧。新建时记了流程的项目，`stations` 里写的自带站会带上自带站的那几段说明（引用了你的流程里没有的阶段时写成那一步的标题），你的 `prompt` 只需要写你自己那几站 |
| `provides` | 实验性 | 提供配音或字幕对齐：`{"tts": {"name": "某配音", "op": "speak", "timestamps": "none"}, "align": {"name": "某对齐", "op": "align"}}`。`timestamps` 取 `none`、`sentence`、`word`；项目把 `TTS_PROVIDER` / `ALIGN_PROVIDER` 设成 `x:<插件 id>` 时 AI 用这条操作 |
| `renderer_skills` | 实验性 | 给渲染镜头的技能：`[{"name": "caption-kit", "dir": "skills/caption-kit", "summary": "字幕卡片的写法", "scenes": "opt-in"}]`。`dir` 下必须有 `SKILL.md`；`scenes: all` 每个镜头都带（加上后已渲染的镜头要重渲染），`opt-in`（缺省）只给 `scene.json` 的 `plugin_skills` 点名的镜头 |
| `film_styles` | 实验性 | 整片风格库：`{"name": "我的风格库", "dir": "styles"}`。`dir` 下每个子目录是一种风格（`STYLE.md` 必需，`SKILL.md`、`poster.jpg`、`style.json` 可选） |

ArticleToMotion 自己的内置功能也用这份清单（只写名字与说明，作开关用），它们带来的代码在 ArticleToMotion 进程里登记，不经清单，所以没有给内置插件专用的字段。

写了不认识的字段直接报错（「有不认识的字段」）。所有路径都是相对路径：插件目录里的（`prompt`、命令、页面、技能、风格库）不能跑出插件目录；项目里的（`outputs`、`gate_files`、`produces`、`reads`）不能是绝对路径、不能有 `..`，也不能是 ArticleToMotion 自己的文件（`production/studio/`、`production/usage/`、`production/memory-exams/`、`.agents/`、`.env`）。

### 站点（`nodes`）

| 字段 | 说明 |
|---|---|
| `id` | 必填，小写字母、数字与连字符；同一条路线里不能与别的站点重名 |
| `label` | 必填，路线上显示的名字 |
| `step` | 必填，属于顶栏哪一步：`beat`、`script`、`storyboard`、`scene`、`final`、`publish` |
| `gate` | `true` 是审核关卡（等用户确认），缺省 `false` |
| `page` | 点这个站点时打开的页面：本插件页面的 id，或客户端自带的页面 |
| `outputs` | 普通站点必填：这些文件存在就算做了 |
| `stale_after` | 站点 id：那些站点的产物比本站新时，标「上游改过」 |
| `gate_files` | 关卡必填：用户确认的是哪些文件，之后这些文件变了就是「确认后又改过」 |

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

设置存在用户级目录（`<数据目录>/am/stations/<插件 id>/config/`），所有项目共用；`secret` 存在 0600 的文件里，只经 stdin 交给插件的子进程，客户端界面与页面只知道「填没填」。

### 权限（`permissions`）

| 字段 | 说明 |
|---|---|
| `project` | `true` 时页面能用 `am.project()` 拿项目摘要（镜头、制作路线、发布信息、画幅、风格） |
| `network` | 页面能连的地址，只写到域名（与端口）：`["https://api.example.com"]`，只认 `https://` 与 `wss://`。不写就完全不能连网 |
| `uses` | 页面能请用户确认后调的 ArticleToMotion 操作（`am.call()`），例如 `review`、`scene_run`。归档、记忆回滚与导入、节拍确认、`station_*`、`config_set` 等不能申请 |

## 子进程协议

操作在子进程里执行：

- 工作目录是项目根。
- stdin 是一行 JSON：`{"params": {…}, "settings": {…}, "project_root": "…", "station_dir": "…", "data_dir": "…"}`；由事件钩子触发时另有 `"event": {"name": "film.approved", …}`。参数已按清单校验并补上缺省值，`settings` 含 `secret` 的值。
- 环境变量只有 `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG`、`LC_ALL`、代理（`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及小写写法）、证书（`SSL_CERT_FILE`、`SSL_CERT_DIR`），以及：
  - `AM_STATION_DATA`：插件自己的数据目录（`<数据目录>/am/stations/<插件 id>/data`），凭据、缓存放这里；
  - `AM_PROJECT_ROOT`：项目根；
  - `AM_STATION_DIR`：插件目录。

  项目的 `.env`（配音、模型服务的凭据）一概不传。
- stdout、stderr 原样显示给用户（任务日志、工具输出）。
- 进度：打印 `am-progress <0–1 的小数> <说明>` 一行，显示成任务进度条。
- 结果：最后一行打印 `am-result <JSON>`，是结构化结果（AI 拿到的工具结果、界面上的「上次运行」）。这一行不显示给用户；不是合法 JSON 算失败。
- 退出码非 0 算失败，错误信息取 stderr 最后几行。用户取消时整组结束子进程。

## 页面桥 `window.am`

页面在 `sandbox="allow-scripts"` 的 iframe 里，内容安全策略只许加载 entry 所在目录里的文件与宿主的 SDK，不能请求 ArticleToMotion 的接口，`permissions.network` 之外不能连网。页面里加：

```html
<script src="/station-ui/_sdk.js"></script>
```

之后用 `window.am`。除 `ready`、`mediaURL`、`onRefresh` 外都返回 Promise，被拒绝时 reject：

| 方法 | 说明 |
|---|---|
| `am.ready` | 宿主的配色交过来之后完成；页面可以 `await am.ready` 再显示 |
| `am.info()` | 项目名、本插件信息、操作、设置（不含密钥）与嵌入位上下文（嵌在镜头页时带镜头编号） |
| `am.project()` | 项目摘要：镜头、制作路线、发布信息、画幅、风格（要 `permissions.project`） |
| `am.read(path)` | 读一个项目文件：`{path, size, text}`，图片另有 `data_url`。只给 `reads`、`produces` 与站点 `outputs` 里的文件 |
| `am.mediaURL(path)` | 项目里视频、图片的地址，可以直接放进 `<video>`、`<img>`（同样只给能读的文件） |
| `am.run(op, params)` | 执行本插件的一条操作：宿主先在页面上方弹确认条，用户点「执行」才跑 |
| `am.call(op, params)` | 调一条 ArticleToMotion 自带的操作（要在 `permissions.uses` 里申请），同样先请用户确认 |
| `am.send(text)` | 把一段话作为一条消息发给 AI，先请用户确认 |
| `am.ask(text)` | 把一段话填进对话输入框，不发送 |
| `am.open(page)` | 打开本插件的另一个页面 |
| `am.onRefresh(fn)` | 项目有变化（任务跑完、一轮对话结束）时回调，页面据此重读 |

页面里的按钮可以被脚本自己点，所以凡是对外、花钱或改项目的动作，宿主都要用户在宿主界面上再点一次。

页面一加载就可以调这些方法，不用等任何「就绪」事件：宿主在插入 iframe 的同一次提交里就挂好了监听。宿主 15 秒内没有回应的请求以「ArticleToMotion 没有回应这个请求」reject，不会一直挂着；`run`、`call`、`send` 一弹出确认条宿主就先回一声「收到了」，之后等用户多久都不算超时。确认条盖在页面顶部，不会把页面往下推。

## 锁文件、来源与更新

加进项目后，项目根的 `article-to-motion.flow.json` 记下：

```json
{
  "version": 1,
  "stations": [
    { "id": "my-publisher", "version": "0.1.0", "source": "github:someone/my-publisher#v0.1.0", "commit": "…", "digest": "sha256:…" }
  ]
}
```

另有 `flow`（项目选用了哪个插件带来的流程）、`disabled`（关掉的内置插件）与 `production`（新建项目时记下的片型、提示词组合版本、画幅与制作说明的摘要；有它的项目，制作说明在运行期按流程组合，你的 `inserts` 插在那个阶段末尾、`prompt` 接在最后）。

来源有三种写法：

| 来源 | 说明 |
|---|---|
| `link:/绝对路径` | 本机目录，开发用：改动立即生效，不核对内容，不需要更新 |
| `github:owner/repo#ref` | 按 ref（tag、分支或 commit）克隆 |
| git 地址`#ref` | `https://`、`git@`、`ssh://`、`file://` |

git 来源克隆后记下 commit 与整个目录的内容摘要，存进用户级目录 `<数据目录>/am/stations/<插件 id>/<commit>`（`AM_STATIONS_DIR` 可覆盖）。之后内容与摘要对不上（被改过）就不再使用，设置页提示重新添加。插件目录里不能有符号链接。

更新：设置页的「更新」按钮按锁文件里记的来源重新取一次——来源写的是分支时拿到它现在的 commit，写的是 tag 时 tag 被移动过才会变——列出版本、commit、新申请的权限与新用到的实验性能力，再写回锁文件。所以发布新版本时，建议让用户用分支来源，或者让用户以新 tag 重新添加。

## 兼容性

- 清单格式有变时升 `manifest_version`；旧版 ArticleToMotion 读到新格式的清单会报「要更新的 ArticleToMotion」，而不是「不认识的字段」。
- 用到了新版 ArticleToMotion 才有的能力时写 `requires.am`。
- 实验性字段可能在以后的版本里调整；只用稳定字段的插件，升级 ArticleToMotion 不用改。
