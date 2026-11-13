### 发布配置生命周期

平台、终稿和封面方向冻结后，立即参考 `templates/publish.md` 在根目录生成首版 `publish.md`，状态通常为 `draft`。文档必须以安全 YAML frontmatter 提供机器字段，并以固定 Markdown 章节提供人工可复制内容；不得把通用模板或其他作品的发布文案直接当成项目结果。

如果将替换已有 `final.mp4`，必须先保留旧视频哈希并把 `video.replacement_in_progress: true`，以 `video_replacement_in_progress` 将现有发布配置原子刷新为 `blocked`。该保护状态优先于封面未确认或人工检查待完成。

