# 平台封面

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

`publish.md` 的 `cover.images` 登记上传用的平台封面，校验在 `packages/engine/src/plugins/publishing/cover_images.ts`（随「发布」搬进内置插件），平台规格只有一个来源：`coverSpecs`（抖音 4:3 + 3:4、小红书 3:4 / 1:1 / 4:3（`ready` 前要的比例跟成片方向：横屏 4:3、竖屏 3:4，`landscapeRequired` / `requiredCovers`）、视频号 3:4 / 16:9、B 站与知乎 16:10，以及各平台 `ready` 前必须备齐的比例）。平台规则变了改这张表，制作提示词第十二阶段「平台封面」的表格要同步改，`gen.test.ts` 的「requires platform covers」钉着那一节。

尺寸以文件实测为准、声明值只用来对账：手填宽高与实际不符，说明封面改过却没回填，发布时上传的就不是记录里那张。短边下限 1080，所以 B 站常见的 1146×717 不合格（它本身也不是精确的 16:10），用 1920×1200。模板里写封面尺寸时用「宽 1440、高 1080」，不要写成 `1440×1080` 这类乘号形式——`gen.test.ts` 的「substitutes the canvas label」会把它当成写死的画幅拦下。

`safeRelative`（`validate/validate.ts`）解析路径时找最近一层已存在的上级目录（`resolveExisting`），不只看直接父目录：目标在还没建出来的子目录里（例如还没出图的 `covers/`）时，只解析父目录会因为 macOS 临时目录的 `/var` → `/private/var` 符号链接而误判成逃出项目。

话题同理按平台可选：`copy.hashtags` 是通用的，`copy.platform_hashtags`（可选，「平台: [话题…]」）给要用自己话题的平台写它完整的列表（例如小红书的活动话题），没写的平台照用通用的。与 `copy.platform_titles` 共用一张平台表（`copy_titles.ts` 的 `knownPlatforms`：有字数上限的加有封面规格的），校验（`validatePlatformHashtags`）只查形状：平台要认识、值是非空字符串的列表，空列表表示这个平台不带话题；问题一次报全。`/api/publish` 在写了平台标题或平台话题时另给 `platform_names`（平台中文名），发布页按它列「小红书 话题」，有平台话题时通用那一行叫「通用话题」。制作提示词第十二阶段只让编排在用户提到或确有平台专属话题时才写，不为每个平台抄一份。
