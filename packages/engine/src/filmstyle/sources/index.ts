// 移植自 internal/filmstyle/sources：把全部整片风格来源登记进 filmstyle。来源在各自模块
// 加载时 register，这里集中 import 它们。用到风格来源的地方（am 命令、Studio、前置资源清单）
// import 这个模块即可；新增来源只在这里加一行。
import '../lemo';

export {};
