# 操作表

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

onset 的每一条制作步骤是一条操作（`packages/cli/src/ops/op.ts`）：

| 字段 | 约定 |
|---|---|
| `name` | 工具名，小写加下划线（`beat_import`），重复登记直接报错 |
| `cli` | 开发用命令行里的路径（`['beat', 'import']`），由 `ops/cli.ts` 的 `mountOps` 挂进 cobra 命令树；命令组的说明用 `defineGroup` |
| `params` | 具名参数：`type`（string / boolean / integer / number / strings / duration）、`description`、`default`、`required`；`positional` 只影响命令行（位置参数的次序），工具服务一律按名字传 |
| `summary` / `description` / `examples` | 按工具写法写，见「onset 的工具服务」 |
| `scopes` | 缺省只给编排工具；`hyperframes` 另给渲染器 |
| `run(params, ctx)` | 文字写进 `ctx.out`（工具输出、命令行屏幕都是它），结构化结果 `return { data }`；取消看 `ctx.signal`，`ctx.unsafe` 是根命令的 `--unsafe` |

新增一步制作：在对应模块里 `defineOp` 一条（模块要在 `cli.ts` 里 import，登记靠加载时的副作用），写好说明、参数与至少一个例子；工具、`tool_help`、客户端后端（`runStudioOp`）与开发用命令行自动都有。内置插件的操作在它的 `apply` 里 `ctx.op(...)`（字段与 `Op` 相同，可另写对话里的说法 `verb`），命令组用 `ctx.opGroup(...)`，由 `plugin_ops.ts` 照旧 `defineOp` / `defineGroup`。多条操作共用的参数（`project_root`、`timeout`）用 `ops/common.ts`（内置插件用 `@onset/engine/opkit`，同一份）。
