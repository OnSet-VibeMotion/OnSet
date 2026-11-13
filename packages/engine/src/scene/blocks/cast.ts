// 多角色对话的镜头块：scene.json 的 cast 字段。移植自 internal/scene/scene.go 的 cast 部分。
import path from 'node:path';
import * as cast from '../../cast';
import { formatFixed, formatG, goQuote } from '../../gofmt';
import { registerBlock } from '../block';
import { formatStrings } from '../gofmt';
import { sliceOf, type StructType } from '../jsondecode';
import { digestTree } from '../record';
import { contained, type Scene } from '../scene';
import { CastRequiredHeading, CharacterRigSkillName, castDriverFile } from '../skills';

declare module '../scene' {
  interface Scene {
    /** 可选的角色配置。老镜头没有这个字段，cast 为 null，行为完全不变。 */
    cast: Cast | null;
  }
}

/**
 * floatEps 是浮点边界比较的容差：JSON 里的 0.78、9 之类的数经过反复运算
 * 后可能带一点浮点误差，严格 < / > 会把本该合法的边界值判成非法。
 */
const floatEps = 1e-9;

/**
 * BeatOverlapToleranceSeconds 是判定相邻两拍是否重叠时用的容差，导出给
 * castbeats 复用。
 *
 * 那个包在切分 dialogue.json、写 cast.beats 之前会自己做一次重叠守卫；
 * 如果那道守卫比这里更松，一段重叠量正好落在两者之间的输入就会在那边被
 * 放行、切出的节拍写进 scene.json 之后又在这里被拒——命令退出码是 0，
 * 产物却过不了校验，重跑也不会自愈（详见 2026-08-24 多角色叙事 spec
 * 的"跨模块容差错配"记录）。两边共用同一个值，让"上游放行"直接蕴含
 * "下游一定放行"，不再靠两个常量凑巧一致维持。
 *
 * 值与 floatEps 相同，但单独导出一个名字：floatEps 还覆盖 x / ground_y
 * 边界、beat 时长边界等其他用途，那些用途不需要跨包保持同步，混在一个
 * 跨包契约里反而让"改哪个值会影响谁"变得不清楚。
 */
export const BeatOverlapToleranceSeconds = floatEps;

/** 镜头的角色配置。老镜头没有这个字段，Scene.cast 为 null。 */
export interface Cast {
  pack_dir: string;
  ground_y: number;
  on_stage: Actor[] | null;
  beats: Beat[] | null;
}

/**
 * 台上的一个角色。x 与 ground_y 都是画面归一化比例而不是像素：
 * 同一份镜头描述在 1080×1440 与 1080×1920 下都成立。
 */
export interface Actor {
  id: string;
  x: number;
  pose: string;
  facing: string;
  /**
   * 初始视图，可省略，缺省为 cast.DefaultView。
   * 镜头内的转身由渲染 agent 在 composition 里调 turn() 表达，不写进 scene.json——
   * scene.json 描述的是初始状态与台词节拍，不是逐拍动作脚本。
   */
  view: string;
}

/** 一拍的时间已是镜头本地时间，由拆镜头时从 dialogue.json 切片并减去镜头起点。 */
export interface Beat {
  speaker: string;
  start: number;
  end: number;
}

const actorType: StructType = {
  kind: 'struct',
  goName: 'scene.Actor',
  name: 'Actor',
  fields: [
    ['id', 'string'],
    ['x', 'float'],
    ['pose', 'string'],
    ['facing', 'string'],
    ['view', 'string'],
  ],
};

const beatType: StructType = {
  kind: 'struct',
  goName: 'scene.Beat',
  name: 'Beat',
  fields: [
    ['speaker', 'string'],
    ['start', 'float'],
    ['end', 'float'],
  ],
};

export const castType: StructType = {
  kind: 'struct',
  goName: 'scene.Cast',
  name: 'Cast',
  fields: [
    ['pack_dir', 'string'],
    ['ground_y', 'float'],
    ['on_stage', sliceOf(actorType)],
    ['beats', sliceOf(beatType)],
  ],
};

/** 按 Go 的字段顺序构造 Cast 的 JSON 值。 */
export function castToJSON(c: Cast): unknown {
  return {
    pack_dir: c.pack_dir,
    ground_y: c.ground_y,
    on_stage: c.on_stage ? c.on_stage.map((a) => ({ id: a.id, x: a.x, pose: a.pose, facing: a.facing, view: a.view || undefined })) : null,
    beats: c.beats ? c.beats.map((b) => ({ speaker: b.speaker, start: b.start, end: b.end })) : null,
  };
}

