/**
 * 程序化零版权（MIT）基础 SVG 质感素材生成器：
 * - paper.svg：暖纸纹理（柔和纸基色 + 微细纤维 + 轻度纸张暗角）
 * - grain.svg：细腻胶片颗粒（中性透明基底 + 分形噪点 + 微颗粒点阵，可直接 overlay/soft-light 叠加）
 * - grid.svg：工程参考网格（次网格 / 主网格 / 十字准星 / 安全区中心参考线）
 *
 * 全部采用固定种子的确定性伪随机算法（Mulberry32），重复生成逐字节完全一致，
 * 不含任何脚本、外部引用或大体积位图二进制。
 */

import { formatFixed } from '../gofmt';

export interface BuiltinTextureSpec {
  readonly id: 'paper' | 'grain' | 'grid';
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
  readonly description: string;
  readonly generate: () => string;
}

/** 固定种子的 Mulberry32 确定性伪随机数生成器，输出区间 [0, 1)。 */
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fmt = (value: number, digits = 2): string => formatFixed(value, digits);

/** 生成暖纸纹理 SVG（paper.svg，1280x720，MIT）。 */
export function generatePaperSvg(): string {
  const width = 1280;
  const height = 720;
  const rand = createPrng(0x50415045);

  const fibers: string[] = [];
  for (let i = 0; i < 160; i++) {
    const x1 = rand() * width;
    const y1 = rand() * height;
    const angle = rand() * Math.PI * 2;
    const len = 14 + rand() * 44;
    const cx = x1 + Math.cos(angle) * (len * 0.5) + (rand() - 0.5) * 10;
    const cy = y1 + Math.sin(angle) * (len * 0.5) + (rand() - 0.5) * 10;
    const x2 = x1 + Math.cos(angle) * len;
    const y2 = y1 + Math.sin(angle) * len;
    const stroke = i % 3 === 0 ? '#c4b59d' : i % 3 === 1 ? '#b2a186' : '#ded4c3';
    const opacity = 0.08 + rand() * 0.14;
    const sw = 0.45 + rand() * 0.65;
    fibers.push(
      `    <path d="M${fmt(x1, 1)} ${fmt(y1, 1)} Q${fmt(cx, 1)} ${fmt(cy, 1)} ${fmt(x2, 1)} ${fmt(y2, 1)}" stroke="${stroke}" stroke-width="${fmt(sw)}" stroke-opacity="${fmt(opacity)}" fill="none" stroke-linecap="round"/>`,
    );
  }

  const flecks: string[] = [];
  for (let i = 0; i < 140; i++) {
    const cx = rand() * width;
    const cy = rand() * height;
    const r = 0.5 + rand() * 1.4;
    const fill = i % 2 === 0 ? '#a9987e' : '#8d7d65';
    const opacity = 0.05 + rand() * 0.1;
    flecks.push(
      `    <circle cx="${fmt(cx, 1)}" cy="${fmt(cy, 1)}" r="${fmt(r)}" fill="${fill}" fill-opacity="${fmt(opacity)}"/>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '  <title>OnSet Builtin Texture: Warm Paper (MIT)</title>',
    '  <defs>',
    '    <linearGradient id="paper-base" x1="0%" y1="0%" x2="100%" y2="100%">',
    '      <stop offset="0%" stop-color="#f8f4ec"/>',
    '      <stop offset="52%" stop-color="#f3ece0"/>',
    '      <stop offset="100%" stop-color="#ebe2d3"/>',
    '    </linearGradient>',
    '    <radialGradient id="paper-vignette" cx="50%" cy="50%" r="72%">',
    '      <stop offset="65%" stop-color="#d7cab5" stop-opacity="0"/>',
    '      <stop offset="100%" stop-color="#b9a88d" stop-opacity="0.22"/>',
    '    </radialGradient>',
    '    <filter id="paper-tooth" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">',
    '      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="4" seed="42" stitchTiles="stitch" result="noise"/>',
    '      <feColorMatrix type="matrix" values="0 0 0 0 0.56  0 0 0 0 0.49  0 0 0 0 0.39  0 0 0 0.08 0" in="noise" result="tinted"/>',
    '    </filter>',
    '  </defs>',
    `  <rect width="${width}" height="${height}" fill="url(#paper-base)"/>`,
    `  <rect width="${width}" height="${height}" filter="url(#paper-tooth)"/>`,
    '  <g id="paper-fibers">',
    ...fibers,
    '  </g>',
    '  <g id="paper-flecks">',
    ...flecks,
    '  </g>',
    `  <rect width="${width}" height="${height}" fill="url(#paper-vignette)"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/** 生成细腻胶片颗粒 SVG（grain.svg，1280x720，MIT）。 */
export function generateGrainSvg(): string {
  const width = 1280;
  const height = 720;
  const rand = createPrng(0x47524149);

  const speckles: string[] = [];
  for (let i = 0; i < 240; i++) {
    const cx = rand() * width;
    const cy = rand() * height;
    const r = 0.45 + rand() * 0.95;
    const isBright = i % 2 === 0;
    const fill = isBright ? '#ffffff' : '#000000';
    const opacity = (isBright ? 0.04 : 0.05) + rand() * 0.07;
    speckles.push(
      `    <circle cx="${fmt(cx, 1)}" cy="${fmt(cy, 1)}" r="${fmt(r)}" fill="${fill}" fill-opacity="${fmt(opacity)}"/>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '  <title>OnSet Builtin Texture: Fine Film Grain (MIT)</title>',
    '  <defs>',
    '    <filter id="film-grain-fine" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">',
    '      <feTurbulence type="fractalNoise" baseFrequency="0.88" numOctaves="3" seed="108" stitchTiles="stitch" result="raw"/>',
    '      <feColorMatrix type="saturate" values="0" in="raw" result="mono"/>',
    '      <feComponentTransfer in="mono" result="contrast">',
    '        <feFuncR type="linear" slope="1.25" intercept="-0.125"/>',
    '        <feFuncG type="linear" slope="1.25" intercept="-0.125"/>',
    '        <feFuncB type="linear" slope="1.25" intercept="-0.125"/>',
    '        <feFuncA type="linear" slope="0.22" intercept="0"/>',
    '      </feComponentTransfer>',
    '    </filter>',
    '    <filter id="film-grain-micro" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">',
    '      <feTurbulence type="turbulence" baseFrequency="1.45" numOctaves="2" seed="217" stitchTiles="stitch" result="raw2"/>',
    '      <feColorMatrix type="saturate" values="0" in="raw2" result="mono2"/>',
    '      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.09 0" in="mono2"/>',
    '    </filter>',
    '  </defs>',
    `  <rect width="${width}" height="${height}" fill="#808080" fill-opacity="0.02"/>`,
    `  <rect width="${width}" height="${height}" filter="url(#film-grain-fine)"/>`,
    `  <rect width="${width}" height="${height}" filter="url(#film-grain-micro)"/>`,
    '  <g id="grain-speckles">',
    ...speckles,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

/** 生成工程参考网格 SVG（grid.svg，1280x720，MIT）。 */
export function generateGridSvg(): string {
  const width = 1280;
  const height = 720;
  const minorStep = 20;
  const majorStep = 100;

  const crosshairs: string[] = [];
  for (let x = majorStep; x < width; x += majorStep) {
    for (let y = majorStep; y < height; y += majorStep) {
      crosshairs.push(
        `    <path d="M${x - 4} ${y} H${x + 4} M${x} ${y - 4} V${y + 4}" stroke="#3b82f6" stroke-width="0.9" stroke-opacity="0.34"/>`,
      );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '  <title>OnSet Builtin Texture: Engineering Reference Grid (MIT)</title>',
    '  <defs>',
    `    <pattern id="grid-minor" width="${minorStep}" height="${minorStep}" patternUnits="userSpaceOnUse">`,
    `      <path d="M ${minorStep} 0 L 0 0 0 ${minorStep}" fill="none" stroke="#64748b" stroke-width="0.6" stroke-opacity="0.16"/>`,
    '    </pattern>',
    `    <pattern id="grid-major" width="${majorStep}" height="${majorStep}" patternUnits="userSpaceOnUse">`,
    `      <rect width="${majorStep}" height="${majorStep}" fill="url(#grid-minor)"/>`,
    `      <path d="M ${majorStep} 0 L 0 0 0 ${majorStep}" fill="none" stroke="#475569" stroke-width="1" stroke-opacity="0.28"/>`,
    '    </pattern>',
    '  </defs>',
    `  <rect width="${width}" height="${height}" fill="url(#grid-major)"/>`,
    '  <g id="grid-guides" fill="none">',
    `    <line x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}" stroke="#3b82f6" stroke-width="1" stroke-opacity="0.24" stroke-dasharray="6 6"/>`,
    `    <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="#3b82f6" stroke-width="1" stroke-opacity="0.24" stroke-dasharray="6 6"/>`,
    `    <rect x="64" y="36" width="${width - 128}" height="${height - 72}" stroke="#3b82f6" stroke-width="1" stroke-opacity="0.22" stroke-dasharray="8 6"/>`,
    '  </g>',
    '  <g id="grid-crosshairs" fill="none">',
    ...crosshairs,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

export const BuiltinTextureSpecs: readonly BuiltinTextureSpec[] = [
  {
    id: 'paper',
    fileName: 'paper.svg',
    width: 1280,
    height: 720,
    description: '暖纸纹理（纸基色、微细纤维与轻度暗角，适合科普/人文/轻复古画布底纹）',
    generate: generatePaperSvg,
  },
  {
    id: 'grain',
    fileName: 'grain.svg',
    width: 1280,
    height: 720,
    description: '细腻胶片颗粒（中性透明基底，适合 overlay / soft-light 叠层消除数码塑料感）',
    generate: generateGrainSvg,
  },
  {
    id: 'grid',
    fileName: 'grid.svg',
    width: 1280,
    height: 720,
    description: '工程参考网格（20px/100px 网格、十字准星与安全区参考线，适合科技与数据讲解）',
    generate: generateGridSvg,
  },
];
