// 宿主核心渲染技能（hyperframes、hyperframes-cli、scene-kit）与可选技能的提示词片段。
import path from 'node:path';
import * as hyperframes from '../hyperframes';
import { SceneDataFile } from './scenedata';
import {
  HyperFramesCLISkillName,
  HyperFramesSkillName,
  hyperFramesFormatFile,
  hyperFramesMotionFile,
  hyperFramesRuntimesFile,
  SceneKitSkillName,
  type SkillDescriptor,
  SkillManifestFile,
  sceneKitLibraryFile,
} from './skills_constants';

/**
 * 为所有已注册技能生成提示词片段。
 * 已解析的技能注入本机路径；未解析的退回按技能名引用。
 * v6：把重型可选技能（character-rig / text-to-lottie / algorithmic-art）从默认前缀收窄为极简按需提示，
 * 不暴露目录路径以免 stagedSkills 把未用到的技能全部软链进每一个简单镜头；真需要时由 optionalSkillTail 在单镜动态段补入路径。
 */
const optionalV6Skills: ReadonlySet<string> = new Set(['character-rig', 'text-to-lottie', 'algorithmic-art']);

export function skillPromptSections(
  resolved: Record<string, string>,
  skills: readonly SkillDescriptor[],
  engineRenders = false,
  directorBrief = false,
  v5 = false,
  v6 = false,
  v8 = false,
): string {
  let sections = '';
  for (const desc of skills) {
    if (v6 && optionalV6Skills.has(desc.name)) continue;
    const dir = resolved[desc.name] ?? '';
    if (directorBrief && desc.name === HyperFramesSkillName) sections += hyperFramesPrompt(dir, true);
    else if (directorBrief && desc.name === SceneKitSkillName) sections += sceneKitPrompt(dir, true, v8);
    else if (engineRenders && desc.name === HyperFramesCLISkillName)
      sections += hyperFramesCLIPrompt(dir, true, v5, v8);
    else if (desc.promptSection) sections += desc.promptSection(dir);
  }
  if (v6) {
    sections +=
      '可选视觉技能（按需）：默认用纯 HTML/CSS/SVG/GSAP 实现，不加载未用到的技能；' +
      '默认不用 Lottie（文字、数字、图表、转场严禁用 Lottie）；仅当本镜任务书或扩展块明确要求角色、Lottie 或算法艺术时，按文末给出的技能路径按需读取。\n';
  }
  return sections;
}

/** v6 单镜动态尾段：仅当本镜头确实需要某项重型可选技能时才注入它的完整段落与路径（并触发 stagedSkills 挂载）。 */
export function optionalSkillTail(
  resolved: Record<string, string>,
  skills: readonly SkillDescriptor[],
  hasCast: boolean,
  body: string,
): string {
  const lower = body.toLowerCase();
  const wanted = new Set<string>();
  if (hasCast) wanted.add('character-rig');
  if (/\blottie\b/.test(lower)) wanted.add('text-to-lottie');
  if (/\balgorithmic[- ]?art\b|生成式艺术|算法艺术|oklab/.test(lower)) wanted.add('algorithmic-art');
  if (wanted.size === 0) return '';
  let out = '';
  for (const desc of skills) {
    if (!wanted.has(desc.name) || !desc.promptSection) continue;
    out += '\n' + desc.promptSection(resolved[desc.name] ?? '');
  }
  return out;
}

/**
 * 渲染器调用 CLI 的写法（onset 管理的固定版本 CLI，见 hyperframes.requireCLI，由 onset setup 装好）。
 * 提示词里教的写法与安全模式放行的命令必须是同一个字符串：
 * 以前只有放行列表里有前缀，提示词不提，渲染器写成不带版本的 `npx hyperframes`，
 * 整场渲染的 lint、check、render 全被拦下（实测，无产物）。
 */
export function hyperFramesCommand(): string {
  return hyperframes.CLICommand;
}

