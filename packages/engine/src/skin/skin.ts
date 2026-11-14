/**
 * 界面皮肤：客户端（主窗口与桌宠）的配色、字体与桌宠工作室的样子，一份声明换一整套。
 *
 * 皮肤只能是数据，不带样式表与脚本：界面的每一处颜色都已经是 styles.css `:root` 上的变量（UITokens），
 * 皮肤给这些变量换值；值逐个校验（颜色只认 #hex / rgb() / hsl()，字体只认字体名），所以皮肤里写不进
 * url()、@import 这类会去连网或读文件的东西。桌宠可以只换颜色（materials / crew / room / filter），
 * 也可以整个换成插件自己的页面（page，在沙箱 iframe 里画，与插件页面同一套隔离）。
 *
 * 来源：宿主自带的「放映室」（DefaultSkinID，什么都不换）、内置插件在 apply 里登记的（ctx.skin）、
 * 第三方插件清单 `skins` 列出的 JSON 文件。三者经同一个 parseSkin 校验。
 */

export const DefaultSkinID = 'default';

/** styles.css `:root` 上皮肤能换的颜色变量（不带 `--`）。 */
export const UITokens = [
  'bg',
  'panel',
  'raised',
  'well',
  'chip',
  'hover',
  'line',
  'line-strong',
  'text',
  'text-2',
  'text-3',
  'muted',
  'faint',
  'accent',
  'accent-hover',
  'accent-ink',
  'accent-soft',
  'accent-line',
  'accent-text',
  'ok',
  'stale',
  'bad',
  'add-bg',
  'del-bg',
] as const;
export type UIToken = (typeof UITokens)[number];

/** 字体变量：正文、标题、数字与小标签。 */
export const FontTokens = ['sans', 'serif', 'mono'] as const;
export type FontToken = (typeof FontTokens)[number];

/** 桌宠工作室的材质：每种三个颜色（顶面、朝左下的面、朝右下的面）。与 Pet.tsx 的 mat 一一对应。 */
export const PetMaterials = ['wood', 'walnut', 'metal', 'dark', 'canvas', 'brass', 'paper', 'plant', 'pot', 'lit', 'rec', 'roof'] as const;
export type PetMaterial = (typeof PetMaterials)[number];

/** 工作室里的人（与 Pet.tsx 的 looks 一一对应）与每人能换的颜色。 */
export const PetCrew = ['director', 'op1', 'op2', 'op3', 'editor', 'voice'] as const;
export type PetCrewMember = (typeof PetCrew)[number];
export const PetLookColors = ['coat', 'coatShade', 'trousers', 'shoe', 'hair', 'skin', 'skinShade', 'hatColor'] as const;
export type PetLookColor = (typeof PetLookColors)[number];

/** 房间本身：地台三面、两面墙、墙头、影棚背景纸（与 Pet.tsx 的 roomShell 对应）。 */
export const PetRoom = ['slab', 'slab-left', 'slab-right', 'wall-left', 'wall-back', 'cap', 'backdrop'] as const;
export type PetRoomPart = (typeof PetRoom)[number];

/** 整间工作室一起调色：色相（度）、饱和、亮度、对比。 */
export interface PetFilter {
  hue?: number;
  saturate?: number;
  brightness?: number;
  contrast?: number;
}
const filterRanges: Record<keyof PetFilter, [number, number]> = { hue: [-180, 180], saturate: [0, 2], brightness: [0.5, 1.5], contrast: [0.5, 1.5] };

export interface SkinPet {
  materials?: Partial<Record<PetMaterial, [string, string, string]>>;
  crew?: Partial<Record<PetCrewMember, Partial<Record<PetLookColor, string>>>>;
  room?: Partial<Record<PetRoomPart, string>>;
  filter?: PetFilter;
  /** 整个换掉工作室：同一个插件 pages 里的页面 id（只有第三方插件能写）。 */
  page?: string;
}

export interface Skin {
  /** 皮肤自己的 id（小写字母、数字、连字符）；对外的标识是「插件 id/皮肤 id」。 */
  id: string;
  name: string;
  description: string;
  /** 深色还是浅色：决定原生控件（滚动条、输入框）的配色。 */
  scheme: 'dark' | 'light';
  tokens: Partial<Record<UIToken, string>>;
  fonts: Partial<Record<FontToken, string>>;
  /** 圆角（像素）。 */
  radius?: number;
  pet: SkinPet;
}

