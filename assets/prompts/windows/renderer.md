### Windows 渲染执行环境补充

性能与就绪契约：GSAP 时间线必须以合成 id 登记到 window.__timelines；使用 CSS 或自定义逐帧 seek、确实不需要 GSAP 时间线的合成，才在对应宿主元素标记 data-no-timeline。先确认任意时刻 seek 的画面正确，再正式渲染；不要带着 sub_timeline_readiness_timeout 重复等待 45 秒或重复编码。不要给实际异步加载的 GSAP 合成添加该标记来绕过就绪检查。

关键帧与连续帧按一份去重时间列表，用 snapshot --at 的逗号列表一次截取；完成修改后只补受影响的阶段、交界和必要回归。已生成 MP4 的逐帧核查优先从该文件解码，同一源码、同一参数不重复 render 或反复打开同一份帮助。保持原有视觉、字幕和逐帧验收要求。

客户端会按 CPU 与内存分配 --workers，并在 Windows 工具入口限制它。不得使用 auto 或其他进程绕过该预算；GPU 是否使用看实际渲染日志的 hardware 与阶段耗时，编码已经低于 1 秒时，不把更换编码器当成制作耗时的解决办法。

客户端提供了与已安装解释器绑定的 python3；脚本运行使用 python3 脚本.py，保持 UTF-8，不在制作途中安装工具。可选目录先检查是否存在，再枚举文件。

Windows 计算文件摘要使用 Get-FileHash -Algorithm SHA256 -LiteralPath '实际文件路径'，不用共享说明中的 shasum / sha256sum。镜头目录通常不是 Git 仓库，无 .git 时不调用 Git 查询，不自行初始化或修改系统目录、权限。

镜头内只使用已提供的本地素材。镜头提示词有交接信号时，用 scene_preview_check() 完成首次检查与截图，按该信号交给片场正式渲染；其他检查与旧项目的渲染照镜头提示词调用 hyperframes。遵守原有沙箱、镜头边界和帧数，不更改任何批准、全局配音、分镜或相邻镜头。不因工具包装或平台变化重建已完成的镜头。

visible-event-inventory.json 中无文字的 decorative / graphic 元素可将阅读区间记为 null，但必须有正确的 enter_frame 与 exit_end_frame。已批准的第零帧封面仍用 role=cover 和 exception=approved_theme_preview 标注；真实批准由编排侧核对，不能自称批准。可读文字照常记录、检查，不把文字伪装成装饰。

事件的 phrase_id 必须是单个短语 ID 字符串或 null，不是数组；多个来源 ID 另存 source_phrase_ids。保持实际事件帧号与完整来源，不把数组直接传给字典键或 validate_reads，不任取第一个 ID、手工改时间或改成装饰绕过语义检查。
