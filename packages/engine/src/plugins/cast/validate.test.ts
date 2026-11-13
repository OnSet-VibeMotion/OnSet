import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { marshalIndent } from '../../gojson';
import { castProblems, setDialogueRelPath } from './validate';
import { tempDir } from '../../validate/testsupport';

/** 最小可自洽角色包清单模板：依次填 id、name、voice 映射下的行。 */
const castPackYAML = (id: string, name: string, voice: string) => `schema: cast/v1
id: ${id}
name: ${name}
summary: 测试角色
voice:
${voice}
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head:     { pivot: [200, 168], rotate: [-18, 18] }
    frontLeg: { pivot: [176, 330], rotate: [-40, 55] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
`;

const castPackSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520">
  <g id="j-head"><circle cx="200" cy="168" r="60" fill="#fff" stroke="#000" stroke-width="6"/></g>
  <g id="j-frontLeg"><path d="M176 330 L176 420" stroke="#000" stroke-width="6"/></g>
</svg>
`;

/** 在 dir 下写出 character.yaml + rig.svg，withDNA 为假时不写 dna.md。 */
function writeCastPack(dir: string, id: string, name: string, voiceLines: string[], withDNA: boolean): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character.yaml'), castPackYAML(id, name, voiceLines.join('\n')));
  fs.writeFileSync(path.join(dir, 'rig.svg'), castPackSVG);
  if (withDNA) fs.writeFileSync(path.join(dir, 'dna.md'), '# ' + name + ' 角色 DNA\n');
}

const bothVoiceLines = ['  minimax: { voiceId: "v-1", speed: 0.98 }', '  bailian: { voiceId: "v-2", rate: 0.98 }'];

const voiceLinesWithout = (provider: string) => bothVoiceLines.filter((line) => !line.trim().startsWith(provider + ':'));

interface CastDialogueLine {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

const defaultCastLines: CastDialogueLine[] = [
  { speaker: 'heiwa', startSeconds: 0, endSeconds: 1, text: '台词一' },
  { speaker: 'zhaocai', startSeconds: 1, endSeconds: 2, text: '台词二' },
  { speaker: 'heiwa', startSeconds: 2, endSeconds: 3, text: '台词三' },
  { speaker: 'zhaocai', startSeconds: 3, endSeconds: 4, text: '台词四' },
];

function writeDialogueJSON(file: string, lines: CastDialogueLine[]): void {
  const payload = {
    schema: 'cast-dialogue/v1',
    segments: null,
    lines: lines.length === 0 ? null : lines.map((line, i) => ({ srtIndex: i + 1, speaker: line.speaker, startSeconds: line.startSeconds, endSeconds: line.endSeconds })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, marshalIndent(payload));
}

function clockTC(seconds: number): string {
  let total = Math.trunc(seconds * 1000 + 0.5);
  const ms = total % 1000;
  total = Math.trunc(total / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.trunc(total / 3600))}:${p(Math.trunc((total % 3600) / 60))}:${p(total % 60)},${p(ms, 3)}`;
}