/**
 * 上游入口技能的提示词片段：组合契约加动效手法。
 *
 * 0.8.185 起上游把 hyperframes-animation / hyperframes-core / hyperframes-creative
 * 并进了入口技能 hyperframes，原子 rule 索引（rules-index.md）与蓝图索引随之消失，
 * 组合契约落在 SKILL.md 的 Contract 一节与 references/format.md，动效手法落在
 * references/motion.md。所以这里只点名那几份文件，而不是让渲染器「加载技能」。
 *
 * 收窄范围是这一段的主要工作。入口技能的职责是整片制作：故事线三选一、SPEC.md、
 * 分镜、配乐音效、预览审批、桌面应用交接与 REVIEW.md。分镜、旁白和节拍由上层决定
 * 并已写进 scene.json，渲染器照那套走会产出计划文件、给镜头配乐（产物必须无音轨），
 * 还会停在「等人审批预览」。references/look.md 要求把项目根的 frame.md 当成配色与
 * 字体规范，与「视觉自由度」一段正面冲突，必须点名覆盖；format.md 允许用
 * local() 引用本机字体，换一台机器结果就不同，也要点名禁止。这些禁令上游不会替我们守，
 * skills.test.ts 有对应的门禁。
 *
 * 动效部分刻意不设数量配额（几种手法、几个属性）。配额是可以逐项打勾的指标，
 * 渲染器会为了达标加一个与文案无关的 rotation 或 clip-path；动效数量由文案决定，
 * 这里只要求每个动效说得出理由。环境动效不设项目级配额；只要不影响阅读和确定性，
 * 就由镜头根据文案决定，语义元素仍应在到位后稳定停留。
 */
