### Windows 执行环境补充

这是 Windows 客户端的执行适配，不改变已批准的稿件、配音、分镜、时间轴或已完成镜头。

Windows 的 TTS_PROVIDER=breeze 使用已经准备好的 breeze-tts（audio.cpp 0.9.4、Breeze TTS 2 Q8_0、CUDA），替代共享说明中的 Apple Silicon / mlx-audio 命令。先查工具就绪；模型由包装器定位，不自行下载或切换模型。示例：breeze-tts --text_file production/audio/tts-text.txt --instruct "清晰自然的中文旁白" --cfg_scale 4 --output_path production/audio --file_prefix voice-v02 --join_audio --audio_format wav。克隆时带 --ref_audio 与准确的 --ref_text；默认音色和人工确认规则照旧。输出使用新文件名，保留已经确认的配音。

- 先用 windows_inspect() 查看已安装的 Python、实际并发上限和正在运行的镜头。可选的 production/visual-qc 等目录尚未生成是正常状态；用 windows_inspect({"paths":["production/visual-qc"]}) 查询，目录不存在时不要直接递归枚举。
- 项目规则中的 python3 由客户端映射到已准备好的 Python。运行脚本仍单独调用 python3 脚本.py；不要依赖 Windows 的应用商店别名，不在制作途中安装解释器或升级工具。
- 获取公开作品页、JSON、音频、ZIP 用 source_download()，不要混用 Windows curl 的 Schannel、Node REPL fetch 和临时下载脚本。下载工具保留 TLS 证书校验，使用系统代理，返回底层原因；不关闭证书验证或沙箱。
- source_download({"url":"https://example.org/work.html","output":"production/sources/work.html","kind":"html"}) 会提示页面中的公开 JSON 和下载端点。ZIP 下载页和返回下载链接的 JSON 会被解析；文件类型、CRC、体积或摘要不匹配时不写成正式素材。
- 动态作品页可能在 JavaScript 中 fetch 一个 JSON。原始 HTML 没有曲名时，先获取公开 JSON 数据，再用 record_field、record_value 和 record_title 核对唯一曲目身份。示例：source_download({"url":"https://example.org/pieces.json","output":"production/sources/pieces.json","kind":"json","record_field":"isrc","record_value":"曲目编号","record_title":"曲名"})。曲目身份检查不等于许可批准，仍须保存该作品的一手许可与署名证据。
- 下载到来源收件目录后，先核对类型、条目和许可，再提取、转换或混音。重复调用同一 URL 和文件可核对摘要后复用；遇到其他已有文件保持原样。不要在脚本失败后重复覆盖配音、素材、批准记录或已完成镜头。
- Windows 的 validate_reads 会核对已批准的第零帧封面文字例外，照常检查阅读时长；无文字的 decorative / graphic 元素使用自身存在区间，不伪造可读区间。不得把可读标题或语义文字改标为装饰来逃避校验，也不要靠删掉待检查文字获得“全片通过”。
- 同时渲染设置是上限。代表镜头可先单独检查，其余镜头使用 scene_run_all() 批量派发，jobs 缺省读取当前配置；单个 scene_run() 不会自动生成并发。依据实际运行镜头和任务报告说明进度。
- 代表镜头验收完成后，立即将全部待制作镜头交给一次 scene_run_all()，jobs 留空以读取用户当前设置；不要把之前的 3 或某次实际运行数量写死为 jobs。批量任务运行时可并行做来源核验和发布草稿等独立工作；共享素材与确认后的上游输入先准备并冻结。
