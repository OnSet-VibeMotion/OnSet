// 角色驱动库（character-rig/cast.js）的下发与静态检查、
// cast.js 纯函数的 node 求值、预设提示词固定的 HyperFrames 版本，以及这些静态检查的地基 stripJSComments。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cast from '../cast';
import * as hyperframes from '../hyperframes';
import { CastRequiredHeading } from '../plugins/cast';
import { builtinSkills, files, shared } from './index';

function castSkillPath(name: string): string {
  return '.agents/skills/character-rig/' + name;
}

describe('character-rig skill', () => {
  // 镜头提示词的角色契约段写死了“必须使用 character-rig 技能的 cast.js 驱动”。技能没下发时，
  // 渲染 agent 会自己发明一套动画写法——多半不挂在那条 paused timeline 上，成片是错的而退出码为 0。
  it('builtin skills include character-rig', () => {
    expect(builtinSkills().has('character-rig'), `内置技能缺 character-rig：${[...builtinSkills()]}`).toBe(true);
  });

  // builtinSkills 只看目录名，空目录也算数；提示词里点名的是 cast.js 这个具体文件。
  it('ships the driver and the manifest', () => {
    for (const name of ['SKILL.md', 'cast.js']) {
      expect(shared().exists(castSkillPath(name)), `character-rig 技能缺少 ${name}`).toBe(true);
    }
  });

  // 「角色（强制）」是 castSection 产出、角色驱动门控消费、character-rig/SKILL.md 引用的三处共同契约锚点。
  // SKILL.md 是纯文本，改错不会编译失败，只能靠这条断言把它钉在同一个字面量上。
  it('SKILL.md mentions CastRequiredHeading', () => {
    const body = shared().readText(castSkillPath('SKILL.md'));
    expect(body, `character-rig/SKILL.md 应引用契约标题 ${CastRequiredHeading}`).toContain(CastRequiredHeading);
  });

  // 驱动库只准读 character.json（CSP 下引不进 YAML 库），且不得出现不受那条 paused timeline 管的动画：
  // rAF、定时器、自建 timeline、SMIL <animate>、CSS @keyframes、WAAPI element.animate()。
  it('cast.js reads JSON, not YAML', () => {
    // 只看代码，不看注释：注释里正需要写清楚为什么不读 YAML、为什么不用 rAF。
    const code = stripJSComments(shared().readText(castSkillPath('cast.js')));
    expect(code, 'cast.js 没有读取 character.json').toContain('/character.json');
    expect(code, 'cast.js 不得在浏览器里拉取 character.yaml：CSP 下引不进 YAML 库').not.toContain('/character.yaml');
    for (const forbidden of ['jsyaml', 'yaml.load', 'parseYaml', 'YAML.parse']) {
      expect(code, `cast.js 不得出现 YAML 解析器 ${forbidden}：真相源是 character.json`).not.toContain(forbidden);
    }
    for (const forbidden of ['requestAnimationFrame', 'setTimeout(', 'setInterval(', 'gsap.timeline(', '.animate(', '<animate', '@keyframes', 'new Animation']) {
      expect(code, `cast.js 不得出现 ${forbidden}：动画必须挂在调用方传入的 paused timeline 上`).not.toContain(forbidden);
    }
  });

  // cast 包与 cast.js 里一式两份的四个常量。data-no-mirror 漂了是静默的：facing: left 的镜头里
  // 举牌、字幕板直接出反字。三个字符串常量连「= 」一起锚定，锚的是赋值那一行本身。
  it('cast.js constants match the cast package', () => {
    const code = stripJSComments(shared().readText(castSkillPath('cast.js')));
    for (const want of [`= '${cast.SchemaVersion}'`, `= '${cast.DefaultView}'`, `= '${cast.JointPrefix}'`, `[${cast.NoMirrorAttr}]`]) {
      expect(code, `cast.js 里找不到 ${want}：它与 cast 包的常量必须一字不差`).toContain(want);
    }
  });

  // 用 node 对 cast.js 导出的纯函数直接求值：把「转身在哪一帧换视图」这类定义性行为锁进可执行断言。
  it('cast.js pure functions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-assets-rig-'));
    try {
      const driver = path.join(dir, 'cast.js');
      fs.writeFileSync(driver, shared().readFile(castSkillPath('cast.js')));
      const script = path.join(dir, 'assert.mjs');
      fs.writeFileSync(script, castPureAssertions);
      const ran = spawnSync(process.execPath, [script, driver], { encoding: 'utf8' });
      expect(ran.status, `cast.js 纯函数断言未通过：\n${ran.stdout}${ran.stderr}`).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * cast.pure 里那几个取值函数的定义性行为。cast.js 是浏览器端的经典脚本，不是 ES 模块：
 * 用 new Function 取出它的顶层 const，比给它加一套模块导出更保险。纯函数不碰 DOM，node 里不需要打桩。
 */
const castPureAssertions = `
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const cast = new Function(src + '; return cast;')();
const p = cast.pure;
const fail = (msg) => { console.error('断言失败：' + msg); process.exit(1); };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 1) 换视图的时刻必须正好是压扁的零点。
//    seq 有 N 个视图就压 N-1 次，每次切换都落在角色宽度为 0 的那一瞬。
for (const count of [2, 3, 4]) {
  const segments = count - 1;
  let switches = 0;
  let prev = p.viewIndexAtPhase(0, count);
  for (let i = 1; i <= 200000; i++) {
    const phase = (i / 200000) * segments;
    const index = p.viewIndexAtPhase(phase, count);
    if (index === prev) continue;
    switches++;
    prev = index;
    const pinch = p.pinchScaleAtPhase(phase);
    if (pinch > 1e-4) fail(count + ' 个视图：在 phase=' + phase + ' 换视图时压扁量是 ' + pinch + '，应为 0');
  }
  if (switches !== segments) fail(count + ' 个视图应当切换 ' + segments + ' 次，实际 ' + switches);
  if (!near(p.pinchScaleAtPhase(0), 1)) fail('转身起点必须是满宽');
  if (!near(p.pinchScaleAtPhase(segments), 1)) fail('转身终点必须是满宽');
}

// 2) 镜像翻转连续走 +1 -> 0 -> -1，中点恰好过零。
if (!near(p.mirrorScaleAtProgress(0), 1)) fail('镜像起点应为 +1');
if (!near(p.mirrorScaleAtProgress(0.5), 0)) fail('镜像中点应过零');
if (!near(p.mirrorScaleAtProgress(1), -1)) fail('镜像终点应为 -1');

// 3) 呼吸包络两端归零：seek 出区间时不留残留角度。
if (p.breathEnvelope(0) !== 0 || p.breathEnvelope(1) !== 0) fail('呼吸包络两端必须为 0');
if (p.breathEnvelope(0.5) !== 1) fail('呼吸包络中段必须为 1');

// 4) 几何：脚底压在 ground 上，高度等于 heightRatio × 舞台高度。
const layout = p.actorLayout({
  stageW: 1080, stageH: 1440, x: 0.34, ground: 0.78, heightRatio: 0.27,
  viewBox: [0, 0, 400, 520], baselineY: 512,
});
if (!near(layout.anchorLeft, 1080 * 0.34)) fail('锚点横坐标错');
if (!near(layout.anchorTop, 1440 * 0.78)) fail('锚点纵坐标错');
if (!near(layout.height, 1440 * 0.27)) fail('绘制高度错');
if (!near(layout.viewTop + 512 * layout.scale, 0)) fail('脚底没有压在 ground 上');
if (!near(layout.viewLeft * -2, layout.width)) fail('角色左右中线没有对齐 x');

// 5) 舞台状态是时间的纯函数：区间前取初始态、区间后取终态，与求值顺序无关。
const initial = { view: 'front', sign: 1 };
const schedule = [
  { start: 2, end: 2.2, seq: ['front', 'three-quarter', 'side'], sign: 1, mirror: false },
  { start: 5, end: 5.2, seq: ['side', 'three-quarter', 'front'], sign: 1, mirror: false },
];
const at = (t) => p.stageStateAt(schedule, initial, t);
if (at(0).view !== 'front' || at(1.9).view !== 'front') fail('转身之前应显示 front');
if (at(3).view !== 'side' || at(4.9).view !== 'side') fail('两次转身之间应显示 side');
if (at(6).view !== 'front') fail('第二次转身之后应显示 front');
if (at(2.1).view !== 'three-quarter') fail('转身中点应显示 via 视图');
if (!near(at(2.05).sign, 0)) fail('第一次换视图那一帧宽度应为 0');
for (const t of [0, 1.9, 2.05, 2.1, 3, 4.9, 5.1, 6]) {
  const a = JSON.stringify(at(t));
  for (let k = 0; k < 5; k++) { at(Math.random() * 8); }
  if (JSON.stringify(at(t)) !== a) fail('t=' + t + ' 的取值受了求值顺序影响');
}
console.log('压扁零点/换视图对齐、镜像曲线、呼吸包络、几何、乱序求值一致性 —— 全部通过');
`;

// stripJSComments 只要在任何一处认错上下文，扫描就会整体错位：把代码当字符串吞掉的话，
// 上面全部禁令与常量断言都会静默失效。喂一段把四种上下文全凑齐的样本，逐字比对剥离结果。
it('stripJSComments handles regex literals', () => {
  const src =
    [
      `const cls = /["']/;      // 正则里的引号不是引号：这条注释必须被剥掉`,
      `const url = 'https://a.b//c'; // 字符串里的 // 不是注释开头`,
      `const raw = "他说 /* 别删我 */";  // 字符串里的块注释记号也不是注释`,
      `/* 跨行块注释`,
      `   第二行 */`,
      `const div = total / count;  // 这个斜杠是除号，不能当成正则开头`,
      "const tpl = `第 ${idx / 2} 段 ${label.replace(/\\s+/g, '')}`; // 模板串里两种都有",
      `const esc = /a\\/b/g.test(url); // 正则里转义过的斜杠不算结束`,
      `setTimeout(fn, 0); // 这行注释里的 setTimeout( 必须被剥掉，代码里的那个不许被剥掉`,
    ].join('\n') + '\n';
  const want =
    [
      `const cls = /["']/;`,
      `const url = 'https://a.b//c';`,
      `const raw = "他说 /* 别删我 */";`,
      ``,
      ``,
      `const div = total / count;`,
      "const tpl = `第 ${idx / 2} 段 ${label.replace(/\\s+/g, '')}`;",
      `const esc = /a\\/b/g.test(url);`,
      `setTimeout(fn, 0);`,
    ].join('\n') + '\n';
  const got = stripJSComments(src);
  // 行尾空白是「注释被换成换行」留下的，不影响任何 includes 断言，逐行右裁后再比。
  const trimLines = (s: string) =>
    s
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n');
  expect(trimLines(got)).toBe(trimLines(want));
  // 再单独钉两条最要命的：注释里的禁令词必须消失，代码里的必须留下。
  expect(got.includes('这条注释必须被剥掉') || got.includes('这行注释里的'), '正则/字符串之后的行注释没有被剥掉：假红回来了').toBe(false);
  expect(got, '代码里的 setTimeout( 被吃掉了：假绿——禁令断言从此形同虚设').toContain('setTimeout(fn, 0)');
});

// 下发提示词与固定版本之间的一致性：锁定文件规则写明的版本等于 PinnedVersion，
// 且产物里出现的 hyperframes@ 版本全部等于它（而不是「包含」：新旧两个版本号同时留着也会通过）。
it('presets pin the same HyperFrames version as the binary', () => {
  const tree = files();
  const prompts = tree
    .readDir('presets')
    .filter((entry) => entry.isDir)
    .map((entry) => `presets/${entry.name}/PROMPT-PRODUCTION.md`)
    .filter((rel) => tree.exists(rel));
  expect(prompts.length, '资产树里没有任何 PROMPT-PRODUCTION.md').toBeGreaterThan(0);
  const want = 'hyperframes@' + hyperframes.PinnedVersion;
  for (const rel of prompts) {
    const body = tree.readText(rel);
    // CLI 改由 am hyperframes 调用后，版本号以「版本固定为 `x`」写进锁定文件规则。两种写法都要求等于 PinnedVersion。
    expect(body, `${rel} 没有写明 HyperFrames 版本固定为 ${hyperframes.PinnedVersion}`).toContain('版本固定为 `' + hyperframes.PinnedVersion + '`');
    for (const got of body.match(/hyperframes@[0-9][0-9A-Za-z.-]*/g) ?? []) {
      expect(got, `${rel} 固定的是 ${got}，与二进制的 ${want} 不一致`).toBe(want);
    }
  }
});

/**
 * 「后面跟的 / 一定是正则字面量开头，不是除号」的关键字。
 *
 * JS 的 / 有歧义：`a / b` 是除法，`return /x/` 是正则。判别方式是看前一个有意义
 * 的 token 能不能作为一个值的结尾——能（标识符、数字、字符串、) ] }）就是除号，
 * 不能（运算符、逗号、左括号，以及这里这些关键字）就是正则。
 */
const regexPrefixKeywords = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function isJSIdentRune(c: string): boolean {
  return c === '_' || c === '$' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * 判断刚扫到的 / 是正则开头还是除号，依据是已产出代码的末尾。
 *
 * 已知边界：`if (a) /re/.test(b)` 这种「) 之后直接跟正则」会被判成除号。不看语法上下文就无法区分它和
 * `f(a) / 2`；cast.js 里的正则都跟在 = 或 ( 之后，判别不到这条边界。
 */
function regexCanFollow(out: string[]): boolean {
  let i = out.length - 1;
  while (i >= 0 && (out[i] === ' ' || out[i] === '\t' || out[i] === '\n' || out[i] === '\r')) i--;
  if (i < 0) return true;
  const c = out[i];
  if (c === ')' || c === ']' || c === '}') return false;
  if (c === "'" || c === '"' || c === '`') return false;
  if (isJSIdentRune(c)) {
    let j = i;
    while (j >= 0 && isJSIdentRune(out[j])) j--;
    return regexPrefixKeywords.has(out.slice(j + 1, i + 1).join(''));
  }
  return true;
}

/**
 * 去掉 // 行注释与 /* *\/ 块注释，只留下可执行代码。
 *
 * 逐字符扫描并跟踪全部四种「不是代码」的上下文：字符串、模板串（含 ${} 里嵌回代码那一层）、
 * 正则字面量、注释。把注释当代码（漏剥）只是假红；把代码当注释或当字符串是假绿——
 * 上面那些禁令与常量断言全部悄悄失效，测试照样通过。不引第三方 JS 解析器：这是测试里的一段静态检查。
 */
function stripJSComments(src: string): string {
  const runes = [...src];
  const out: string[] = [];
  // 模板串栈：进入 `…` 压一层，进入其中的 ${…} 再压一层代码帧。
  // depths 记每个代码帧里未闭合的 { 数，用来分辨 ${} 的收尾 } 与普通块的 }。
  const inTemplate = [false];
  const depths = [0];
  const top = () => inTemplate.length - 1;

  for (let i = 0; i < runes.length; i++) {
    const c = runes[i];
    if (inTemplate[top()]) {
      if (c === '\\' && i + 1 < runes.length) {
        out.push(c, runes[i + 1]);
        i++;
      } else if (c === '`') {
        out.push(c);
        inTemplate.pop();
        depths.pop();
      } else if (c === '$' && i + 1 < runes.length && runes[i + 1] === '{') {
        out.push(c, '{');
        i++;
        inTemplate.push(false);
        depths.push(0);
      } else {
        out.push(c);
      }
      continue;
    }

    // 行注释：整行吃掉，只留换行，保住后续行号。
    if (c === '/' && i + 1 < runes.length && runes[i + 1] === '/') {
      while (i < runes.length && runes[i] !== '\n') i++;
      out.push('\n');
      continue;
    }
    // 块注释：整段吃掉，内部每个换行照写一个，同样是为了保住行号。
    if (c === '/' && i + 1 < runes.length && runes[i + 1] === '*') {
      i += 2;
      while (i < runes.length && !(runes[i] === '*' && i + 1 < runes.length && runes[i + 1] === '/')) {
        if (runes[i] === '\n') out.push('\n');
        i++;
      }
      i++; // 停在 '/' 上，交给外层 i++ 跨过去
      continue;
    }
    // 正则字面量：连同字符组与标志一起原样抄下来，里面的引号不算引号。
    if (c === '/' && regexCanFollow(out)) {
      out.push(c);
      let inClass = false;
      for (i++; i < runes.length; i++) {
        const r = runes[i];
        out.push(r);
        if (r === '\\' && i + 1 < runes.length) {
          i++;
          out.push(runes[i]);
          continue;
        }
        if (r === '\n') break; // 未闭合的正则不存在，按行止损
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      while (i + 1 < runes.length && isJSIdentRune(runes[i + 1])) {
        // 标志位 g/i/m/s/u/y
        i++;
        out.push(runes[i]);
      }
      continue;
    }
    if (c === "'" || c === '"') {
      out.push(c);
      for (i++; i < runes.length; i++) {
        const r = runes[i];
        out.push(r);
        if (r === '\\' && i + 1 < runes.length) {
          i++;
          out.push(runes[i]);
          continue;
        }
        if (r === c || r === '\n') break;
      }
      continue;
    }
    if (c === '`') {
      out.push(c);
      inTemplate.push(true);
      depths.push(0);
      continue;
    }
    if (c === '{') {
      depths[depths.length - 1]++;
    } else if (c === '}') {
      if (depths[depths.length - 1] === 0 && top() > 0) {
        // ${…} 收尾：回到外层模板串。
        out.push(c);
        inTemplate.pop();
        depths.pop();
        continue;
      }
      if (depths[depths.length - 1] > 0) depths[depths.length - 1]--;
    }
    out.push(c);
  }
  return out.join('');
}