/**
 * 校验镜头的 cast 块。cast 是可选字段：没有它的老镜头（cast === null）直接放行，
 * 行为与引入这块之前完全一致。
 */
export function validateCast(s: Scene): void {
  const c = s.cast;
  if (c === null) return;
  const packDir = contained(s.directory, c.pack_dir, 'cast.pack_dir');
  if (!Number.isFinite(c.ground_y) || c.ground_y <= 0 || c.ground_y >= 1) {
    throw new Error(`cast.ground_y 必须在 (0,1) 区间内，收到 ${formatG(c.ground_y)}`);
  }
  const onStage = new Set<string>();
  for (const actor of c.on_stage ?? []) {
    if (actor.id === '') throw new Error('cast.on_stage 中存在缺少 id 的角色');
    if (onStage.has(actor.id)) throw new Error(`cast.on_stage 中角色 id 重复：${actor.id}`);
    if (!Number.isFinite(actor.x) || actor.x <= 0 || actor.x >= 1) {
      throw new Error(`角色 ${actor.id} 的 x 必须在 (0,1) 区间内，收到 ${formatG(actor.x)}`);
    }
    if (actor.facing !== 'left' && actor.facing !== 'right') {
      throw new Error(`角色 ${actor.id} 的 facing 必须是 left 或 right，收到 ${goQuote(actor.facing)}`);
    }
    const actorDir = contained(packDir, actor.id, `cast.on_stage 中角色 ${actor.id} 的 id`);
    let pack: cast.Pack;
    try {
      pack = cast.load(actorDir);
    } catch (err) {
      throw new Error(`角色 ${actor.id} 的角色包加载失败：${(err as Error).message}`, { cause: err });
    }
    if (!pack.poses || !Object.hasOwn(pack.poses, actor.pose)) {
      throw new Error(`角色 ${actor.id} 的 pose ${goQuote(actor.pose)} 不在角色包的姿势列表中`);
    }
    if (actor.view !== '') {
      const names = cast.viewNames(pack);
      if (!names.includes(actor.view)) {
        throw new Error(`角色 ${actor.id} 的 view ${goQuote(actor.view)} 不在角色包声明的视图内：${formatStrings(names)}`);
      }
    }
    // on_stage 已在上面判过重复，此处登记用于校验 beats.speaker。
    onStage.add(actor.id);
  }
  // voiceOver 缓存已经确认过角色包存在的画外音说话人，避免同一个人多拍
  // 时把 cast.load 重复跑一遍。
  const voiceOver = new Set<string>();
  let prevEnd = -Infinity;
  let prevIndex = -1;
  const beats = c.beats ?? [];
  beats.forEach((b, i) => {
    if (b.speaker === '') throw new Error(`cast.beats[${i}] 缺少 speaker`);
    if (!Number.isFinite(b.start) || !Number.isFinite(b.end) || b.start >= b.end) {
      throw new Error(`cast.beats[${i}] 的 start 必须小于 end，收到 start=${formatG(b.start)} end=${formatG(b.end)}`);
    }
    if (b.start < -floatEps || b.end > s.duration_seconds + floatEps) {
      throw new Error(`cast.beats[${i}] 超出镜头时长 ${formatFixed(s.duration_seconds, 3)} 秒：[${formatG(b.start)}, ${formatG(b.end)}]`);
    }
    // 一拍的含义是「这段时间这个人在说话」，不蕴含「他可见」：说话人不在
    // on_stage 里就是画外音，合法。纯转场 / 纯 B-roll / 纯图表镜头如果有台词
    // 盖过，就是这种写法——on_stage 可以为空，beats 照填。
    //
    // 但不放开成任意字符串：画外音说话人同样要能在 pack_dir 下找到角色包，
    // 走的是与 on_stage 角色完全相同的 contained + cast.load 路径。否则一个
    // 拼错的名字既不会在这里被拦下，也不会在渲染时被发现（画外音本来就不
    // 出现在画面里），只会让 am validate cast 那边的台词覆盖对不上。
    if (!onStage.has(b.speaker) && !voiceOver.has(b.speaker)) {
      const actorDir = contained(packDir, b.speaker, `cast.beats[${i}] 的画外音 speaker ${b.speaker}`);
      try {
        cast.load(actorDir);
      } catch (err) {
        throw new Error(
          `cast.beats[${i}] 的 speaker ${goQuote(b.speaker)} 既不在 on_stage 里，` +
            `也在 ${c.pack_dir} 下找不到对应角色包：画外音的说话人同样必须是已登记的角色（${(err as Error).message}）`,
          { cause: err },
        );
      }
      voiceOver.add(b.speaker);
    }
    // 乱序（后一拍 start 早于前一拍 start）与重叠（后一拍 start 没有早于
    // 前一拍 start，但仍落进前一拍 [start,end) 区间）分两条错误信息报出：
    // 对作者来说这是两类不同的错误——前者是拍的声明顺序整体倒退，后者是
    // 顺序没错但时间段首尾相接得不够干净——分开说更好改。用前一拍的 start
    // 而不是笼统的"是否重叠"来判断走哪条分支，是因为只要 start 没有倒退，
    // 不管区间怎么交叠都只是同一种"时间没让够"的问题。
    if (b.start < prevEnd - BeatOverlapToleranceSeconds) {
      const prev = beats[prevIndex];
      if (b.start < prev.start - BeatOverlapToleranceSeconds) {
        throw new Error(
          `cast.beats 未按 start 递增排列：第 ${i} 拍 start=${formatG(b.start)} 早于第 ${prevIndex} 拍 start=${formatG(prev.start)}`,
        );
      }
      throw new Error(
        `cast.beats 第 ${i} 拍与第 ${prevIndex} 拍时间重叠：[${formatG(b.start)}, ${formatG(b.end)}] 与 [${formatG(prev.start)}, ${formatG(prev.end)}]`,
      );
    }
    prevEnd = b.end;
    prevIndex = i;
  });
}