function writeCastSRT(file: string, lines: CastDialogueLine[]): void {
  let body = '';
  lines.forEach((line, i) => {
    body += `${i + 1}\n${clockTC(line.startSeconds)} --> ${clockTC(line.endSeconds)}\n${line.text}\n\n`;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** cast.beats 用的最小描述，时间是镜头本地时间。 */
interface CastSceneBeat {
  speaker: string;
  start: number;
  end: number;
}

interface CastSceneSpec {
  id: string;
  durationSeconds: number;
  beats?: CastSceneBeat[];
  /** 该角色 id 在这个镜头的本地角色包目录不写 dna.md。 */
  skipDNAFor?: string;
}

/** 写出一个完整可通过 scene.load 的镜头：cast.pack_dir 指向镜头目录内自带的一份角色包拷贝。 */
function writeCastScene(scenesDir: string, spec: CastSceneSpec): void {
  const dir = path.join(scenesDir, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.txt'), '占位');
  writeCastPack(path.join(dir, 'cast-pack', 'heiwa'), 'heiwa', '黑娃', bothVoiceLines, spec.skipDNAFor !== 'heiwa');
  writeCastPack(path.join(dir, 'cast-pack', 'zhaocai'), 'zhaocai', '招财', bothVoiceLines, spec.skipDNAFor !== 'zhaocai');
  const beats = spec.beats ?? [];
  const sceneJSON = {
    id: spec.id,
    duration_seconds: spec.durationSeconds,
    output: 'out.mp4',
    transcript: 'transcript.txt',
    text: '占位文案',
    cast: {
      pack_dir: 'cast-pack',
      ground_y: 0.78,
      on_stage: [
        { id: 'heiwa', x: 0.3, pose: 'idle', facing: 'right' },
        { id: 'zhaocai', x: 0.7, pose: 'idle', facing: 'left' },
      ],
      beats: beats.length === 0 ? null : beats.map((b) => ({ speaker: b.speaker, start: b.start, end: b.end })),
    },
  };
  fs.writeFileSync(path.join(dir, 'scene.json'), marshalIndent(sceneJSON));
}

const defaultCastScenes: CastSceneSpec[] = [
  { id: 'scene-001', durationSeconds: 2, beats: [{ speaker: 'heiwa', start: 0, end: 1 }, { speaker: 'zhaocai', start: 1, end: 2 }] },
  { id: 'scene-002', durationSeconds: 2, beats: [{ speaker: 'heiwa', start: 0, end: 1 }, { speaker: 'zhaocai', start: 1, end: 2 }] },
];

/** castProject 的可选缺陷注入点，每个选项各自破坏一处。 */
interface CastFixtureOptions {
  dropVoiceFromHeiwa: string;
  dialogueLines: CastDialogueLine[];
  srtLines: CastDialogueLine[];
  scenes: CastSceneSpec[];
  emptyRoster: boolean;
  dropRosterDNAFor: string;
}

type Option = (o: CastFixtureOptions) => void;

const withoutVoice = (provider: string): Option => (o) => {
  o.dropVoiceFromHeiwa = provider;
};

const dialogueMissingLastLine = (): Option => (o) => {
  o.dialogueLines = defaultCastLines.slice(0, -1);
};

const sceneMissingBeat = (): Option => (o) => {
  // 去掉 scene-002 里 zhaocai 的那一拍：全局时间线上 3-4 秒（第 4 行）就此没有任何镜头的 cast.beats 覆盖。
  o.scenes = [defaultCastScenes[0], { id: 'scene-002', durationSeconds: 2, beats: [{ speaker: 'heiwa', start: 0, end: 1 }] }];
};

const missingDNAFor = (id: string): Option => (o) => {
  o.scenes = [{ ...defaultCastScenes[0], skipDNAFor: id }, defaultCastScenes[1]];
};

const emptyRoster = (): Option => (o) => {
  o.emptyRoster = true;
};

/** 把最后一行的说话人换成班底里不存在的 ghost。 */
const dialogueSpeakerNotInRoster = (): Option => (o) => {
  const lines = defaultCastLines.map((line) => ({ ...line }));
  lines[lines.length - 1].speaker = 'ghost';
  o.dialogueLines = lines;
  o.srtLines = lines;
};

/** 第 2 行提前 0.5 秒起，与第 1 行重叠 0.5 秒。 */
const dialogueLinesOverlap = (): Option => (o) => {
  const lines = [
    { speaker: 'heiwa', startSeconds: 0, endSeconds: 1, text: '台词一' },
    { speaker: 'zhaocai', startSeconds: 0.5, endSeconds: 2, text: '台词二与上一行重叠' },
    { speaker: 'heiwa', startSeconds: 2, endSeconds: 3, text: '台词三' },
    { speaker: 'zhaocai', startSeconds: 3, endSeconds: 4, text: '台词四' },
  ];
  o.dialogueLines = lines;
  o.srtLines = lines;
};

/** 删掉班底源目录（cast/<id>/）里的 dna.md。 */
const missingDNAFromRosterSource = (id: string): Option => (o) => {
  o.dropRosterDNAFor = id;
};

/** 一句台词横跨镜头切点：zhaocai 的第 2 行 [1,3] 秒被拆成两拍，全局时间换算后首尾相接。 */
const lineSpanningSceneCut = (): Option => (o) => {
  const lines = [
    { speaker: 'heiwa', startSeconds: 0, endSeconds: 1, text: '台词一' },
    { speaker: 'zhaocai', startSeconds: 1, endSeconds: 3, text: '台词二横跨切点' },
    { speaker: 'heiwa', startSeconds: 3, endSeconds: 4, text: '台词三' },
  ];
  o.dialogueLines = lines;
  o.srtLines = lines;
  o.scenes = [
    { id: 'scene-001', durationSeconds: 2, beats: [{ speaker: 'heiwa', start: 0, end: 1 }, { speaker: 'zhaocai', start: 1, end: 2 }] },
    { id: 'scene-002', durationSeconds: 2, beats: [{ speaker: 'zhaocai', start: 0, end: 1 }, { speaker: 'heiwa', start: 1, end: 2 }] },
  ];
};

/** 在上一个的基础上把 scene-002 的 zhaocai 拍错开到 0.2，留下真实缺口。 */
const lineSpanningSceneCutWithGap = (): Option => (o) => {
  lineSpanningSceneCut()(o);
  o.scenes = [o.scenes[0], { id: 'scene-002', durationSeconds: 2, beats: [{ speaker: 'zhaocai', start: 0.2, end: 1 }, { speaker: 'heiwa', start: 1, end: 2 }] }];
};

/** scene-002 的 beats 整个清空。 */
const sceneWithoutBeats = (): Option => (o) => {
  o.scenes = [defaultCastScenes[0], { id: 'scene-002', durationSeconds: 2 }];
};

/** scene-001 声明 2 秒，真实台词用了 2.5 秒：之后所有台词统一偏移 0.5 秒。 */
const sceneDurationDrift = (): Option => (o) => {
  const lines = [
    { speaker: 'heiwa', startSeconds: 0, endSeconds: 1, text: '台词一' },
    { speaker: 'zhaocai', startSeconds: 1, endSeconds: 2, text: '台词二' },
    { speaker: 'heiwa', startSeconds: 2.5, endSeconds: 3.5, text: '台词三' },
    { speaker: 'zhaocai', startSeconds: 3.5, endSeconds: 4.5, text: '台词四' },
  ];
  o.dialogueLines = lines;
  o.srtLines = lines;
  o.scenes = defaultCastScenes;
};

/** 搭一个可通过全部校验的多角色项目，再按 opts 逐个破坏。 */
function castProject(...opts: Option[]): string {
  const options: CastFixtureOptions = {
    dropVoiceFromHeiwa: '',
    dialogueLines: defaultCastLines,
    srtLines: defaultCastLines,
    scenes: defaultCastScenes,
    emptyRoster: false,
    dropRosterDNAFor: '',
  };
  for (const opt of opts) opt(options);
  const root = tempDir();
  const rosterBody = options.emptyRoster
    ? 'schema: cast/v1\npacks: []\ndefaults:\n  ground_y: 0.78\n  gap_ms: { turn: 240, interject: 100 }\n'
    : 'schema: cast/v1\npacks: [cast/heiwa, cast/zhaocai]\ndefaults:\n  ground_y: 0.78\n  gap_ms: { turn: 240, interject: 100 }\n';
  fs.writeFileSync(path.join(root, 'cast.yaml'), rosterBody);
  const heiwaVoices = options.dropVoiceFromHeiwa !== '' ? voiceLinesWithout(options.dropVoiceFromHeiwa) : bothVoiceLines;
  writeCastPack(path.join(root, 'cast', 'heiwa'), 'heiwa', '黑娃', heiwaVoices, true);
  writeCastPack(path.join(root, 'cast', 'zhaocai'), 'zhaocai', '招财', bothVoiceLines, true);
  if (options.dropRosterDNAFor !== '') fs.rmSync(path.join(root, 'cast', options.dropRosterDNAFor, 'dna.md'));
  writeDialogueJSON(path.join(root, 'production', 'dialogue.json'), options.dialogueLines);
  writeCastSRT(path.join(root, 'transcription-production.srt'), options.srtLines);
  for (const spec of options.scenes) writeCastScene(path.join(root, 'scenes'), spec);
  return root;
}

const joined = (problems: string[] | null) => (problems ?? []).join('\n');

describe('castProblems', () => {
  it('is null without a roster', () => {
    expect(castProblems(tempDir(), 'minimax')).toBeNull();
  });

  it('has no problems for a valid project', () => {
    expect(castProblems(castProject(), 'minimax') ?? []).toEqual([]);
  });

  // 班底里的角色没有当前 TTS_PROVIDER 的音色时必须失败。
  it('reports a roster missing the voice for the provider', () => {
    expect(joined(castProblems(castProject(withoutVoice('bailian')), 'bailian'))).toContain('bailian');
  });

  it('checks that the dialogue covers every SRT line', () => {
    expect(joined(castProblems(castProject(dialogueMissingLastLine()), 'minimax'))).toContain('字幕');
  });

  // spec §7.3：dialogue.json 的说话人必须都在班底内。
  it('requires dialogue speakers to be in the roster', () => {
    expect(joined(castProblems(castProject(dialogueSpeakerNotInRoster()), 'minimax'))).toContain('不在班底里');
  });

  // spec §7.3：dialogue.json 逐行不得重叠。
  it('requires dialogue lines not to overlap', () => {
    expect(joined(castProblems(castProject(dialogueLinesOverlap()), 'minimax'))).toContain('与上一行重叠');
  });

  it('checks that scene beats cover the dialogue', () => {
    // 断言完整短语而不是"镜头"两个字：「读取镜头目录失败」里也含"镜头"。
    expect(joined(castProblems(castProject(sceneMissingBeat()), 'minimax'))).toContain('没有被任何镜头的 cast.beats 覆盖');
  });

  // 一句台词按语义拆镜头切成两拍、换算回全局时间后首尾相接，这是正常产物。
  it('does not misreport a line spanning a scene cut', () => {
    expect(castProblems(castProject(lineSpanningSceneCut()), 'minimax') ?? []).toEqual([]);
  });

  // 合并逻辑不会把真实缺口也糊过去。
  it('still reports a gap in a line spanning a scene cut', () => {
    expect(joined(castProblems(castProject(lineSpanningSceneCutWithGap()), 'minimax'))).toContain('第 2 行');
  });

  // 有台词行没被盖住时，逐行报告之外要追加一条确定性的出路。
  it('points uncovered lines at the beats command', () => {
    const text = joined(castProblems(castProject(sceneDurationDrift()), 'minimax'));
    expect(text).toContain('第 3 行');
    expect(text).toContain('第 4 行');
    expect(text).toContain('dialogue_beats()');
  });

  // 某个镜头压根没写 beats 时，不得给出"时长累计漂移"的结论。
  it('does not misreport a scene without beats as drift', () => {
    const text = joined(castProblems(castProject(sceneWithoutBeats()), 'minimax'));
    expect(text).toContain('第 3 行');
    expect(text).toContain('第 4 行');
    expect(text).not.toContain('时长累计漂移');
    expect(text).toContain('dialogue_beats()');
  });

  it('has no beats hint for a clean project', () => {
    expect(joined(castProblems(castProject(), 'minimax'))).not.toContain('dialogue_beats()');
  });

  it('reports an empty roster', () => {
    expect(joined(castProblems(castProject(emptyRoster()), 'minimax'))).toContain('班底为空');
  });

  it('reports a scene actor missing dna.md', () => {
    expect(joined(castProblems(castProject(missingDNAFor('zhaocai')), 'minimax'))).toContain('dna.md');
  });

  // 班底源目录自己的 dna.md 被误删时必须报——即便镜头引用的 pack_dir 拷贝仍然完好。
  it('reports a roster source missing dna.md', () => {
    const text = joined(castProblems(castProject(missingDNAFromRosterSource('zhaocai')), 'minimax'));
    expect(text).toContain('dna.md');
    expect(text).toContain('zhaocai');
  });

  // 钉住"错误信息硬编码路径"这条缺陷的修复：换成标记值后报错要引用它。
  it('uses the DialogueRelPath constant in errors', () => {
    const root = castProject();
    const marker = 'MUTATED-MARKER-DIR/dialogue.json';
    const original = setDialogueRelPath(marker);
    onTestFinished(() => {
      setDialogueRelPath(original);
    });
    const text = joined(castProblems(root, 'minimax'));
    expect(text).toContain(marker);
    expect(text).not.toContain('production/dialogue.json');
  });
});
