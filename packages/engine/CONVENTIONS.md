# 引擎的编码约定

`packages/engine/src/<包>/` 是 am 的引擎，`packages/cli` 与 `apps/desktop` 都只经它读写项目。

这些约定大多数只为一件事：**用户机器上已经有的文件必须读写得一模一样**。用户的项目（`scene.json`、`.am-render.json`、尝试记录、Studio 会话与快照）、用户级的记忆库（经历、快照、`models.json`）与渲染指纹，很多是早先的 Go 实现写出来的。指纹按字节算摘要，记忆召回段要逐字稳定，错误文案被测试、提示词和用户一起依赖——换一种 JSON 转义、换一种浮点格式，老镜头就会全部被判成 Stale，记忆快照对不上，编排工具照着提示词找的那句报错也不见了。所以下面这些写法看起来像在模仿 Go，用意是兼容已有数据，不是怀旧。

## 目录与命名

| 位置 | 约定 |
|---|---|
| `src/<包>/<文件>.ts` | 包的实现；包的公开 API 统一从 `src/<包>/index.ts` 导出，外部用 `@am/engine/<包>` 引用 |
| `src/<包>/<文件>.test.ts` | Vitest 用例，与实现同目录 |
| `src/<包>/testdata/…` | 测试用的固定数据，只放在包自己的目录里 |
| 子包（如 `src/filmstyle/lemo/`） | 同样有自己的 `index.ts` |

- 类型、接口、类用 PascalCase；函数与变量用 camelCase；导出的常量保留历史名字（`MissingToolPrefix`、`PinnedVersion`、`DefaultMaxLessons`），文档、提示词和注释里一直这么叫它们。
- JSON 字段名就是文件里的字段名，类型定义里直接写成 `snake_case` 字段，不在读写时转换。
- 包之间用相对路径导入：`import { atomicWrite } from '../fsutil';`。
- 注释里「为什么」的部分（实测结论、踩过的坑）不要删减，它们往往是某条约定唯一的出处。

## 行为

- **错误**：失败一律抛 `Error`；调用方要按类型判断的（如 `VerificationError`、`prereq.MissingError`、`schedule.FatalError`）定义成子类并导出。**错误文案不要随手改**：测试、提示词和用户都依赖这些中文，改了要同步改所有引用它的地方。
- **文件 IO 用同步 API**（`fs.readFileSync` 等），保持顺序语义；要原子替换的写用 `../fsutil` 的 `atomicWrite`。
- **子进程**：等结果的短命令用 `spawnSync` / `execFileSync`；要流式读输出、要能取消的用 `spawn` 返回 Promise，取消用 `AbortSignal`，外部 AI CLI 经 `../procgroup` 开独立进程组、取消时整组终止。外部命令一律先经 `envutil.lookPath(name, env.PATH)` 解析，缺失时抛 `MissingToolError`（`MissingToolPrefix` 前缀是退出码 127 的契约）。
- **ffprobe / ffmpeg 只经 `mediaprobe` 调用**，别在其他包里直接拼这两个命令。
- **JSON 写出必须用 `../gojson`**（`marshal` / `marshalIndent` / `encodeLine`），不要用 `JSON.stringify`：已有文件默认转义 `< > &`，不转义的地方传 `escapeHTML: false`；键按字典序写出的对象用 `sortedKeys()` 排序。可省略的零值字段在构造对象时自己判断（字段设成 `undefined` 即被省略）。
- **数字与字符串格式化一律用 `../gofmt`**：`formatFixed`（定点小数，中点取偶）、`formatG`（浮点的最短表示）、`goRound`（远离零取整）、`goQuote`（带转义的引号串）、`goTrimSpace`、`goClean` / `goJoin` / `goDir` / `goExt`（`/` 分隔的路径）、`goPathError`。不要在自己的包里再写一份。
- **文件错误文案**：已有提示常把底层文件错误原样拼进中文（如「读取…失败：open x: no such file or directory」），用 `goPathError('open', path, err)` 生成同样的文字。
- **JSON 读入**：`JSON.parse` 即可；拒收多余字段的格式（如分镜计划）要显式检查多余字段并给出固定的错误。
- **YAML** 用 `yaml` 包。
- **时间**：写出带纳秒的 RFC3339 时间时 `toISOString()` 不够，用现成的格式化函数（如 `studio/http.ts` 的 `formatRFC3339Nano`），不要各写一份。
- **浮点与取整**：JS 的 `Math.round` 对负的 .5 与 `goRound` 不同；帧号、时长这类会写进文件或参与比对的值只用 `goRound` 或包里现成的换算（如 `beat.frameOf`）。
- **字符串长度**：字节数用 `Buffer.byteLength(s)`，字符数用 `[...s].length`；`s.length` 是 UTF-16 码元数，三者都可能不同，按原意选。
- **排序**：要与已有文件一致的排序按字节序，用 `../gojson` 的 `compareBytes`，不要用 `localeCompare`。
- **遍历顺序**：凡是结果依赖顺序的地方都先显式排序，不依赖对象键或目录项的自然顺序。
- **正则**：规则与早先写下的 RE2 风格正则保持同一语义：`\s` 只含 ASCII 空白（写成 `[\t\n\f\r ]`）；大小写不敏感时 `s` 还要匹配 `ſ`、`k` 还要匹配开尔文符号 K；不要给正则加 `u` 标志，否则 `\b`、`\w` 会变成 Unicode 语义。`determinism/gostd.ts` 有现成的处理（`S`、`SIN`、`ci`），可以参考。确定性扫描的命中结果直接决定渲染是否失败，正则语义一变，同一份合成在新旧版本上判定不同。
- **写文件时的坑**：用编辑工具写入的源码里，正则字面量中的 `\uXXXX` 转义会被改写成真实字符（曾经出现一个真的 U+2028，把正则弄坏）。需要特殊字符时用 `String.fromCodePoint` 或码点比较，写完用 `LC_ALL=C grep -rln $'\xe2\x80\xa8' src` 自查。

## 测试

- 需要外部工具（ffmpeg、rsvg-convert、git）的测试在工具缺失时跳过（`it.skipIf(!hasFfmpeg)`）。CI 装了这些工具，缺了的话测试照样「通过」，真正跑外部命令的代码就没人验证。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), 'am-<包>-'))`；测试不得写进用户的真实目录（HOME、`~/.local/share/am`）。需要 HOME 的测试把 `process.env.HOME` 指到临时目录并在 `afterEach` 里还原；记忆库默认打开，要写记忆的测试经 `AM_MEMORY_DIR` 指到临时目录（`studio/testsupport.ts`、`packages/cli/src/testutil.ts` 已经这样做）。
- 改完至少在 `packages/engine` 下跑通 `npx vitest run src/<包>` 与 `npx tsc --noEmit -p .`（整个包零类型错误）。

## 边界

- 新增依赖要有理由：引擎会被打进命令行与客户端，运行时依赖越少越好。
- `package-lock.json` 里的 `resolved` 必须是 `registry.npmjs.org`：用镜像装完依赖要换回官方源再提交，CI 访问不到国内镜像。