export function hyperFramesPrompt(skillsDir: string, brief = false): string {
  const files = `SKILL.md 的 Contract 一节、${hyperFramesFormatFile} 与 ${hyperFramesMotionFile}；用到 GSAP 以外的运行时（Lottie、Three.js、canvas 等）再读 ${hyperFramesRuntimesFile}`;
  let reference =
    `- 写组合 HTML 前必须读 ${HyperFramesSkillName} 技能的 ${files}。\n` +
    '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n';
  if (skillsDir !== '') {
    reference = `- 写组合 HTML 前必须读 ${HyperFramesSkillName} 技能的 ${files}。本机该技能目录为：\n    ${path.join(skillsDir, HyperFramesSkillName)}\n`;
  }
  if (brief) {
    const location = skillsDir ? `（${path.join(skillsDir, HyperFramesSkillName)}）` : '';
    reference =
      '- 开工摘要已经给出常用组合契约，可以直接实现；遇到特殊运行时、子组合、媒体或格式疑问，再查技能 ' +
      `${HyperFramesSkillName}${location} 的 Contract、${hyperFramesFormatFile}、${hyperFramesMotionFile} 或 ${hyperFramesRuntimesFile} 对应小节。\n` +
      '- index.html 的根节点声明 data-composition-id、data-start="0"、data-duration、data-width、data-height，画幅和时长取上文。整个合成建好后注册一个暂停的 GSAP 时间线到 window.__timelines[合成 ID]。\n' +
      '- 有时间区间的元素用 class="clip"、data-start 和 data-duration（本组合内的秒），显示区间左闭右开。data-track-index 只表示轨道，靠 z-index 排叠层。入退场动画放在 clip 的子层，不对 clip 本身 tween display、visibility 或 autoAlpha。\n' +
      '- 动画任意帧都可独立求值，GSAP 控制的元素避免同时写 CSS transform，画面状态以帧号驱动。媒体只用相对资产路径，视频静音并由时间线控制。背景用全幅子层。\n';
  }
  return (
    '组合规范（强制）：\n' +
    reference +
    '  重点是 data-* 时间属性、class="clip"、子组合结构与确定性渲染规则。\n' +
    '- 该技能是整片制作的入口，本镜头只取其中的组合契约与动效手法。本镜头只产出一个 composition：' +
    '不建子项目，不写 STORYBOARD.md / SCRIPT.md / SPEC.md / REVIEW.md 这类计划或复查文件，' +
    '不走它的 Work loop、故事线选择、预览审批与桌面应用交接——分镜、旁白与节拍已由上层决定并写进 scene.json，你只负责这一镜。\n' +
    '- 不读也不照做 references/story.md、spec.md、storyboard.md、storyboard-format.md、sound.md、captions.md、overlays.md、review.md 与 types/ 下的片型文件：' +
    '配乐与音效由上层统一处理，镜头里不放 <audio>；画内字幕按下方的镜头工具库执行；复查按本提示词的画面自查执行。\n' +
    '- 画幅、帧率与时长以本提示词为准，不用该技能默认的 1920×1080、30fps。' +
    '不搜索、不安装 registry 组件（catalog、add），不调用 media-use 或任何生成媒体的服务。\n' +
    '- 该技能 references/look.md 要求把项目根的 frame.md 当作配色与字体规范，本项目不适用：' +
    '配色与字体按本提示词的「视觉自由度」（有整片风格时是「整片风格」）一段执行；look.md 只读「Video facts」一节，不另立 LOOK 行，不套用 frame-presets。\n' +
    '- 非内置字体一律用 @font-face 指向镜头目录里的字体文件，不得只写 local() 依赖本机安装的字体：换一台机器渲染结果就不同。\n' +
    '\n动效要求（强制）：\n' +
    '- 动效手法以 ' +
    hyperFramesMotionFile +
    ' 为参考：缓动按角色选、快动作带动态模糊、退场短于入场、错峰重叠；' +
    '其中「Defaults that look generated」列出的写法一律不用。它给的停留秒数只是参考，可读停留以本提示词的其他要求为准。\n' +
    '- 导演的是状态变化，不只是入场：每个动画先想清楚它最终停在什么状态、那个状态是否说明了这句台词的论点；' +
    '入场再漂亮，也补不了落定状态说不清的问题。\n' +
    '- 跟随关系要成立：指针落在它要按的控件上，标签跟着它标注的对象走。\n' +
    '- 按文案选手法，不设数量下限：每个动效都要说得出它在表达哪句话、哪层关系或哪个转折，' +
    '说不出理由的不加。宁可少而准，不要为了显得丰富堆叠属性。\n' +
    '- 环境动效可选，整镜最多 1 条，振幅小到不干扰阅读；不得持续漂浮或晃动语义元素。\n' +
    '- 语义元素到位后应当稳定停留供阅读，这段停留允许画面静止；' +
    '镜头结尾停在可读的终态，不得停在入场中间态。\n' +
    '- 但整个画面不得完全冻结超过 3 秒（含结尾）：长停留期间用那条环境动效或极缓的镜头推移维持画面活性，' +
    '语义元素本身保持不动。\n' +
    '- 装饰性动效只能落在装饰层（显式标记 decorative）或语义元素的入场 / 退场窗口内，' +
    '不得侵占任何元素的可读稳定区间，也不得改变已约定的短语帧。\n'
  );
}

/**
 * 指向 CLI 用法，并把可用命令收窄到本地渲染与检查。
 *
 * 上游该技能按「工作」列出全部命令，其中三类必须挡掉：
 *   - cloud / cloudrun / lambda / publish 把镜头送去远端，绕开本机的确定性前提；
 *   - skills / upgrade 会顶掉 onset 固定的技能与 CLI 版本，影响同项目其他镜头；
 *   - preview / open / catch-up / history / feedback / usage 是交互、桌面应用、
 *     遥测与额度查询，无头单镜头渲染里要么卡住等人，要么往外发数据。
 *
 * timeline 只放行读取：它的 move / trim / split 等子命令会改写组合文件，
 * 与「时长由 scene.json 决定」的契约冲突。
 */
