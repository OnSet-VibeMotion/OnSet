/**
 * 内置插件「界面皮肤」（skins）：随客户端带的几套皮肤。宿主自带的「放映室」不在这里——它就是 styles.css 的默认值，
 * 什么都不换（skin.DefaultSkinID）。这里的皮肤与第三方插件的皮肤走同一个校验（skin.parseSkin），证明换一整套
 * 配色不用改界面代码；设置页「外观」按 /api/skins 列出它们。
 */
import type { BuiltinPlugin } from '../../plugin/types';
import type { Skin } from '../../skin/skin';

/** 白昼：纸色底、深墨字、深琥珀强调。工作室换成浅木与白墙。 */
export const daylight: Skin = {
  id: 'daylight',
  name: '白昼',
  description: '纸色底、深墨字，白天在亮处用不刺眼',
  scheme: 'light',
  tokens: {
    bg: '#f4f1ea',
    panel: '#faf8f3',
    raised: '#ffffff',
    well: '#ece7dc',
    chip: '#e7e1d4',
    hover: '#ded7c8',
    line: '#e2dccf',
    'line-strong': '#cdc4b2',
    text: '#1d1a15',
    'text-2': '#3b362e',
    'text-3': '#544d43',
    muted: '#6a6357',
    faint: '#7f786b',
    accent: '#9a5b1c',
    'accent-hover': '#84490f',
    'accent-ink': '#fffaf2',
    'accent-soft': '#f3e4cf',
    'accent-line': '#d7b78c',
    'accent-text': '#7a4510',
    ok: '#2f7a45',
    stale: '#8f6a0c',
    bad: '#b0412f',
    'add-bg': '#dcefe1',
    'del-bg': '#f6dcd8',
  },
  fonts: {},
  pet: {
    room: { slab: '#cfc3ad', 'slab-left': '#bcae95', 'slab-right': '#a99b82', 'wall-left': '#e4dccd', 'wall-back': '#ece5d8', cap: '#c9bca5', backdrop: '#f3ede2' },
    materials: {
      dark: ['#8a8174', '#746b5f', '#635b50'],
      metal: ['#9a9183', '#80786c', '#6d665b'],
      roof: ['#b9ad98', '#a59a85', '#948975'],
    },
    filter: { brightness: 1.05 },
  },
};

/** 暗房：近黑的红底、安全灯的红色强调。工作室整体偏向暗红。 */
export const darkroom: Skin = {
  id: 'darkroom',
  name: '暗房',
  description: '冲洗照片的暗房：近黑底、安全灯的红，夜里做片更静',
  scheme: 'dark',
  tokens: {
    bg: '#0a0607',
    panel: '#110a0b',
    raised: '#180e0f',
    well: '#060304',
    chip: '#211314',
    hover: '#2b191a',
    line: '#261617',
    'line-strong': '#3b2425',
    text: '#f3e7e3',
    'text-2': '#d0bab4',
    'text-3': '#b49d97',
    muted: '#9a837d',
    faint: '#836d67',
    accent: '#d0493b',
    'accent-hover': '#e2604f',
    'accent-ink': '#160707',
    'accent-soft': '#2b1110',
    'accent-line': '#5e2620',
    'accent-text': '#f39b8c',
    ok: '#93c29d',
    stale: '#e3b964',
    bad: '#ff9a6b',
    'add-bg': '#142619',
    'del-bg': '#3a1515',
  },
  fonts: {},
  pet: {
    filter: { hue: -22, saturate: 1.15, brightness: 0.88 },
  },
};

export const skinsPlugin: BuiltinPlugin = {
  id: 'skins',
  apply(ctx) {
    ctx.skin(daylight);
    ctx.skin(darkroom);
  },
};
