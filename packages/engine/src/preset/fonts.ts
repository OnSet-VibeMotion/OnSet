/**
 * 字体池 assets/fontpool/ 里的字体。
 *
 * 风格独有的字体不放进每个「风格 × 画幅」目录：同一个字体会被多套风格、两种画幅引用，
 * 字体池每个文件只存一份，am init 按所选风格声明的字体把用到的那几个拷进项目的 assets/fonts/。
 */
export interface Font {
  /** 同时是字体池里的文件名与项目里 assets/fonts/ 下的文件名。 */
  file: string;
  /** @font-face 与 frame.md typography.font_files 使用的族名，也与字体文件 name 表里的族名一致。 */
  family: string;
  weight: number;
  /** 字体池里对应的许可证文件，随字体一起拷进项目。 */
  license: string;
}

const font = (file: string, family: string, weight: number, license: string): Font => ({ file, family, weight, license });

// 所有字体均为 SIL OFL 1.1。带保留字体名（RFN）的 Press Start 2P、Orbitron、得意黑只做过无损的 WOFF2 封装，
// 不做子集化——OFL 下子集化属于修改，修改后不能再用原名。霞鹜文楷的附加许可明确允许为网页分发做子集化，是例外。
// 来源与处理方式见 assets/fontpool/README.md。
export const FontNotoSerifSC400 = font('noto-serif-sc-400.woff2', 'Noto Serif SC', 400, 'LICENSE-noto-serif-sc.txt');
export const FontNotoSerifSC700 = font('noto-serif-sc-700.woff2', 'Noto Serif SC', 700, 'LICENSE-noto-serif-sc.txt');
export const FontLXGWWenKai400 = font('lxgw-wenkai-400.woff2', 'LXGW WenKai', 400, 'LICENSE-lxgw-wenkai.txt');
export const FontXiaolai400 = font('xiaolai-400.woff2', 'Xiaolai', 400, 'LICENSE-xiaolai.txt');
export const FontSmileySans400 = font('smiley-sans-oblique.woff2', 'Smiley Sans', 400, 'LICENSE-smiley-sans.txt');
export const FontZCOOLKuaiLe400 = font('zcool-kuaile-400.woff2', 'ZCOOL KuaiLe', 400, 'LICENSE-zcool-kuaile.txt');
export const FontZCOOLQingKe400 = font('zcool-qingke-huangyou-400.woff2', 'ZCOOL QingKe HuangYou', 400, 'LICENSE-zcool-qingke-huangyou.txt');
export const FontFusionPixel400 = font('fusion-pixel-12px-zh_hans.woff2', 'Fusion Pixel 12px Prop zh-Hans', 400, 'LICENSE-fusion-pixel.txt');
export const FontPressStart2P400 = font('press-start-2p-400.woff2', 'Press Start 2P', 400, 'LICENSE-press-start-2p.txt');
export const FontSilkscreen400 = font('silkscreen-400.woff2', 'Silkscreen', 400, 'LICENSE-silkscreen.txt');
export const FontOrbitron = font('orbitron-variable.woff2', 'Orbitron', 700, 'LICENSE-orbitron.txt');
export const FontChakraPetch700 = font('chakra-petch-700.woff2', 'Chakra Petch', 700, 'LICENSE-chakra-petch.txt');
export const FontFredoka600 = font('fredoka-600.woff2', 'Fredoka', 600, 'LICENSE-fredoka.txt');
export const FontFredoka700 = font('fredoka-700.woff2', 'Fredoka', 700, 'LICENSE-fredoka.txt');
export const FontBungee400 = font('bungee-400.woff2', 'Bungee', 400, 'LICENSE-bungee.txt');
export const FontCinzel700 = font('cinzel-700.woff2', 'Cinzel', 700, 'LICENSE-cinzel.txt');
export const FontBebasNeue400 = font('bebas-neue-400.woff2', 'Bebas Neue', 400, 'LICENSE-bebas-neue.txt');
export const FontOxanium600 = font('oxanium-600.woff2', 'Oxanium', 600, 'LICENSE-oxanium.txt');
export const FontSpaceGrotesk500 = font('space-grotesk-500.woff2', 'Space Grotesk', 500, 'LICENSE-space-grotesk.txt');
export const FontSpaceGrotesk700 = font('space-grotesk-700.woff2', 'Space Grotesk', 700, 'LICENSE-space-grotesk.txt');
export const FontCaveat600 = font('caveat-600.woff2', 'Caveat', 600, 'LICENSE-caveat.txt');

/**
 * 字体池的全集，顺序即 am style fonts 的展示顺序。自定义风格只能从这里（加上 SharedFonts）挑字体：
 * 渲染机没有系统字体，临时下载的字体既不可复现，许可也说不清。
 */
const allFonts: Font[] = [
  FontNotoSerifSC400, FontNotoSerifSC700, FontLXGWWenKai400, FontXiaolai400,
  FontSmileySans400, FontZCOOLKuaiLe400, FontZCOOLQingKe400, FontFusionPixel400,
  FontPressStart2P400, FontSilkscreen400, FontOrbitron, FontChakraPetch700,
  FontFredoka600, FontFredoka700, FontBungee400, FontCinzel700, FontBebasNeue400,
  FontOxanium600, FontSpaceGrotesk500, FontSpaceGrotesk700, FontCaveat600,
];

/** 字体池全集的副本。 */
export function allFontsCopy(): Font[] {
  return allFonts.map((f) => ({ ...f }));
}

/** assets/shared/assets/fonts/ 里随每个项目下发的正文字体，所有风格都可以直接使用，不需要在 Style.fonts 里声明。 */
export const SharedFonts: Font[] = [
  font('noto-sans-sc-400.woff2', 'Noto Sans SC', 400, 'LICENSE-Noto-Sans-SC.txt'),
  font('noto-sans-sc-600.woff2', 'Noto Sans SC', 600, 'LICENSE-Noto-Sans-SC.txt'),
  font('noto-sans-sc-700.woff2', 'Noto Sans SC', 700, 'LICENSE-Noto-Sans-SC.txt'),
  font('noto-sans-sc-900.woff2', 'Noto Sans SC', 900, 'LICENSE-Noto-Sans-SC.txt'),
];
