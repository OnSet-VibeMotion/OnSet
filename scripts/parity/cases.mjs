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
    name: 'setup',
    commands: [['setup', '--help'], ['setup', '--check'], ['setup', '--check', '--only', 'cli'], ['setup', '--only', 'nope'], ['setup', 'extra']],
  },
  {
    name: 'film-style outside a project',
    commands: [['film-style', '--help'], ['film-style', 'list'], ['film-style', 'list', '--json'], ['film-style', 'list', '--source', 'nope'], ['film-style', 'show']],
  },
  {
    name: 'film-style in a project',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [['film-style', 'show'], ['film-style', 'show', '--json'], ['film-style', 'remove'], ['film-style', 'use', 'no-such-style'], ['film-style', 'use']],
  },
  {
    name: 'hyperframes help',
    commands: [['hyperframes', '--version']],
  },
  {
    name: 'init variants',
    commands: [
      ['init', '--help'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'vertical-9x16', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'landscape-16x9', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--narration', 'cast'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'beat'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--style', 'pixel-arcade-v1'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--style', 'custom', '--style-brief', '暖色胶片，手写标注'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--film-style', 'lemo-opuscar/impasto'],
      ['init', 'p', '--canvas', 'vertical-3x4'],
      ['init', 'p', '--canvas', 'square-1x1', '--skip-hyperframes'],
      ['init', 'p', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--delivery', 'beat', '--narration', 'cast'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--style', 'pixel-arcade-v1', '--style-brief', 'x'],
      ['init', 'a', 'b'],
    ],
    ignore: [/am-film-style\.json$/],
  },
  {
    name: 'config',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [['config', '--help'], ['config', 'get', '--help'], ['config', 'get', 'RENDERER'], ['config', 'get', 'ORCHESTRATOR'], ['config', 'get', 'TTS_PROVIDER'], ['config', 'get', 'ALIGN_PROVIDER'], ['config', 'get', 'NOPE'], ['config', 'get']],
  },
  {
    name: 'archive',
    commands: [['archive', '--help'], ['archive', '--dry-run'], ['archive', 'x']],
  },
];