/**
 * castSection 拼装 buildPrompt 里的角色契约段，与上面的 style 段同构：
 * 同样的“（强制）”措辞、同样嵌进 prompt 模板的方式、同样的中文语气。
 * s.cast === null 时返回空字符串，提示词里不出现任何 cast 相关内容——
 * 老镜头（没有角色）的提示词必须与引入这块之前逐字节相同。
 *
 * 最后两条约束不是风格建议，是渲染正确性要求：HyperFrames 按任意帧 seek
 * 出帧，没有挂在 cast.js 那条 paused timeline 上的动画在成片里是错的、
 * 但不会报错；首帧空台或停在入场中间态的坑这个项目已经踩过一次。
 *
 * on_stage 为空（纯转场 / 纯 B-roll / 纯图表镜头被台词盖过）时走另一套措辞、
 * 也换一个标题：台上没人，与 rig 有关的那几条约束一条都不适用，而“本镜头有
 * 角色出场”这句话会直接把角色画进图表镜头里；标题继续叫「角色（强制）」还会
 * 让 skillPromptSections 的角色驱动门控误判（详见分支里的说明）。
 */
export function castSection(s: Scene): string {
  const c = s.cast;
  if (c === null) return '';
  const actors = c.on_stage ?? [];
  const beats = c.beats ?? [];
  const onStage = new Set(actors.map((a) => a.id));
  let b = '';
  // noStageNoBeats 是 on_stage 与 beats 都是空数组的退化组合：am dialogue
  // beats 会给"整段完全没有台词覆盖"的纯 B-roll 镜头写出这个组合，
  // 不是坏输入，validateCast 不拒绝它。但下面两段各自的措辞都假设了对方不为空——
  // "台词全部是画外音"蕴含"有台词"，"角色只做反应"蕴含"有角色在台上"——
  // 直接拼起来就是自相矛盾。这个分支单独给一句站得住的话，跳过后面两段互斥的措辞。
  const noStageNoBeats = actors.length === 0 && beats.length === 0;
  if (noStageNoBeats) {
    b +=
      '\n角色（本镜头无角色出场）：本镜头没有台词覆盖、台上也没有角色，' +
      `按纯 B-roll/转场处理；不得把任何角色画进画面，也无需加载 ${CharacterRigSkillName} 技能。\n`;
  } else if (actors.length === 0) {
    // 纯转场 / 纯 B-roll / 纯图表镜头被台词盖过时的形态：有 beats、没有台上
    // 角色。这里绝不能说「本镜头有角色出场」——渲染 agent 会照着把角色画
    // 进图表镜头里。
    //
    // 标题也必须与「角色（强制）」区分开：skillPromptSections 的角色驱动门控
    // 按「下方出现『角色（强制）』段」判断要不要加载 character-rig 技能，
    // character-rig/SKILL.md 里那条「复制义务同时写在提示词的『角色（强制）』
    // 段里」的说法也建立在同一个前提上。空台镜头照用这个标题，等于一边命令
    // 加载技能、一边禁止装载 rig 且刻意省掉驱动库复制条款，提示词自相矛盾。
    b += '\n角色（本镜头无角色出场）：台词全部是画外音；' + `不得把任何角色画进画面，也无需加载 ${CharacterRigSkillName} 技能。\n`;
  } else {
    b += `\n${CastRequiredHeading}：本镜头有角色出场，必须使用 character-rig 技能的 cast.js 驱动。\n`;
  }
  for (const actor of actors) {
    const view = actor.view === '' ? cast.DefaultView : actor.view;
    const dnaPath = `${c.pack_dir}/${actor.id}/dna.md`;
    b += `- 台上：${actor.id}（x=${formatFixed(actor.x, 3)}，初始姿势 ${actor.pose}，朝向 ${actor.facing}，视图 ${view}，角色定义见 ${dnaPath}）\n`;
  }
  if (actors.length > 0) b += `- 地平线：ground_y=${formatFixed(c.ground_y, 3)}（画面高度比例）\n`;
  const lines: string[] = [];
  let hasVoiceOver = false;
  for (const beatItem of beats) {
    let mark = '';
    if (!onStage.has(beatItem.speaker)) {
      mark = '（画外音）';
      hasVoiceOver = true;
    }
    lines.push(`${beatItem.speaker} ${formatFixed(beatItem.start, 3)}–${formatFixed(beatItem.end, 3)}${mark}`);
  }
  if (lines.length === 0) {
    // am dialogue beats 对"有 cast 块、整镜没人说话"的镜头写出空数组，
    // 这是正常产物（角色在台上做反应）。留一个空的"台词节拍："读起来
    // 像节拍算漏了，明说没人说话。
    //
    // noStageNoBeats 时不写这句：台上根本没有角色，"角色只做反应"这句话
    // 本身就不成立，上面的标题已经把情况说清楚了。
    if (!noStageNoBeats) b += '- 台词节拍：本镜头无人说话，角色只做反应，不要表现说话。\n';
  } else {
    b += '- 台词节拍（镜头本地时间，秒）：' + lines.join('，') + '\n';
  }
  if (hasVoiceOver) {
    // 一拍只说明「这段时间这个人在说话」，不说明他可见。标了画外音的说话人
    // 不在 on_stage 里，把他画出来就是多出一个本不该在这个镜头露面的角色。
    b += '- 画外音（强制）：标注「（画外音）」的说话人本镜头不出场，' + '不得把它画进画面，也不得为它装载 rig；那几拍只用来对齐画面节奏。\n';
  }
  if (actors.length === 0) return b;
  // 驱动库必须随镜头目录走，理由与上面 style 段里的字体文件一字不差：
  // 渲染只服务镜头目录内的文件，引用镜头目录之外的路径会静默 404——
  // 角色根本不出现，而渲染照样成功、退出码为 0。
  b +=
    `- 驱动库（强制）：必须把 ${CharacterRigSkillName} 技能目录下的 ${castDriverFile} 复制进本镜头目录，` +
    `并在 composition 里按镜头目录内的相对路径引用（例如 <script src="${castDriverFile}"></script>）。` +
    '不得引用镜头目录之外的路径：渲染只服务镜头目录内的文件，外部路径静默 404，角色不出现且不报错。\n';
  b += '- 所有角色动画必须挂在那条 paused timeline 上；不得给 rig 写 CSS 动画、不得调用 requestAnimationFrame。\n';
  b += '- 第 0 帧必须已是初始姿势的终态，不得留空台或入场中间态。\n';
  return b;
}

registerBlock<Cast>({
  key: 'cast',
  order: 10,
  type: castType,
  toJSON: castToJSON,
  validate: (s) => validateCast(s),
  promptSection: (s) => castSection(s),
  // 角色包是一棵目录：换了姿势图或 dna.md，画出来的角色就不一样了。
  fingerprintParts: (s, c) => {
    let digest: string;
    try {
      digest = digestTree(path.join(s.directory, c.pack_dir));
    } catch (err) {
      throw new Error(`计算角色包摘要：${(err as Error).message}`, { cause: err });
    }
    // 项名与 record 的 file: 项一样用 / 分隔，Windows 上算出的指纹与 macOS 相同。
    return { ['cast:' + c.pack_dir.split(path.sep).join('/')]: digest };
  },
});
