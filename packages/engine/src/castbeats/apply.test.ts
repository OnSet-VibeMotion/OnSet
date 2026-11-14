import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { marshalIndent, sortedKeys } from '../gojson';
import { goQuote, formatG } from '../gofmt';
import * as scene from '../scene';
import { apply, DialogueRelPath, loadDialogueLines, setDialogueRelPath } from './apply';

const packYAML = (id: string, name: string) => `schema: cast/v1
id: ${id}
name: ${name}
summary: 测试角色
voice:
  minimax: { voiceId: "v-1", speed: 0.98 }
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head:     { pivot: [200, 168], rotate: [-18, 18] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
`;

const packSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520">
  <g id="j-head"><circle cx="200" cy="168" r="60" fill="#fff" stroke="#000" stroke-width="6"/></g>
</svg>
`;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-castbeats-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function writePack(dir: string, id: string, name: string): void {
  write(path.join(dir, 'character.yaml'), packYAML(id, name));
  write(path.join(dir, 'rig.svg'), packSVG);
  write(path.join(dir, 'dna.md'), '# ' + name + '\n');
}

/** 写出一份最小 dialogue.json，lines 依次是 speaker/start/end 三元组。 */
function writeDialogue(root: string, ...lines: (string | number)[]): void {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < lines.length; i += 3) {
    rows.push(sortedKeys({ srtIndex: i / 3 + 1, speaker: lines[i], startSeconds: lines[i + 1], endSeconds: lines[i + 2] }));
  }
  write(path.join(root, 'production', 'dialogue.json'), marshalIndent(sortedKeys({ schema: 'cast-dialogue/v1', lines: rows })));
}

/** 写出一个镜头目录：transcript 占位文件、一份角色包拷贝、scene.json。castBlock 传空串表示不带 cast 块。 */
function writeScene(root: string, id: string, duration: number, castBlock: string): string {
  const dir = path.join(root, 'scenes', id);
  write(path.join(dir, 'transcript.txt'), '占位');
  writePack(path.join(dir, 'cast-pack', 'heiwa'), 'heiwa', '黑娃');
  writePack(path.join(dir, 'cast-pack', 'zhaocai'), 'zhaocai', '招财');
  const body = `{
  "id": ${goQuote(id)},
  "duration_seconds": ${formatG(duration)},
  "output": "out.mp4",
  "transcript": "transcript.txt",
  "text": "占位文案 引号\\" 与反斜杠\\\\ 都要原样留着"${castBlock}
}
`;
  write(path.join(dir, 'scene.json'), body);
  return path.join(dir, 'scene.json');
}

const castBlockNoBeats = `,
  "cast": {
    "pack_dir": "cast-pack",
    "ground_y": 0.78,
    "on_stage": [
      {"id": "heiwa", "x": 0.3, "pose": "idle", "facing": "right"}
    ]
  }`;

const castBlockEmptyOnStage = `,
  "cast": {
    "pack_dir": "cast-pack",
    "ground_y": 0.78,
    "on_stage": []
  }`;

const read = (file: string) => fs.readFileSync(file, 'utf8');

/** 多角色项目根：只放一个 cast.yaml（本命令只看它存在与否）。 */
function castProject(): string {
  const root = tempDir();
  write(path.join(root, 'cast.yaml'), 'schema: cast/v1\npacks: []\n');
  return root;
}

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('期待报错，得到 nil');
}

describe('apply', () => {
  // 主路径：cast 块里原本没有 beats，跑完之后 beats 出现且是镜头本地时间，其余一个字符都不许变。
  it('writes beats and keeps other fields', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0, 'zhaocai', 1.0, 2.5);
    const file = writeScene(root, 'scene-001', 1.0, castBlockNoBeats);
    writeScene(root, 'scene-002', 1.5, castBlockNoBeats);
    const report = apply(root);
    expect(report.lines).toBe(2);
    const got = read(file);
    expect(got).toContain('"beats": [');
    expect(got).toContain('"speaker": "heiwa"');
    expect(got).toContain('"pack_dir": "cast-pack"');
    expect(got).toContain('"ground_y": 0.78');
    expect(got).toContain('"pose": "idle"');
    expect(got).toContain('"facing": "right"');
    expect(got).toContain('引号\\" 与反斜杠\\\\');
    const second = read(path.join(root, 'scenes', 'scene-002', 'scene.json'));
    expect(second).toContain('"start": 0');
    expect(second).toContain('"end": 1.5');
  });

  // 幂等的前提：已有 beats（哪怕是错的）要被整体重写，而不是追加或跳过。
  it('overwrites existing beats', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0);
    const stale = `,
  "cast": {
    "pack_dir": "cast-pack",
    "ground_y": 0.78,
    "on_stage": [],
    "beats": [
      {"speaker": "zhaocai", "start": 0.1, "end": 0.9}
    ]
  }`;
    const file = writeScene(root, 'scene-001', 1.0, stale);
    apply(root);
    const got = read(file);
    expect(got).not.toContain('zhaocai');
    expect(got.split('"speaker"').length - 1).toBe(1);
  });

  it('is idempotent', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0, 'heiwa', 1.0, 2.0);
    const file = writeScene(root, 'scene-001', 1.2, castBlockNoBeats);
    writeScene(root, 'scene-002', 0.8, castBlockNoBeats);
    apply(root);
    const first = read(file);
    const report = apply(root);
    expect(read(file)).toBe(first);
    expect(report.updated).toBe(0);
  });

  // 带 cast 块但整段没人说话的镜头：写空数组，而不是把 beats 键留空缺。
  it('gives a silent scene empty beats', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0);
    writeScene(root, 'scene-001', 1.0, castBlockNoBeats);
    const file = writeScene(root, 'scene-002', 2.0, castBlockNoBeats);
    apply(root);
    expect(read(file)).toContain('"beats": []');
  });

  // 画外音：说话人不在 on_stage 里同样要出节拍。
  it('keeps a voice-over speaker', () => {
    const root = castProject();
    writeDialogue(root, 'zhaocai', 0.0, 1.0);
    const file = writeScene(root, 'scene-001', 1.0, castBlockEmptyOnStage);
    apply(root);
    expect(read(file)).toContain('"speaker": "zhaocai"');
  });

  // 有台词盖过、却没有 cast 块的镜头：命令不能替 agent 编 pack_dir / ground_y，只能点名报错。
  it('rejects a covered scene without a cast block', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0);
    writeScene(root, 'scene-001', 1.0, '');
    const err = errorOf(() => apply(root));
    expect(err.message).toContain('scene-001');
    expect(err.message).toContain('cast 块');
  });

  // 镜头时长之和短于对白：不能截断，要报错，且一个 scene.json 都不许改。
  it('rejects a line beyond the scenes', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0, 'heiwa', 1.0, 3.0);
    const file = writeScene(root, 'scene-001', 1.5, castBlockNoBeats);
    const before = read(file);
    const err = errorOf(() => apply(root));
    expect(err.message).toContain('第 2 行');
    expect(err.message).toContain('duration_seconds');
    expect(read(file)).toBe(before);
  });

  it('rejects a missing dialogue', () => {
    const root = castProject();
    writeScene(root, 'scene-001', 1.0, castBlockNoBeats);
    expect(errorOf(() => apply(root)).message).toContain('dialogue.json');
  });

  // 输入本身就有重叠时，切出来的节拍必然重叠，写进 scene.json 会被 scene.load 拒绝。
  it('rejects overlapping lines', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.2, 'zhaocai', 1.0, 2.0);
    writeScene(root, 'scene-001', 2.0, castBlockNoBeats);
    expect(errorOf(() => apply(root)).message).toContain('重叠');
  });

  // 钉住跨模块容差错配的修复：6e-7 秒的重叠落在 (1e-9, 1e-6] 区间，必须在这里就被拒绝。
  it('rejects a tiny overlap between floatEps and minBeatSeconds', () => {
    const root = castProject();
    // heiwa 止于 1.0000006，zhaocai 起于 1.0——重叠恰好 6e-7 秒。
    writeDialogue(root, 'heiwa', 0.0, 1.0000006, 'zhaocai', 1.0, 2.0);
    writeScene(root, 'scene-001', 2.0, castBlockNoBeats);
    const err = errorOf(() => apply(root));
    expect(err.message).toContain('重叠');
    // 幂等：重跑必须得到完全相同的拒绝。
    expect(errorOf(() => apply(root)).message).toBe(err.message);
  });

  // 老模式零破坏：没有 cast 块、也没有台词盖过的镜头，scene.json 一个字节都不许动。
  it('leaves plain scenes alone', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0);
    writeScene(root, 'scene-001', 1.0, castBlockNoBeats);
    const file = writeScene(root, 'scene-002', 2.0, '');
    const before = read(file);
    apply(root);
    expect(read(file)).toBe(before);
  });

  // on_stage 和 beats 都是空数组的组合是本命令的正常产物，不是坏输入。
  it('produces empty on_stage with empty beats for a coverage-free scene', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0);
    writeScene(root, 'scene-001', 1.0, castBlockNoBeats);
    const file = writeScene(root, 'scene-002', 1.0, castBlockEmptyOnStage);
    apply(root);
    const body = read(file);
    expect(body).toContain('"on_stage": []');
    expect(body).toContain('"beats": []');
  });

  // 老项目误跑到这条命令时，要说清"本项目不是多角色项目"，而不是甩一句"找不到 dialogue.json"。
  it('rejects a non-cast project', () => {
    const root = tempDir(); // 故意不建 cast.yaml
    writeDialogue(root, 'heiwa', 0.0, 1.0);
    writeScene(root, 'scene-001', 1.0, castBlockNoBeats);
    const err = errorOf(() => apply(root));
    expect(err.message).toContain('cast.yaml');
    expect(err.message).toContain('不是多角色项目');
    expect(err.message).not.toContain('dialogue.json');
  });

  // 钉住死锁：duration_seconds 改小、旧 beats 还越界时，本命令不能跟着 scene.load 把自己锁在门外。
  it('ignores stale out-of-range beats', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0, 'heiwa', 1.0, 2.0);
    const stale = `,
  "cast": {
    "pack_dir": "cast-pack",
    "ground_y": 0.78,
    "on_stage": [
      {"id": "heiwa", "x": 0.3, "pose": "idle", "facing": "right"}
    ],
    "beats": [
      {"speaker": "heiwa", "start": 0, "end": 1.9}
    ]
  }`;
    // 这一镜原本 2.0 秒（旧节拍止于 1.9 合法），现在被改小到 1.0 秒。
    const file = writeScene(root, 'scene-001', 1.0, stale);
    writeScene(root, 'scene-002', 1.0, castBlockNoBeats);
    // 前提核实：这份 scene.json 现在确实加载不了。
    expect(() => scene.load(path.dirname(file))).toThrow();
    apply(root);
    const loaded = scene.load(path.dirname(file));
    expect(loaded.cast?.beats).toEqual([{ speaker: 'heiwa', start: 0, end: 1.0 }]);
    const second = scene.load(path.join(root, 'scenes', 'scene-002'));
    expect(second.cast?.beats?.length).toBe(1);
    expect(second.cast?.beats?.[0].end).toBe(1.0);
  });

  // 轻量解析放弃了 scene.load 的完整校验，但它自己要用的字段仍然要查。
  it('rejects a scene without duration', () => {
    const root = castProject();
    writeDialogue(root, 'heiwa', 0.0, 1.0);
    write(
      path.join(root, 'scenes', 'scene-001', 'scene.json'),
      '{"id":"scene-001","output":"out.mp4","transcript":"transcript.txt","text":"占位"}',
    );
    expect(errorOf(() => apply(root)).message).toContain('duration_seconds');
  });
});

// 钉住"错误信息硬编码路径"这条缺陷的修复：把 DialogueRelPath 换成标记值，逐一触发每条报错分支。
describe('loadDialogueLines errors use the DialogueRelPath constant', () => {
  const marker = 'MUTATED-MARKER-DIR/dialogue.json';
  const withMarker = () => {
    const original = setDialogueRelPath(marker);
    onTestFinished(() => {
      setDialogueRelPath(original);
    });
    expect(DialogueRelPath).toBe(marker);
  };
  const assertUsesMarker = (err: Error) => {
    expect(err.message).toContain(marker);
    expect(err.message).not.toContain('production/dialogue.json');
  };
  const lines = (body: string) => {
    withMarker();
    const p = path.join(tempDir(), marker);
    write(p, body);
    assertUsesMarker(errorOf(() => loadDialogueLines(p)));
  };

  it('找不到文件', () => {
    withMarker();
    assertUsesMarker(errorOf(() => loadDialogueLines(path.join(tempDir(), marker))));
  });
  it('不是合法JSON', () => lines('不是 JSON'));
  it('schema不对', () => lines('{"schema":"wrong","lines":[]}'));
  it('没有任何行', () => lines('{"schema":"cast-dialogue/v1","lines":[]}'));
  it('时间倒挂', () =>
    lines(`{"schema":"cast-dialogue/v1","lines":[
			{"srtIndex":1,"speaker":"heiwa","startSeconds":1.0,"endSeconds":0.5}
		]}`));
  it('与上一行重叠', () =>
    lines(`{"schema":"cast-dialogue/v1","lines":[
			{"srtIndex":1,"speaker":"heiwa","startSeconds":0.0,"endSeconds":1.2},
			{"srtIndex":2,"speaker":"zhaocai","startSeconds":1.0,"endSeconds":2.0}
		]}`));
  it('有台词行没有被任何镜头盖住', () => {
    withMarker();
    const root = castProject();
    write(
      path.join(root, marker),
      `{"schema":"cast-dialogue/v1","lines":[
			{"srtIndex":1,"speaker":"heiwa","startSeconds":0.0,"endSeconds":3.0}
		]}`,
    );
    writeScene(root, 'scene-001', 1.0, castBlockNoBeats);
    assertUsesMarker(errorOf(() => apply(root)));
  });
});
