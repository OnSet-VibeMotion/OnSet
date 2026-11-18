# 共享渲染资源

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

字体与固定版本的 JS/CSS 库在制作准备阶段分别放进用户项目的 `assets/fonts/` 与 `assets/vendor/`；`scene.run` 启动模型前由 `scene/resources.ts` 收集，`renderassets` 把每种内容独立复制到项目的 `.onset/resources/<sha256>`，再以**相对文件软链接**接到镜头的 `assets/fonts/`、`vendor/`。项目内的 `scene-kit.js` 同样自动准备。全局风格库缓存仍由安装页管理，渲染准备只读本机来源，不联网。

技能通过 `SkillDescriptor.runtimeAssets` 声明可共享的只读库，整片风格通过 `filmstyle.Source.runtimeAssets` 声明相对风格目录的运行资源；具体目录由来源插件给，通用 scene 代码不 import 来源插件。默认风格与点名风格都支持，`film_style: none` 不挂默认风格的库。没有声明的来源沿用原来的复制方式。镜头自己的代码、`onset-scene.js` 与需要改写的 demo 不放进共享池。

镜头的 `.onset-resources.json` 记录相对路径与 SHA-256。资源指纹按内容记在 `asset:<镜头内路径>`，不改原有 `digestTree` 的符号链接算法；来源更新与已挂载内容损坏都会使指纹变化。新提示词段与资源指纹项只在清单存在时启用，升级不让从未挂载共享资源的旧镜头变成 Stale。已写入池的内容不就地更新、不自动清理，旧镜头继续引用旧摘要；只在重新渲染某镜头时切换它的链接。不要把共享池放进 `.agents/skills`，否则加资源会改变所有技能的摘要。

资源源树与目标父目录拒绝符号链接；已有文件只有与来源逐字节相同，或是清单管理且未被改写的旧版本，才可换成链接。不同内容的用户文件保留并报冲突。Windows 创建文件链接无权限时用独立副本，不用绝对 junction 或硬链接。共享池用普通可复制权限，macOS 渲染沙箱按真实路径限制写入，验收前另校验资源摘要。修改库必须另存镜头自己的文件并改引用。

`.onset/resources/` 随项目一起搬迁；客户端预览仍用 `containedPath` 拒绝项目外的链接，不加全局缓存白名单。记忆 `freezeInput` 把共享资源变成普通文件；`archive.execute` 在移动前读取资源，归档时实体化，失败回滚恢复原链接，避免缓存属于 main 而没有一起归档时断链。对话快照跳过 `.onset` 与资源清单，不能单独回退清单而留下另一版本的链接；来源文件正常回退，下次渲染按回退后的内容重新挂载。上述契约由 `renderassets/index.test.ts`、`scene/resources.test.ts`、Studio 预览与回退、archive 的测试覆盖。
