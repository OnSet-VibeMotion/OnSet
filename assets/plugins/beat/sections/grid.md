### 音乐与节拍网格

节拍分析环境（beat-this 与 torch 的 Python 环境）是前置资源，由用户在客户端的工具准备页（首页的「召集你的摄制组」，或顶栏的「还差几项工具」）里安装（「以后可能用到」里的「音乐卡点」），所有卡点项目共用。不要自己建 Python 环境、不要 pip install，也不要在 beat.yaml 里写 python 指向别的环境；`beat_analyze()` 报缺少前置资源时，请用户去装，装好后再继续。

1. `beat_import({"music": "<音乐文件>"})` 导入音乐，`beat_analyze()` 分析出草稿网格。
2. 运行 `studio_show({"page": "beat", "note": "请试听节拍"})`，让用户在节拍页试听：每拍一声、重拍更高。重拍整体错位或拍号判错时用 `beat_regrid()` 重排，零星错误按用户指出的小节修正草稿后 `beat_click()` 重做试听轨。
3. 只有用户确认后才运行 `beat_confirm()`。不得替用户确认。

