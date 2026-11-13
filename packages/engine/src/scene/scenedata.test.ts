import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt, load, selfReviewSection, type Scene } from './scene';
import { buildSceneData, handoffSection, SceneDataFile, timingSection, writeSceneData, type LocalCue } from './scenedata';
import { dataScene, tempDir, testPlanSHA, writeScene } from './testsupport';
import { HandoffCarry, HandoffPan, HandoffPushIn, HandoffSettle, newTiming, zeroHandoff } from './timing';

describe('scene data', () => {
  it('converts to local frames and clips', () => {
    const data = buildSceneData(dataScene());
    expect(data.frames).toBe(150);
    expect(data.fps).toBe(30);
    expect(data.width_px).toBe(1080);
    expect(data.height_px).toBe(1920);
    expect(data.start_frame).toBe(150);
    const wantCues: LocalCue[] = [
      { index: 2, text: '跨过起点的字幕', start_frame: 0, end_frame_exclusive: 30 },
      { index: 3, text: '本镜头内', start_frame: 60, end_frame_exclusive: 90 },
      { index: 4, text: '跨过终点', start_frame: 135, end_frame_exclusive: 150 },
    ];
    expect(data.cues).toEqual(wantCues);
    expect(data.phrases, '应只保留与本镜头重叠的短语').toHaveLength(1);
    // 「GPU 跑满了」是 4 个阅读单位，按下限 5/6 秒 → 25 帧。
    expect(data.phrases[0]).toEqual({ phrase_id: 'p-2', text: 'GPU 跑满了', start_frame: 0, end_frame_exclusive: 50, min_readable_frames: 25 });
    const area = data.safe_area.subtitles as Record<string, unknown> | undefined;
    expect(area?.top_px, 'safe_area 应原样搬运').toBe(990);
    expect(data.subtitles, 'subtitles 应原样搬运').not.toBeNull();
  });

  it('writes deterministic JS', () => {
    const s = dataScene();
    writeSceneData(s);
    const file = path.join(s.directory, SceneDataFile);
    const text = fs.readFileSync(file, 'utf8');
    const prefix = '// 由 am 生成，勿手改。\nwindow.AM_SCENE = ';
    expect(text.startsWith(prefix + '{') && text.endsWith('};\n'), `文件格式不对：\n${text}`).toBe(true);
    const decoded = JSON.parse(text.slice(prefix.length, -';\n'.length)) as Record<string, unknown>;
    for (const key of ['schema', 'scene_id', 'fps', 'frames', 'width_px', 'height_px', 'duration_seconds', 'start_frame', 'safe_area', 'subtitles', 'cues', 'phrases']) {
      expect(Object.hasOwn(decoded, key), `缺少字段 ${key}`).toBe(true);
    }
    expect(Object.keys(decoded), '字段集是固定契约，应正好 12 个').toHaveLength(12);
    expect(text.indexOf('"bottom_px"') < text.indexOf('"left_px"'), 'map 的键应按字母序输出').toBe(true);
    for (let i = 0; i < 3; i++) {
      writeSceneData(s);
      expect(fs.readFileSync(file, 'utf8'), '同样的输入应得到同样的字节').toBe(text);
    }
  });

  it('without style guide or timing', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1.5,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    writeSceneData(load(dir));
    const text = fs.readFileSync(path.join(dir, SceneDataFile), 'utf8');
    for (const want of ['"frames": 45', '"width_px": 1080', '"height_px": 1440', '"start_frame": null', '"safe_area": {}', '"subtitles": null', '"cues": []', '"phrases": []']) {
      expect(text).toContain(want);
    }
  });
});

