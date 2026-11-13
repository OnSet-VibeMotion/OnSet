# 从 Go 移植到 TypeScript 的约定

`internal/<包>` 逐包移植到 `packages/engine/src/<包>/`。Go 版在切换前一直是标准答案：行为、错误文案、写出的文件都要与它一致。用户已有的项目、记忆库与渲染指纹都是 Go 版写的，TS 版读写它们不能有任何差别。

## 目录与命名

| Go | TypeScript |
|---|---|
| `internal/scene/prompt.go` | `src/scene/prompt.ts` |
| `internal/scene/prompt_test.go` | `src/scene/prompt.test.ts` |
| `internal/scene/testdata/…` | 复制到 `src/scene/testdata/…`（切换时 Go 目录会被删掉，不能引用它） |
| 包的公开 API | `src/<包>/index.ts` 统一导出 |
| 子包 `internal/filmstyle/lemo` | `src/filmstyle/lemo/` |

- 类型、接口、类用 PascalCase；函数与变量用 camelCase（`BuildPrompt` → `buildPrompt`）；导出的常量保留 Go 名字（`MissingToolPrefix`），便于对照搜索。
- JSON 字段名一律照抄 Go 的 struct tag，类型定义里写成 `snake_case` 字段，不做转换。
- 包之间用相对路径导入：`import { atomicWrite } from '../fsutil';`。
- 注释沿用 Go 版的中文注释，尤其是「为什么」的部分（实测结论、踩过的坑），不要删减。

## 行为

- **错误**：Go 返回 `error` 的地方抛 `Error`；调用方要按类型判断的（如 `VerificationError`、`prereq.MissingError`）定义成子类并导出。**错误文案逐字照抄**：测试、提示词和用户都依赖这些中文。
- **文件 IO 用同步 API**（`fs.readFileSync` 等），与 Go 的顺序语义一致。
- **子进程**：Go 里等结果的短命令（`cmd.Output()`、`cmd.Run()`）用 `spawnSync` / `execFileSync`；要流式读输出、要能取消（Go 用 `context`）的用 `spawn` 返回 Promise，取消用 `AbortSignal`。外部命令一律先经 `envutil.lookPath(name, env.PATH)` 解析，缺失时抛 `MissingToolError`（前缀是退出码 127 的契约）。
- **ffprobe / ffmpeg 只经 `mediaprobe` 调用**，与 Go 版的规则相同。
- **JSON 写出必须用 `../gojson`**（`marshal` / `marshalIndent` / `encodeLine`），不要用 `JSON.stringify`：Go 默认转义 `< > &`，用 `SetEscapeHTML(false)` 的地方传 `escapeHTML: false`；Go 里是 `map` 的字段用 `sortedKeys()` 排序。`omitempty` 的零值判断在构造对象时自己做（字段设成 `undefined` 即被省略）。
- **JSON 读入**：`JSON.parse` 即可；Go 用了 `DisallowUnknownFields` 的地方要显式检查多余字段并给出同样的错误。
- **YAML** 用 `yaml` 包（已安装）；Go 侧的校验逻辑照搬。
- **时间**：Go 的 `time.Time` 用 `Date`；写出格式要与 Go 一致（RFC3339 带纳秒时用 `toISOString()` 不够，要按 Go 的格式手写）。
- **浮点与取整**：`math.Round` 是「远离零」取整，JS 的 `Math.round` 对负的 .5 不同；照 Go 的语义写辅助函数。
- **字符串长度**：Go 的 `len(s)` 是字节数，`utf8.RuneCountInString` 是字符数；JS 的 `s.length` 是 UTF-16 码元数，三者都可能不同，按 Go 原意选：字符数用 `[...s].length`，字节数用 `Buffer.byteLength(s)`。
- **排序**：Go 的 `sort.Strings` 按字节序；用 `../gojson` 的 `compareBytes`，不要用 `localeCompare`。
- **map 遍历顺序**：Go 的 map 遍历是随机的，Go 代码凡是依赖顺序的地方都先排过序；TS 照搬那次排序。

## 测试

- 每个 `_test.go` 里的每一条用例都要移植成 Vitest 用例，用例名可以用英文概括，断言要等价。不要因为难移植就跳过；确实依赖 Go 特有机制（如 `go:embed` 校验）的，在测试文件里写明为什么不移植。
- 需要外部工具（ffmpeg、rsvg-convert、git）的测试，与 Go 版一样在工具缺失时跳过（`it.skipIf(!hasFfmpeg)`）。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), 'am-<包>-'))`；测试不得写进用户的真实目录（HOME、`~/.local/share/am`）。需要 HOME 的测试把 `process.env.HOME` 指到临时目录并在 `afterEach` 里还原。
- 完成前必须在 `packages/engine` 下跑通：`npx vitest run src/<包>` 与 `npx tsc --noEmit -p .`（整个包零类型错误）。

## 边界

- 不改 Go 代码，不改其他包的目录（除非是移植自己负责的包所必需的同层依赖，且已和协调者确认）。
- 不运行 `npm install`；需要新依赖时停下来说明要什么、为什么。
- 不提交 git。
