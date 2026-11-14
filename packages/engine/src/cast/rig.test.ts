import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { goodRig, goodSVG, tempDir } from './fixtures';
import { validateRig } from './rig';

function writeSVG(body: string): string {
  const file = path.join(tempDir(), 'rig.svg');
  fs.writeFileSync(file, body);
  return file;
}

describe('validateRig', () => {
  it('accepts good', () => {
    expect(validateRig(writeSVG(goodSVG), goodRig)).toEqual([]);
  });

  describe('rejects', () => {
    const cases: Array<[name: string, svg: string, want: string]> = [
      ['viewBox 与 yaml 不一致', goodSVG.replace('viewBox="0 0 400 520"', 'viewBox="0 0 400 600"'), 'viewBox'],
      ['缺关节对应的 g', goodSVG.replace('id="j-frontLeg"', 'id="frontLeg"'), 'frontLeg'],
      ['多出未声明的 j- 分组', goodSVG.replace('</svg>', '<g id="j-tail"/></svg>'), 'tail'],
      ['内嵌 animate', goodSVG.replace('</svg>', '<animate attributeName="opacity" to="0"/></svg>'), 'animate'],
      ['内嵌 animateTransform', goodSVG.replace('</svg>', '<animateTransform attributeName="transform"/></svg>'), 'animateTransform'],
      ['内嵌 animateMotion', goodSVG.replace('</svg>', '<animateMotion/></svg>'), '<animateMotion>'],
      ['内嵌 set', goodSVG.replace('</svg>', '<set attributeName="opacity" to="0"/></svg>'), '<set>'],
      ['style 里有 keyframes', goodSVG.replace('</svg>', '<style>@keyframes spin{to{transform:rotate(1turn)}}</style></svg>'), '@keyframes'],
      ['style 里有 transition', goodSVG.replace('</svg>', '<style>#j-head{transition:all .3s}</style></svg>'), 'transition'],
      ['内嵌 script', goodSVG.replace('</svg>', '<script>1</script></svg>'), 'script'],
      ['foreignObject', goodSVG.replace('</svg>', '<foreignObject width="1" height="1"/></svg>'), 'foreignObject'],
      ['外链 href', goodSVG.replace('</svg>', '<image href="https://example.com/a.png"/></svg>'), '外链'],
      [
        'non-scaling-stroke',
        goodSVG.replace(
          'stroke-width="6"/></g>\n  <g id="j-frontLeg">',
          'stroke-width="6" vector-effect="non-scaling-stroke"/></g>\n  <g id="j-frontLeg">',
        ),
        'non-scaling-stroke',
      ],
      ['SVG 里写了 transform-origin', goodSVG.replace('<g id="j-head">', '<g id="j-head" transform-origin="200 168">'), 'transform-origin'],
      ['j- 分组带原生 transform', goodSVG.replace('<g id="j-head">', '<g id="j-head" transform="translate(10,0)">'), 'transform'],
      ['内联 style 里有 transition', goodSVG.replace('<g id="j-head">', '<g id="j-head" style="transition: transform 1s">'), 'transition'],
      ['内联 style 里有 animation', goodSVG.replace('<g id="j-head">', '<g id="j-head" style="animation: spin 2s linear infinite">'), 'animation'],
    ];
    for (const [name, svg, want] of cases) {
      it(name, () => {
        expect(validateRig(writeSVG(svg), goodRig).join('\n')).toContain(want);
      });
    }
  });

  // 非 j- 分组上的 transform 是正常美术手段（比如整体缩放/平移一个装饰性分组），不应被误伤。
  it('allows transform outside joint groups', () => {
    const svg = goodSVG.replace('</svg>', '<g transform="translate(5,5)"><rect width="1" height="1"/></g></svg>');
    expect(validateRig(writeSVG(svg), goodRig)).toEqual([]);
  });

  // 机械化 SKILL.md 里的规则原文：rig 里任何 <text>/<tspan>，若自身及全部祖先都没有
  // data-no-mirror，就是一条问题。
  it('requires data-no-mirror on text elements', () => {
    const svg = goodSVG.replace('</svg>', '<text x="0" y="0">举牌文字</text></svg>');
    expect(validateRig(writeSVG(svg), goodRig).join('\n')).toContain('data-no-mirror');
  });

  // 元素自身标注时不应误报。
  it('accepts text with own data-no-mirror', () => {
    const svg = goodSVG.replace('</svg>', '<text x="0" y="0" data-no-mirror="true">举牌文字</text></svg>');
    expect(validateRig(writeSVG(svg), goodRig)).toEqual([]);
  });

  // 标注在祖先分组上时同样应当豁免。
  it('accepts text inheriting data-no-mirror from ancestor', () => {
    const svg = goodSVG.replace('</svg>', '<g data-no-mirror="true"><text x="0" y="0">举牌文字</text></g></svg>');
    expect(validateRig(writeSVG(svg), goodRig)).toEqual([]);
  });

  // tspan 同样带方向语义：从祖先 text 继承时不报，裸 tspan（且 text 本身也没标）要报。
  it('requires data-no-mirror on tspan', () => {
    const inherited = goodSVG.replace('</svg>', '<text x="0" y="0" data-no-mirror="true"><tspan>没有单独标注的 tspan</tspan></text></svg>');
    expect(validateRig(writeSVG(inherited), goodRig)).toEqual([]);

    const bare = goodSVG.replace('</svg>', '<text x="0" y="0"><tspan>裸 tspan</tspan></text></svg>');
    const joined = validateRig(writeSVG(bare), goodRig).join('\n');
    expect(joined).toContain('tspan');
    expect(joined).toContain('data-no-mirror');
  });

  // 不是 Go 测试的移植：钉住与 Go encoding/xml 一致的几条文案与行为。
  it('reports XML errors and viewBox mismatch like Go', () => {
    expect(validateRig(writeSVG(goodSVG.replace('</svg>', '')), goodRig)).toEqual(['解析 rig SVG 失败：XML syntax error on line 4: unexpected EOF']);
    expect(validateRig(writeSVG(goodSVG.replace('</svg>', '</g></svg>')), goodRig)).toEqual([
      '解析 rig SVG 失败：XML syntax error on line 4: element <svg> closed by </g>',
    ]);
    expect(validateRig(writeSVG(goodSVG.replace('viewBox="0 0 400 520"', 'viewBox="0,0,400,600"')), goodRig)).toEqual([
      'rig.svg 的 viewBox [0 0 400 600] 与 character.yaml 声明的 [0 0 400 520] 不一致',
    ]);
    expect(validateRig(path.join(tempDir(), 'missing.svg'), goodRig)[0]).toMatch(/^读取 rig 失败：open .*missing\.svg: no such file or directory$/);
  });
});
