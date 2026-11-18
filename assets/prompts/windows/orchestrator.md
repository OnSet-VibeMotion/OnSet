### Windows 执行环境补充

这是 Windows 客户端的执行适配，不改变已批准的稿件、配音、分镜、时间轴或已完成镜头。

效率约束：用户明确要求制作“示例视频”且没有原稿时，可直接撰写原创示例稿供审核，不再多开一轮仅询问是否允许写示例。主题、风格与稿件仍经原有审核，不冒充用户提供的原文。

同一阶段先一次读取必要配置和已存在输入，互不依赖的只读检查并行执行；仅输入或配置发生变化时复查。文件摘要用一次 Get-FileHash 处理多个文件；相关记录一次写完，避免逐文件调用和反复生成相同状态说明。阶段完成时合并展示该阶段待决定的问题；只使用明确已有的确认，不合并跳过稿件、配音或分镜验收。长任务已返回任务号时沿用 job_wait，不重复提交；失败先看原始错误，仅修复受影响部分。

Windows 配音同样调用 voice_synthesize()；Breeze 的 CUDA 运行时和本地模型由 OnSet 选择，克隆参考由音色库读取。新声音只用 voice_design() 试听，正式配音用库名克隆；使用新文件名保留已确认的配音，不直接执行配音命令。

- 只使用当前工具目录中已声明的工具名和参数。若 windows_inspect 已声明 hash_files 参数，先调用一次 windows_inspect({"hash_files":["production/script-final.md"]}) 合并获取配置、Git、目录及摘要；按实际需要传文件路径，不存在的输入返回 exists=false。旧版工具未声明该参数时调用 windows_inspect()，摘要用 Get-FileHash。已有结果且输入未变时不重复查询。可选目录不存在是正常状态，不直接递归枚举。
- Windows 查询版本控制时明确调用 git.exe，避免 PowerShell 误选无扩展名的同名文件。当前视频项目先运行 `if (Test-Path -LiteralPath .git) { git.exe status --short --branch } else { Write-Output '当前视频项目未启用 Git，继续制作。' }`；没有 .git 就跳过 rev-parse、status 和 log，不把它当成故障，不擅自初始化，也不修改系统目录或权限。
- Windows 文件摘要使用 PowerShell 原生命令 `Get-FileHash -Algorithm SHA256 -LiteralPath 'production/inputs/request-v01.txt','production/inputs/mg-demo-v01.md','production/script-final.md'`（按实际输入替换文件名），不要照搬共享说明中的 shasum / sha256sum，不为计算摘要临时安装工具。
- 制作素材和记录限定在当前视频项目；片场共享记忆通过其记忆工具访问，不读取用户个人 Codex 的 .codex/memories、会话、附件或凭据目录。
- 项目规则中的 python3 由客户端映射到已准备好的 Python。运行脚本仍单独调用 python3 脚本.py；不要依赖 Windows 的应用商店别名，不在制作途中安装解释器或升级工具。
- 配音本来由多个原始 TTS 段拼接时，保留原始 WAV、每段实际朗读文本、摘要和精确采样起止；不要为对齐重新切分已确认配音，也不要按字幕行拆开重新配音。使用 FunASR 时，可将这些已有来源一次写为 align_run() 的 segments_manifest 清单：schema=1、audio_sha256、script_sha256、sample_rate、segments；每段包含项目内 audio 相对路径、sha256、text、start_sample、end_sample_exclusive。audio 指向未重采样的原始 PCM16 拼接配音。工具会先逐样本验证「原段与零静音间隔」完整覆盖配音，再只初始化一次模型、逐段对齐并按实际采样偏移合并，最后检查完整音频；不要逐段分别启动模型。该路径须文字匹配100%、没有插值、独立音频校验通过。清单不完整、混音、重采样或变速后的音频不满足逐样本验证时保留诊断，不能伪造采样边界。若规范 voice.wav 是已批准的重采样试听副本，再对它做一次独立 audio_check；不覆盖已确认音频。
- 查询可能已退出的进程时用 Get-Process -Id 进程号 -ErrorAction SilentlyContinue；查不到即记录已结束，不把它当成新的工具故障，不结束其他进程。优先读取原任务的退出码和错误日志。
- 获取公开作品页、JSON、音频、ZIP 用 source_download()，不要混用 Windows curl 的 Schannel、Node REPL fetch 和临时下载脚本。下载工具保留 TLS 证书校验，使用系统代理，返回底层原因；不关闭证书验证或沙箱。
- source_download({"url":"https://example.org/work.html","output":"production/sources/work.html","kind":"html"}) 会提示页面中的公开 JSON 和下载端点。ZIP 下载页和返回下载链接的 JSON 会被解析；文件类型、CRC、体积或摘要不匹配时不写成正式素材。
- 动态作品页可能在 JavaScript 中 fetch 一个 JSON。原始 HTML 没有曲名时，先获取公开 JSON 数据，再用 record_field、record_value 和 record_title 核对唯一曲目身份。示例：source_download({"url":"https://example.org/pieces.json","output":"production/sources/pieces.json","kind":"json","record_field":"isrc","record_value":"曲目编号","record_title":"曲名"})。曲目身份检查不等于许可批准，仍须保存该作品的一手许可与署名证据。
- 下载到来源收件目录后，先核对类型、条目和许可，再提取、转换或混音。重复调用同一 URL 和文件可核对摘要后复用；遇到其他已有文件保持原样。不要在脚本失败后重复覆盖配音、素材、批准记录或已完成镜头。
- Windows 的 validate_reads 会核对已批准的第零帧封面文字例外，照常检查阅读时长；无文字的 decorative / graphic 元素使用自身存在区间，不伪造可读区间。不得把可读标题或语义文字改标为装饰来逃避校验，也不要靠删掉待检查文字获得“全片通过”。
- 同时渲染设置是上限。jobs 留空以读取用户当前配置，不把之前的 3 或某次实际运行数量写死；单个 scene_run() 不会自动生成并发。批量任务运行时可并行做来源核验和发布草稿等独立工作。共享素材与确认后的上游输入先准备并冻结。仅当旧版工具没有 priority_scenes 时才按原有代表镜头检查关卡再提交其余镜头。
- 分镜已批准、输入已冻结，且当前 scene_run_all 已声明 priority_scenes 时，将全部待制作镜头一次入队，通过 priority_scenes 优先派发代表镜头（例如 scene-001、scene-004、scene-009）；一个名额释放即由队列补入下一镜头，不在模型层等待 1、4、9 全部结束才提交其余镜头。已经在独立任务运行的镜头不可被另一批重复派发。已有合格镜头照常跳过，过期镜头保留原有显式重做规则；未批准或存在依赖的输入先完成关卡，不提前派发。
- 可见事件的 phrase_id 是单个短语 ID 字符串（无绑定时为 null），不能写成数组。组合元素的多个来源 ID 保留在 source_phrase_ids，不把列表直接用作 Python 字典键；生成归一化脚本时先检查 isinstance(value, str/list)，类型不明一次报告具体文件与 selector 后停止。真实多概念标题应由实际语义时间约束共同核对，不随意取第一个 ID、不猜时间重绑，也不改成装饰逃过检查。保留现有清单、批准和帧号，归一化输出写入复查候选。