export function hyperFramesCLIPrompt(skillsDir: string, engineRenders = false, v5 = false, v8 = false): string {
  let reference =
    `- CLI 的命令与排错方式见 ${HyperFramesCLISkillName} 技能。\n` +
    '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n';
  if (skillsDir !== '') {
    reference = `- CLI 的命令与排错方式见 ${HyperFramesCLISkillName} 技能。本机该技能目录为：\n    ${path.join(skillsDir, HyperFramesCLISkillName)}\n`;
  }
  return (
    '渲染命令（强制）：\n' +
    reference +
    (v8
      ? '- 检查与视觉验收一律优先用 `scene_preview_check`（支持 `frames` 拼联系表，`zoom_frames` 一次批量拼多帧高分细节图，也支持 `zoom_frame` / `crop` 查单帧原分辨率或局部细节，内置缓存并直接回图）；不要单独重复调用 `hyperframes` 的 `lint`、`check`、`snapshot`。仅在查文档或排查组合元数据时用 `hyperframes` 工具（`subcommand` 填子命令，其他参数放进 `args`）。正式渲染由片场执行。'
      : v5
        ? '- 检查与视觉验收一律优先用 `scene_preview_check`（支持 `frames` 拼联系表，也支持 `zoom_frame` / `crop` 查单帧原分辨率或局部细节，内置缓存并直接回图）；不要单独重复调用 `hyperframes` 的 `lint`、`check`、`snapshot`。仅在查文档或排查组合元数据时用 `hyperframes` 工具（`subcommand` 填子命令，其他参数放进 `args`）。正式渲染由片场执行。'
        : engineRenders
          ? '- 首轮检查用 scene_preview_check。按需补查时用 `hyperframes` 工具，`subcommand` 填子命令，其他参数放进 `args`。正式渲染由片场执行。'
          : '- HyperFrames CLI 只经 onset 工具服务里的 `hyperframes` 工具调用：`subcommand` 填子命令，其余参数照命令行写法放进 `args`。' +
            '例如检查是 `{"subcommand": "lint"}`、`{"subcommand": "check", "args": ["--json"]}`，渲染是 `{"subcommand": "render"}`。') +
    '技能里写成 `npx hyperframes <子命令>` 或 `hyperframes <子命令>` 的命令，一律照此换成工具调用。\n' +
    '- 不在 Bash 里跑 hyperframes、npx hyperframes 或 onset：它们不在本环境里，也不被放行。固定版本 ' +
    hyperframes.PinnedVersion +
    ' 的 CLI 已经装好，工具就在本镜头目录里执行，不需要 cd。\n' +
    (engineRenders
      ? '- 预览任务返回任务号时，用 `job_wait` 等结果，无需重复请求。\n'
      : '- 渲染要几分钟：工具最多等 `wait_seconds` 秒（缺省 50），没跑完会返回任务号，用 `job_wait` 接着等到完成；不要重复发起同一次渲染。\n') +
    (v5
      ? '- 仅在需要查文档或元数据时用本机只读命令：docs、inspect、validate、keyframes、只读的 timeline --json、compositions、info。'
      : engineRenders
        ? '- 需要单项补查时只用本机命令：lint、check、validate、inspect、snapshot、keyframes、只读的 timeline --json、compositions、info、docs。'
        : '- 只放行本机渲染与检查：lint、check、validate、inspect、snapshot、keyframes、render、只读的 timeline --json、compositions、info、docs。') +
    'snapshot 会自动带上 --describe false（不把画面发给外部视觉服务），本镜头的自查由你自己看图完成。\n' +
    '- 远端渲染（cloud、cloudrun、lambda、publish）、改动已装技能（skills、upgrade）、交互与遥测（preview、present、open、catch-up、history、feedback、usage）都不放行：' +
    '本镜头必须在本机无头渲染，版本已固定，也没有人审批预览。\n'
  );
}

