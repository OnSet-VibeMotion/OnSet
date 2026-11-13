import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { goodSVG, goodYAML, viewsYAML, writePack } from './fixtures';
import { DefaultView, load, parsePack, view, viewNames, voiceFor, type Pack, type Rig } from './pack';

describe('parsePack', () => {
  it('reads all fields', () => {
    const pack = parsePack(writePack(goodYAML));
    expect(pack.id).toBe('heiwa');
    expect(pack.name).toBe('黑娃');
    expect(pack.rig.baselineY).toBe(512);
    expect(pack.rig.viewBox).toEqual([0, 0, 400, 520]);
    expect(Object.keys(pack.rig.joints!)).toHaveLength(2);
    expect(pack.rig.joints!.head.pivot).toEqual([200, 168]);
    expect(pack.poses!.pointing!.frontLeg).toBe(48);
  });

  describe('rejects', () => {
    const cases: Array<[name: string, mutate: (body: string) => string, want: string]> = [
      ['schema 版本不对', (body) => body.replace('schema: cast/v1', 'schema: cast/v0'), 'schema'],
      ['id 与目录名规则不符', (body) => body.replace('id: heiwa', 'id: Heiwa'), 'id'],
      ['缺 idle 姿势', (body) => body.replace('  idle: {}\n', ''), 'idle'],
    ];
    for (const [name, mutate, want] of cases) {
      it(name, () => {
        expect(() => parsePack(writePack(mutate(goodYAML)))).toThrow(want);
      });
    }
  });

  it('without views keeps single view', () => {
    const pack = parsePack(writePack(goodYAML));
    // 未声明 views 时不应凭空造出视图。
    expect(pack.views).toBeNull();
    expect(viewNames(pack)).toEqual([DefaultView]);
    // 默认视图应回落到 rig 字段。
    expect(view(pack, DefaultView).file).toBe('rig.svg');
  });

  it('reads views and turns', () => {
    const pack = parsePack(writePack(viewsYAML));
    expect(viewNames(pack)).toHaveLength(3);
    expect(view(pack, 'side').joints!.head.pivot).toEqual([172, 174]);
    expect(pack.turns!['front->side']).toEqual({ via: ['three-quarter'], durationMs: 200 });
  });

  describe('rejects view problems', () => {
    const cases: Array<[name: string, body: string, want: string]> = [
      [
        '视图重名默认视图',
        goodYAML + 'views:\n  front:\n    file: x.svg\n    viewBox: [0,0,400,520]\n    baselineY: 512\n    joints:\n      head: { pivot: [1,1], rotate: [-1,1] }\n',
        'front',
      ],
      // 专用最小 fixture：side 视图完全不声明 head 关节（只有 tail），配一个只用到 head、
      // 角度取 0 的姿势——0 恰好落在零值关节的 [0,0] 区间内，"超出区间" 分支不会被触发，
      // 只有存在性检查的 "里没有声明" 会报错，从而真正把两条检查的测试隔开（详见 Go 版注释）。
      [
        '姿势用到的关节在某视图缺失',
        `schema: cast/v1
id: heiwa
name: 黑娃
summary: 跨视图关节存在性测试专用最小角色包
voice:
  minimax: { voiceId: "v-1" }
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head: { pivot: [200, 168], rotate: [-18, 18] }
views:
  three-quarter:
    file: rig-tq.svg
    viewBox: [0, 0, 400, 520]
    baselineY: 512
    joints:
      head: { pivot: [186, 170], rotate: [-22, 22] }
  side:
    file: rig-side.svg
    viewBox: [0, 0, 400, 520]
    baselineY: 512
    joints:
      tail: { pivot: [280, 288], rotate: [-30, 30] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
  lookAround: { head: 0 }
`,
        '里没有声明',
      ],
      [
        '姿势角度超出该视图区间',
        viewsYAML.replace('frontLeg: { pivot: [160, 334], rotate: [-45, 60] }', 'frontLeg: { pivot: [160, 334], rotate: [-10, 10] }'),
        'pointing',
      ],
      ['turns 引用未声明视图', viewsYAML + '  front->back: { via: [three-quarter], durationMs: 200 }\n', 'back'],
      ['turns 的 via 引用未声明视图', viewsYAML.replace('via: [three-quarter]', 'via: [profile]'), 'profile'],
      ['turns 键格式不对', viewsYAML + '  frontToSide: { via: [], durationMs: 200 }\n', 'frontToSide'],
    ];
    for (const [name, body, want] of cases) {
      it(name, () => {
        expect(() => parsePack(writePack(body))).toThrow(want);
      });
    }
  });
});