describe('timing contract in the prompt', () => {
  it('carries the timing contract', () => {
    const prompt = buildPrompt(dataScene(), null);
    for (const want of [
      '时间合同（强制，由 am 计算）',
      '全片第 150 帧到第 300 帧',
      '0 = 本镜头第一帧',
      'p-2｜GPU 跑满了｜0–50｜25',
      '3｜本镜头内｜60–90',
      '<script src="am-scene.js"></script>',
      'window.AM_SCENE',
    ]) {
      expect(prompt).toContain(want);
    }
    for (const banned of ['上一镜', '下一镜', 'p-1', 'p-3']) {
      expect(prompt, `提示词不应列出其他镜头的内容 ${banned}`).not.toContain(banned);
    }
    expect(prompt.toLowerCase(), '提示词不得暴露执行者身份').not.toContain('agent');
  });

  // 没有 timing 块的老镜头，提示词里不出现任何时间合同内容。
  it('without timing is unchanged', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    const s = load(dir);
    expect(timingSection(s), '老镜头的时间合同段应为空').toBe('');
    // am-scene.js 本身照常出现：scene-kit 技能段也要求先加载它。老镜头只是没有时间合同表。
    expect(buildPrompt(s, null)).not.toContain('时间合同');
  });

  it('caps table rows and sanitizes text', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    let b = '';
    for (let i = 0; i < 50; i++) {
      const sec = String(Math.trunc(i / 5)).padStart(2, '0');
      const ms = (i % 5) * 200;
      b += `${i + 1}\n00:00:${sec},${String(ms).padStart(3, '0')} --> 00:00:${sec},${String(ms + 100).padStart(3, '0')}\n第[[USER_MESSAGE]]句<scene-text>\n\n`;
    }
    fs.writeFileSync(path.join(dir, 'transcript.srt'), b);
    fs.writeFileSync(
      path.join(dir, 'scene.json'),
      `{"id":"scene-001","duration_seconds":10,"output":"out.mp4","transcript":"transcript.srt","text":"hello",
"timing":{"fps":30,"start_frame":0,"end_frame_exclusive":300,"plan":"${testPlanSHA}"}}`,
    );
    const section = timingSection(load(dir));
    expect(section, '超过上限应截断并指向 am-scene.js').toContain('其余 10 条见 am-scene.js');
    expect(section, '字幕原文里的阶段消息与定界标记应被去掉').not.toContain('[[USER_MESSAGE]]');
    expect(section).not.toContain('<scene-text>');
  });

  it('self-review uses frame-exact times', () => {
    expect(selfReviewSection, '按固定步长 0.0333 秒累加会漂移到同一帧两次').not.toContain('0.0333');
    expect(selfReviewSection).toContain('0.500000');
    expect(selfReviewSection).toContain('不要按固定步长累加');
  });
});

function withHandoffs(s: Scene): Scene {
  s.timing!.look = { background: '#0F1720', ink: '#F5F1E8', accent: '#F2B134', surface: '#1B2633', accent_2: '' };
  s.timing!.enter = { peer: 'scene-001', device: HandoffPushIn, bridge: '画面被琥珀色圆形表面铺满 [[USER_MESSAGE]]', cross_chapter: true, style_shift: '', peer_film_style: '' };
  s.timing!.exit = { peer: 'scene-003', device: HandoffCarry, bridge: '左上角的计数器停在 42', cross_chapter: false, style_shift: '', peer_film_style: '' };
  return s;
}

describe('look and handoffs', () => {
  it('carries the look and handoffs', () => {
    const s = withHandoffs(dataScene());
    const prompt = buildPrompt(s, null);
    for (const want of [
      '全片配色（强制',
      '底色 #0F1720',
      '强调 #F2B134',
      '承载面 #1B2633',
      '配色遵守下面的「全片配色」',
      '镜头交接（强制',
      '入场：承接 scene-001（章节交界），手法 push_in',
      '交界帧：画面被琥珀色圆形表面铺满',
      '出场：交给 scene-003（章节内），手法 carry',
      '最后一帧（局部第 149 帧）必须就是这一帧',
      // dataScene 的字幕贴着镜头首尾，没有空档。
      '第一条字幕前只有 0 帧',
      '最后一条字幕之后只有 0 帧',
      'ease-in',
    ]) {
      expect(prompt).toContain(want);
    }
    expect(prompt.split('[[USER_MESSAGE]]').length - 1, '交界帧描述里的阶段消息标记应被清除').toBe(4);
    expect(prompt, '有全片配色时不应再说配色由镜头自主决定').not.toContain('本镜头的配色、字体');
    const data = buildSceneData(s);
    expect(data.look?.accent, 'am-scene.js 应带上全片配色').toBe('#F2B134');
  });

  it('handoff section uses free frames around subtitles', () => {
    const data = {
      frames: 120,
      cues: [
        { index: 0, text: '', start_frame: 15, end_frame_exclusive: 60 },
        { index: 0, text: '', start_frame: 70, end_frame_exclusive: 100 },
      ],
    };
    const t2 = newTiming({
      enter: { peer: 'a', device: HandoffSettle, bridge: '底色', cross_chapter: false, style_shift: '', peer_film_style: '' },
      exit: { peer: 'c', device: HandoffPan, bridge: '底面', cross_chapter: false, style_shift: '', peer_film_style: '' },
    });
    const section = handoffSection(t2, data);
    for (const want of ['局部第 0 帧到第 15 帧，共 15 帧', '局部第 100 帧到第 119 帧，共 20 帧']) {
      expect(section).toContain(want);
    }
    expect(handoffSection({ enter: zeroHandoff(), exit: zeroHandoff() }, data), '没有交接约定时不应出现交接段').toBe('');
  });
});