/**
 * 按帧驱动工具库的提示词片段，解析到就总是注入。
 *
 * 这个库存在的理由是让各镜头不再各写各的：字幕位置、字号、断行每镜不同，
 * frame.md 的字幕规范没有任何共用代码去执行。所以措辞必须把「烧录字幕一律
 * 用 SceneKit.captions」「版式用 safeRect 而不是手抄像素」写成要求而不是建议，
 * 否则渲染器照旧手写一套，库就白装了。
 *
 * 复制义务与 character-rig 同理：渲染只服务镜头目录内的文件，引用镜头目录外的
 * 路径会静默 404，字幕不出现、渲染照样退出码 0。
 */
export function sceneKitPrompt(skillsDir: string, brief = false, v8 = false): string {
  let reference =
    `- 加载 ${SceneKitSkillName} 技能，用法以其中的 ${SkillManifestFile} 为准。\n` +
    '  （本机未能定位该技能目录，请使用你自身的技能加载机制载入。）\n';
  if (skillsDir !== '') {
    reference = `- 加载 ${SceneKitSkillName} 技能，用法以其中的 ${SkillManifestFile} 为准。本机该技能目录为：\n    ${path.join(skillsDir, SceneKitSkillName)}\n`;
  }
  if (brief && v8) {
    const location = skillsDir
      ? path.join(skillsDir, SceneKitSkillName, SkillManifestFile)
      : `${SceneKitSkillName}/${SkillManifestFile}`;
    reference =
      `- window.SceneKit 完整接口速查（直接调用，无需 read_file 通读 scene-kit.js 或 ${location}）：\n` +
      '  - 驱动与元数据：`attach(timeline, frame => ...)`、`scene()`（返回 window.ONSET_SCENE）、`frameOf(sec)`。\n' +
      '  - 数学与缓动：`clamp(v,lo,hi)`、`lerp(a,b,t)`、`progress(frame,start,end)`、`fade(frame,inS,inE,outS?,outE?)`、`ease(name,t?)`（linear/sine/quad/cubic/expo/back + In/Out/InOut）、`rng(seed)`。\n' +
      '  - 安全区/短语/字幕：`safeRect(name?)`（main_content/subtitles → `{left,top,right,bottom,width,height}`）、`phrase(id)`、`phraseActive(id,frame)`、`phraseText(id,el,opts?)`、`cueAt(frame)`、`breakLines(text,opts)`、`captions(container,opts?)`（返回 `{element,layouts,render(frame),activeAt(frame),events()}`）。\n';
  } else if (brief) {
    const location = skillsDir
      ? path.join(skillsDir, SceneKitSkillName, SkillManifestFile)
      : `${SceneKitSkillName}/${SkillManifestFile}`;
    reference = `- 直接用 SceneKit.attach(timeline, render) 把按帧更新接到暂停时间线上。SceneKit.progress(frame, start, end) 返回 0–1，SceneKit.ease(name) 取得缓动函数。需要其他接口时查 ${location}。\n`;
  }
  return (
    '镜头工具库（强制）：\n' +
    reference +
    (brief ? '- 优先引用镜头目录里已准备好的 ' : '- 用到它时把技能目录里的 ') +
    sceneKitLibraryFile +
    (brief
      ? '；若未准备，按技能教材接入。用相对路径引入。\n'
      : ' 复制进本镜头目录，用相对路径引入；不得引用镜头目录之外的文件。\n') +
    '- 先加载镜头目录里的 ' +
    SceneDataFile +
    '（由上层在渲染前写好，不要自己写或改），再加载 ' +
    sceneKitLibraryFile +
    '。\n' +
    '- 画面内烧录的字幕一律用 SceneKit.captions，不得手写字幕代码；位置、字号、断行与样式由本镜头决定，但必须保持可读。\n' +
    '- 版式按安全区取值用 SceneKit.safeRect，不要把安全区像素手抄进合成；短语时间窗用 SceneKit.phrase。\n'
  );
}
