import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import { contactSheet, renderSVG } from '../styleimage';
import { formatFixed, pathError } from './gofmt';
import { own, view, viewNames, type Pack } from './pack';
import { attr, JointPrefix } from './rig';
import { XmlDecoder } from './xml';

/** 预览缩略图宽度，与风格示例生成器保持同一量级。 */
const previewThumbnailWidthPx = 240;

/**
 * 把命名姿势静态地烘进 viewName 对应视图的 rig SVG，供人眼验收用。
 *
 * 同一个姿势在不同视图下旋转的支点不同：这里用 view(pack, viewName) 取出
 * 那个视图自己的 file 与 joints[...].pivot，而不是永远用默认视图的——否则
 * 角色转身后，姿势预览用的还是正面的支点，肉眼验收图和实际渲染对不上。
 *
 * 用 XML 解码器定位 <g id="j-…"> 的注入点，只在原始文本上做插入，而不是
 * 重新序列化整棵 XML 树：与风格生成器不做 YAML 重序列化同理——
 * 手绘 SVG 里的属性顺序、数字写法和注释都会被序列化器改写，验收图与真实
 * 渲染就对不上了。
 *
 * 之前用正则匹配 `<g\s+id="j-…"`，要求 id 必须紧跟在 <g 后面——手写 rig 里
 * `<g class="limb" id="j-head">` 这种属性顺序完全不匹配，整个关节的旋转
 * 被静默丢掉、不报错。解码器按属性名查找，与顺序无关，能修好这个洞。
 * validateRig 已经拦住了 j- 分组自带原生 transform 的写法（会和这里注入的
 * transform 冲突成无效 XML），所以这里不需要再处理"合并已有 transform"。
 */
export function poseSVG(pack: Pack, viewName: string, poseName: string): string {
  if (!pack.poses || !Object.hasOwn(pack.poses, poseName)) throw new Error(`角色 ${pack.id} 没有姿势 ${poseName}`);
  const pose = pack.poses[poseName];
  const rig = view(pack, viewName);
  const file = path.join(pack.dir, rig.file);
  let src: string;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读取 rig 失败：${pathError('open', file, err)}`, { cause: err });
  }

  const injections: Array<{ at: number; text: string }> = [];
  const decoder = new XmlDecoder(src);
  for (;;) {
    let token;
    try {
      token = decoder.token();
    } catch (err) {
      throw new Error(`解析 rig 失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (token === null) break;
    if (token.kind !== 'start' || token.name.local !== 'g') continue;
    const id = attr(token, 'id');
    if (!id.startsWith(JointPrefix)) continue;
    const name = id.slice(JointPrefix.length);
    const angle = own(pose, name);
    if (angle === undefined || angle === 0) continue;
    const pivot = own(rig.joints, name)?.pivot ?? [0, 0];

    // inputOffset() 在读完这个起始标签后，指向它结束处的下一个字符：
    // 普通标签是 "...>" 之后，自闭合标签是 ".../>" 之后。
    // 插入点要落在那个 ">" 之前——自闭合标签还要往前多让一位，避开 "/"。
    const end = decoder.inputOffset();
    let at = end - 1;
    if (end >= 2 && src.slice(end - 2, end) === '/>') at = end - 2;
    injections.push({ at, text: ` transform="rotate(${trimFloat(angle)} ${trimFloat(pivot[0])} ${trimFloat(pivot[1])})"` });
  }

  // 从后往前插入，避免前面的插入改变后面记录下来的偏移。
  injections.sort((a, b) => b.at - a.at);
  for (const inj of injections) src = src.slice(0, inj.at) + inj.text + src.slice(inj.at);
  return src;
}

/**
 * 把角度/坐标格式化成最多 3 位小数，供 poseSVG 生成的验收预览图
 * 使用。3 位小数会截断 character.yaml 里精度更高的 pivot/rotate 值，但这
 * 条路径只服务人眼验收：am cast preview 输出的 SVG/PNG 从不参与实际渲染，
 * cast.js 的 pose() 直接读 character.json 里的原始浮点值、不经过这个函数，
 * 所以这里的精度损失不会传导到成片。
 */
export function trimFloat(value: number): string {
  let text = formatFixed(value, 3).replace(/0+$/, '');
  if (text.endsWith('.')) text = text.slice(0, -1);
  return text;
}

/**
 * 为每个视图各出一套 PNG 与一张 contact sheet，返回视图名到
 * contact sheet 路径的映射。
 *
 * 输出文件名必须带视图名（<id>-<view>-<pose>.png、
 * <id>-<view>-contact-sheet.png）：不同视图往往共用同一批姿势名，文件名不
 * 带视图名的话，后写的视图会静默覆盖先写的视图的同名 PNG——不报错，只是
 * 验收图少了几张，人不会第一时间发现。
 */
export function preview(pack: Pack, outDir: string): Record<string, string> {
  fs.mkdirSync(outDir, { recursive: true });
  const names = Object.keys(pack.poses ?? {}).sort(compareBytes);
  const sheets: Record<string, string> = {};
  for (const viewName of viewNames(pack)) {
    const pngs: string[] = [];
    for (const name of names) {
      const body = poseSVG(pack, viewName, name);
      const svgPath = path.join(outDir, `${pack.id}-${viewName}-${name}.svg`);
      fs.writeFileSync(svgPath, body, { mode: 0o644 });
      const pngPath = svgPath.slice(0, -'.svg'.length) + '.png';
      renderSVG(svgPath, pngPath);
      pngs.push(pngPath);
    }
    const sheet = path.join(outDir, `${pack.id}-${viewName}-contact-sheet.png`);
    const geometry = `${previewThumbnailWidthPx}x`;
    const tile = `4x${Math.floor((names.length + 3) / 4)}`;
    contactSheet(pngs, sheet, geometry, 'white', tile);
    sheets[viewName] = sheet;
  }
  return sheets;
}
