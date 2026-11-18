# 内置资产

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

项目骨架分两棵源树，`packages/engine/src/assets/index.ts` 是读取它们的唯一入口：

| 源树 | 内容 |
|---|---|
| `assets/shared/` | 与画幅无关，所有项目共用（配置模板、中文正文字体、`templates/`、`.agents/skills/`） |
| `assets/presets/<画幅>/` | 只随画幅变化：`frame.md`（由生成器从画幅表写出） |

制作提示词不在任何一棵树里、不拷进项目：段落在 `assets/prompts/` 与 `assets/plugins/<id>/sections/`，开工时按项目记下的流程组合（见「Prompt 文件」）。

**每棵树的内部路径就是它在用户项目根下的目标路径**，`project.initialize`（`packages/engine/src/project/init.ts`）把选中的两棵树叠加拷贝，不做任何路径改写。所以 `assets/shared/assets/fonts/` 这层嵌套是刻意的——它对应项目里的 `assets/fonts/`。两棵树写入同一路径会直接报错，不静默覆盖：画幅树里不放与共用树同名的文件。

资产不打进 JS：开发时直接读仓库里的 `assets/`，打包时 `apps/desktop/package.json` 的 `extraResources` 把整棵 `assets/` 拷进应用资源目录，客户端与命令行的启动方经 `ONSET_ASSETS_DIR` 告诉引擎它在哪。遍历时有一条过滤规则：**目录里名字以 `.` 或 `_` 开头的条目一律跳过**（macOS 的 `.DS_Store` 就靠它挡住），只有 `explicitDotEntries` 里列出的 `assets/shared/.env.example` 与 `assets/shared/.agents` 两个入口例外。**新增一个需要随 `onset init` 下发的点开头条目时，要把它加进 `explicitDotEntries`**——漏了不报错，只是那份内容静默到不了用户项目。`packages/engine/src/assets/index.test.ts` 的「skips dot and underscore entries except the explicit ones」与「includes the explicitly embedded dot entries」钉着这条规则；打包规则里的 `**/.*` 也要保留，否则点开头的文件在 .app 里根本不存在。

`onset init` 不覆盖内容不同的已有文件：目标已存在且字节不同就整体失败并回滚，不做合并。
