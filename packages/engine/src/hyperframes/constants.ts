// 移植自 internal/hyperframes/hyperframes.go 的常量部分（单独成文件，免得 manifest 与安装逻辑循环导入）。

/** 技能在项目里的落点，与 scene.portableSkillsDir 一致。 */
export const SkillsSubdir = '.agents/skills';

/**
 * am init 安装的 HyperFrames 上游版本。
 *
 * 固定版本不自动前进是刻意的：技能内容变化会直接改变成片动效。升级前要对比
 * 两版 skills/ 树与自动内联字体清单（CANONICAL_FONTS），确认 scene
 * 注册的技能与提示词点名的参考文件都还在、字体清单没变，并同步
 * validate 的 autoEmbeddedFonts 注释。
 *
 * 0.8.14 → 0.8.225 是一次结构性升级：0.8.185 起上游把 hyperframes-animation、
 * hyperframes-core、hyperframes-creative 等技能并进入口技能 hyperframes，原子
 * rule 索引随之消失，scene 的注册与提示词片段因此重写过一遍。
 *
 * ⚠️ 这个版本号固定的是 CLI 二进制，不是技能内容：上游 `hyperframes skills`
 * 直接 git clone 仓库默认分支取 skills/，安装器没有任何指定 ref 的口子。
 * 实测 0.8.1 与 0.8.14 装出来的 26 个技能逐字节相同，且都等于当天 main 的
 * 状态——所以两次 am init 之间技能可能已经变了，与这里的版本号无关。
 * 详见 README「HyperFrames 版本固定的边界」。
 *
 * 这里是唯一来源：命令行、错误信息、--help 与下发提示词里的锁定指令都从它
 * 取值（提示词经 preset/gen 的 {{HYPERFRAMES_VERSION}} 占位符注入，
 * 由根目录 assets_test.go 的 TestPresetsPinSameHyperFramesVersionAsBinary 守住）。
 */
export const PinnedVersion = '0.8.225';

/** 上游技能的来源仓库。 */
export const SkillsRepoURL = 'https://github.com/heygen-com/hyperframes.git';

/**
 * v<PinnedVersion> 这个 tag 指向的 commit。
 *
 * 只钉 tag 不够：tag 可以被 force-push 移动，移动之后按 tag 克隆会静默拿到
 * 另一份技能而版本号一个字没变。解析出的 commit 与这里对不上就拒装。
 */
export const PinnedSkillsCommit = 'b687d062353f2dd43a9a4b8b77aafeb1077b3875';

/**
 * 该 commit 上应当拼装出的技能数。
 *
 * 技能来自 skills/ 与 .agents/skills/ 两处含 SKILL.md 的目录。上游哪天挪动
 * 目录，这套拼装会静默少装一批——而渲染 agent 找不到技能不会报错，只会自己
 * 发明一套多半不挂在 paused timeline 上的写法。数量对不上就拒装，顺带让
 * 「升版本时顺手核对一遍」这件事自己会响。
 */
export const PinnedSkillsCount = 14;

/**
 * 上游仓库里存放技能的两个位置（以 / 分隔）。
 *
 * 实测依据：0.8.14 时按这两处筛出含 SKILL.md 的目录（20 + 6），与上游安装器
 * `hyperframes skills` 在同一个 commit 上的产出逐字节相同；0.8.225 上是 8 + 6。
 */
export const skillsSubdirsInRepo = ['skills', SkillsSubdir];

/** 判定一个目录是不是技能的依据，与 scene 包一致。 */
export const manifestFile = 'SKILL.md';