const idPattern = /^[a-z][a-z0-9-]{1,39}$/;
const hexColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// rgb()/rgba()/hsl()/hsla()：括号里只有数字、小数点、百分号、deg、逗号、空格与斜杠。
const funcColor = /^(?:rgba?|hsla?)\((?:[\d.\s,/%]|deg)+\)$/i;
// 字体栈：字体名（可加引号）用逗号隔开；不认括号、分号、冒号与反斜杠，写不进 url()、local() 与别的声明。
const fontStack = /^(?:\s*(?:'[^'(),;:\\]{1,60}'|"[^"(),;:\\]{1,60}"|[A-Za-z0-9㐀-鿿 -]{1,60})\s*)(?:,(?:\s*(?:'[^'(),;:\\]{1,60}'|"[^"(),;:\\]{1,60}"|[A-Za-z0-9㐀-鿿 -]{1,60})\s*))*$/;

export function isColor(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && (hexColor.test(v) || funcColor.test(v));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function known(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${where} 有不认识的字段：${extra.sort().join('、')}`);
}

function text(raw: Record<string, unknown>, key: string, where: string, max: number, required = true): string {
  const v = raw[key];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && v.trim() === '') || v.length > max) throw new Error(`${where}.${key} 要是不超过 ${max} 字的字符串`);
  return v;
}

function colorMap<K extends string>(raw: unknown, keys: readonly K[], where: string): Partial<Record<K, string>> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error(`${where} 要是对象`);
  known(raw, keys, where);
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    if (raw[k] === undefined) continue;
    if (!isColor(raw[k])) throw new Error(`${where}.${k} 要是颜色（#hex、rgb() 或 hsl()）`);
    out[k] = raw[k] as string;
  }
  return out;
}

/**
 * 校验并整理一份皮肤声明。`pages` 是同一个插件声明过的页面 id：桌宠的 page 只能指它们（内置插件不传，就不能写 page）。
 */
export function parseSkin(raw: unknown, where = 'skin', pages: readonly string[] = []): Skin {
  if (!isObject(raw)) throw new Error(`${where} 要是对象`);
  known(raw, ['id', 'name', 'description', 'scheme', 'tokens', 'fonts', 'radius', 'pet'], where);
  const id = text(raw, 'id', where, 40);
  if (!idPattern.test(id)) throw new Error(`${where}.id 要是小写字母开头的小写字母、数字与连字符`);
  const scheme = raw.scheme === undefined ? 'dark' : raw.scheme;
  if (scheme !== 'dark' && scheme !== 'light') throw new Error(`${where}.scheme 要是 dark 或 light`);
  const tokens = colorMap(raw.tokens, UITokens, `${where}.tokens`);
  const fonts: Skin['fonts'] = {};
  if (raw.fonts !== undefined) {
    if (!isObject(raw.fonts)) throw new Error(`${where}.fonts 要是对象`);
    known(raw.fonts, FontTokens, `${where}.fonts`);
    for (const k of FontTokens) {
      const v = raw.fonts[k];
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.length > 400 || !fontStack.test(v)) throw new Error(`${where}.fonts.${k} 要是用逗号隔开的字体名（本机字体，不能写 url()）`);
      fonts[k] = v;
    }
  }
  let radius: number | undefined;
  if (raw.radius !== undefined) {
    if (typeof raw.radius !== 'number' || !Number.isInteger(raw.radius) || raw.radius < 0 || raw.radius > 24) throw new Error(`${where}.radius 要是 0–24 的整数（像素）`);
    radius = raw.radius;
  }
  const skin: Skin = { id, name: text(raw, 'name', where, 24), description: text(raw, 'description', where, 200, false), scheme, tokens, fonts, pet: parsePet(raw.pet, `${where}.pet`, pages) };
  if (radius !== undefined) skin.radius = radius;
  return skin;
}

function parsePet(raw: unknown, where: string, pages: readonly string[]): SkinPet {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error(`${where} 要是对象`);
  known(raw, ['materials', 'crew', 'room', 'filter', 'page'], where);
  const pet: SkinPet = {};
  if (raw.materials !== undefined) {
    if (!isObject(raw.materials)) throw new Error(`${where}.materials 要是对象`);
    known(raw.materials, PetMaterials, `${where}.materials`);
    const materials: SkinPet['materials'] = {};
    for (const k of PetMaterials) {
      const v = raw.materials[k];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.length !== 3 || !v.every(isColor)) throw new Error(`${where}.materials.${k} 要是三个颜色（顶面、左面、右面）`);
      materials[k] = [v[0], v[1], v[2]];
    }
    pet.materials = materials;
  }
  if (raw.crew !== undefined) {
    if (!isObject(raw.crew)) throw new Error(`${where}.crew 要是对象`);
    known(raw.crew, PetCrew, `${where}.crew`);
    const crew: SkinPet['crew'] = {};
    for (const k of PetCrew) if (raw.crew[k] !== undefined) crew[k] = colorMap(raw.crew[k], PetLookColors, `${where}.crew.${k}`);
    pet.crew = crew;
  }
  if (raw.room !== undefined) pet.room = colorMap(raw.room, PetRoom, `${where}.room`);
  if (raw.filter !== undefined) {
    if (!isObject(raw.filter)) throw new Error(`${where}.filter 要是对象`);
    const keys = Object.keys(filterRanges) as (keyof PetFilter)[];
    known(raw.filter, keys, `${where}.filter`);
    const filter: PetFilter = {};
    for (const k of keys) {
      const v = raw.filter[k];
      if (v === undefined) continue;
      const [lo, hi] = filterRanges[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${where}.filter.${k} 要是 ${lo} 到 ${hi} 之间的数`);
      filter[k] = v;
    }
    pet.filter = filter;
  }
  if (raw.page !== undefined) {
    if (typeof raw.page !== 'string' || !pages.includes(raw.page)) {
      throw new Error(pages.length === 0 ? `${where}.page：只有第三方插件能用自己的页面换掉桌宠` : `${where}.page：插件的 pages 里没有 ${String(raw.page)}`);
    }
    pet.page = raw.page;
  }
  return pet;
}

/** 皮肤的样子缩成四格色块（底、面板、字、强调），选皮肤时给人看。缺的按放映室的默认值补。 */
export function swatch(s: Skin): [string, string, string, string] {
  return [s.tokens.bg ?? '#0b0a09', s.tokens.panel ?? '#11100e', s.tokens.text ?? '#efe9dd', s.tokens.accent ?? '#d9a35f'];
}
