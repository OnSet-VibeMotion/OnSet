/**
 * 双跑对照的用例。每个用例：
 *   name      名字（命令行可按子串过滤）
 *   setup     用 Go 版 am 建样例项目的步骤（在空目录里依次执行）
 *   prepare   可选：建好后再手工写入的文件（函数，参数是项目目录）
 *   commands  要两边各跑一遍、逐字节比对的命令
 *   ignore    可选：不参与文件比对的路径（正则，相对项目根），例如带时间戳的日志
 *
 * 只收确定性的命令：输出里不带当前时间、随机数，不调用外部 AI CLI。
 * 随移植进度逐步补充；每移植一组命令就在这里加上它们的用例。
 */
export const cases = [
  {
    name: 'help',
    commands: [['--help'], ['scene', '--help'], ['memory', '--help'], ['validate', '--help']],
  },
];