describe('voiceFor', () => {
  it('missing provider', () => {
    const body = goodYAML.replace('  bailian: { voiceId: "v-2", rate: 0.98, instruction: "平静、真诚的语气" }\n', '');
    const pack = parsePack(writePack(body));
    expect(() => voiceFor(pack, 'bailian')).toThrow('角色 heiwa 没有声明 bailian 的音色');
    expect(() => voiceFor(pack, 'minimax')).not.toThrow();
  });

  // provider 存在、但该 provider 的 voiceId 为空串：这与"provider 整个不存在"是不同的失败原因。
  it('present provider missing voiceId', () => {
    const pack = parsePack(writePack(goodYAML.replace('voiceId: "v-2"', 'voiceId: ""')));
    expect(() => voiceFor(pack, 'bailian')).toThrow('voiceId');
    // minimax 的 voiceId 未受影响，不应被这条校验株连。
    expect(() => voiceFor(pack, 'minimax')).not.toThrow();
  });
});

describe('load', () => {
  it('aggregates rig problems', () => {
    const dir = writePack(goodYAML);
    fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG.replace('</svg>', '<animate attributeName="opacity"/><script>1</script></svg>'));
    let message = '';
    try {
      load(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    // 应一次列出全部问题。
    expect(message).toContain('animate');
    expect(message).toContain('script');
    expect(message).toBe(
      '角色包 heiwa 的 rig 校验未通过：\n  - 视图 front（rig.svg）有 2 处问题：' +
        '\n      - rig 内不得出现 <animate>：它不受 timeline 控制，seek 出帧会错且不报错' +
        '\n      - rig 内不得出现 <script>：它不受 timeline 控制，seek 出帧会错且不报错',
    );
  });

  it('accepts good pack', () => {
    const dir = writePack(goodYAML);
    fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG);
    expect(load(dir).id).toBe('heiwa');
  });

  it('validates every view rig', () => {
    const dir = writePack(viewsYAML);
    // 默认视图与 three-quarter 都合规，side 的 rig 里塞一个自走动画。
    fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG);
    fs.writeFileSync(path.join(dir, 'rig-tq.svg'), goodSVG.replace('id="j-tail"', 'id="j-unused"'));
    fs.writeFileSync(path.join(dir, 'rig-side.svg'), goodSVG.replace('</svg>', '<animate attributeName="opacity"/></svg>'));
    let message = '';
    try {
      load(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    // 应同时点出视图名 side 与 animate。
    expect(message).toContain('side');
    expect(message).toContain('animate');
  });
});

describe('viewNames', () => {
  const base = (views: Record<string, Rig>): Pick<Pack, 'views'> => ({ views });
  const rig = (file: string): Rig => ({ file, viewBox: [0, 0, 0, 0], baselineY: 0, joints: null });

  // 手工构造 Pack，绕过 parsePack 的"views 不得声明 front"校验。viewNames() 自己必须保证不重复。
  it('dedupes default view', () => {
    expect(viewNames(base({ [DefaultView]: rig('dup.svg') }))).toEqual([DefaultView]);
  });

  // 三视图混合：views 里既有与默认视图重名的 front，也有正常声明的 side、three-quarter。
  it('dedupes default view among mixed views', () => {
    expect(viewNames(base({ [DefaultView]: rig('dup.svg'), side: rig('side.svg'), 'three-quarter': rig('tq.svg') }))).toEqual([
      'front',
      'side',
      'three-quarter',
    ]);
  });
});

describe('yaml decoding follows yaml.v3', () => {
  // 不是 Go 测试的移植：钉住 yaml.v3 的类型错误文案与容错行为（未知键忽略、标量进 string 取原文）。
  it('reports type errors like yaml.v3', () => {
    const body = goodYAML.replace('baselineY: 512', 'baselineY: abc').replace('summary: 面无表情，认真做一件荒诞但成立的事', 'summary: 123\nunknown: 1');
    expect(() => parsePack(writePack(body))).toThrow('解析 character.yaml 失败：yaml: unmarshal errors:\n  line 12: cannot unmarshal !!str `abc` into float64');
    const loose = parsePack(writePack(goodYAML.replace('summary: 面无表情，认真做一件荒诞但成立的事', 'summary: 123\nunknown: 1')));
    expect(loose.summary).toBe('123');
    expect(() => parsePack(writePack(goodYAML.replace('viewBox: [0, 0, 400, 520]', 'viewBox: [0, 0, 400]')))).toThrow(
      'yaml: invalid array: want 4 elements but got 3',
    );
  });
});
