import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MissingToolPrefix } from '../envutil';
import {
  AudioAbsent,
  AudioIgnore,
  AudioPresent,
  ReportSchemaVersion,
  audioStream,
  checkSpec,
  isBlank,
  isDark,
  isFlat,
  meanAbsoluteDifference,
  parse,
  parseRational,
  validateSpec,
  videoFPS,
  videoStream,
  writeReportJSON,
  type Media,
  type Spec,
} from './mediaprobe';
import { ffmpeg, hasFfmpeg, sample, tempDir, toolchain } from './testutil';
import { newToolchain } from './toolchain';

/**
 * ffprobe 7.0 对一条真实 h264/yuv420p 视频的实际输出。
 *
 * 逐字保留而不是手写简化版：数字字段和字符串字段在 ffprobe 里是混着来的
 * （width 是数字，nb_frames 和 duration 是字符串），照猜写解析必然出错。
 */
const realProbeOutput = `{
    "streams": [
        {
            "index": 0,
            "codec_name": "h264",
            "codec_type": "video",
            "width": 1080,
            "height": 1440,
            "pix_fmt": "yuv420p",
            "r_frame_rate": "30/1",
            "avg_frame_rate": "30/1",
            "duration": "2.833000",
            "bit_rate": "58024",
            "nb_frames": "85"
        },
        {
            "index": 1,
            "codec_name": "aac",
            "codec_type": "audio",
            "sample_rate": "48000",
            "channels": 2
        }
    ],
    "format": {
        "filename": "scene-001.mp4",
        "nb_streams": 2,
        "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
        "duration": "2.833000",
        "size": "8487"
    }
}`;

describe('parse', () => {
  it('reads real ffprobe field types', () => {
    const media = parse(realProbeOutput, 'scene-001.mp4');
    expect(media.duration_seconds).toBe(2.833);
    const v = media.video!;
    expect(v).not.toBeNull();
    expect([v.codec, v.width_px, v.height_px, v.pixel_format]).toEqual(['h264', 1080, 1440, 'yuv420p']);
    // nb_frames 是字符串字段。
    expect(v.nb_frames).toBe(85);
    // 由 r_frame_rate 的分数解析。
    expect(videoFPS(v)).toBe(30);
    // 流级 duration 是字符串。
    expect(v.duration_seconds).toBe(2.833);
    expect(media.audio).not.toBeNull();
    expect(media.audio!.sample_rate).toBe(48000);
    expect(media.audio!.channels).toBe(2);
    // 音频流没声明时长时应为 0。
    expect(media.audio!.duration_seconds).toBe(0);
  });

  it('handles missing optional fields', () => {
    // 没有音轨、容器没声明 nb_frames——静音母版的常见形态，不该报错。
    const body = `{"streams":[{"codec_type":"video","codec_name":"h264","width":1080,"height":1440,
	"pix_fmt":"yuv420p","r_frame_rate":"30/1"}],"format":{"duration":"1.5"}}`;
    const media = parse(body, 'x.mp4');
    expect(media.audio).toBeNull();
    expect(media.video!.nb_frames).toBe(0);
  });

  it('allows audio-only file', () => {
    // 纯音频文件是合法形态：dialogue 包的 TTS 片段、静音、拼接产物都没有视频流。
    const body = `{"streams":[{"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}],
	"format":{"duration":"1.0"}}`;
    const media = parse(body, 'x.m4a');
    expect(media.video).toBeNull();
    expect(media.audio).toMatchObject({ sample_rate: 48000, channels: 2 });
  });

  it('rejects file without any stream', () => {
    expect(() => parse('{"streams":[],"format":{"duration":"1.0"}}', 'x.bin')).toThrow('x.bin 没有可识别的音视频流');
  });

  it('rejects malformed JSON', () => {
    expect(() => parse('not json', 'x.mp4')).toThrow(/^ffprobe 输出不是合法 JSON：/);
  });
});

// ffprobe 用分数表示帧率，29.97 会写成 30000/1001，不能按整数比较。
it('FPS parses rational representations', () => {
  const cases: Record<string, number> = {
    '30/1': 30,
    '30000/1001': 29.97002997002997,
    '25/1': 25,
    '60/1': 60,
    '0/0': 0,
    '': 0,
    garbage: 0,
    '1/0': 0,
    '60000/1001': 59.94005994005994,
    '2997/100': 29.97,
  };
  for (const [input, want] of Object.entries(cases)) {
    expect(Math.abs(parseRational(input) - want), input).toBeLessThanOrEqual(1e-9);
  }
});

describe('checkSpec', () => {
  // 这是这个包的核心设计保证。验收门每次只报一条，调用方就得「修一条、重跑一次、
  // 再发现下一条」，一次完整成片检查要循环好几轮。全部报出来才能一次修完。
  it('reports every violation, not just the first', () => {
    const media: Media = {
      path: '',
      duration_seconds: 5.0,
      video: videoStream({ codec: 'vp9', width_px: 720, height_px: 1280, pixel_format: 'yuv444p', fps_num: 25, fps_den: 1, nb_frames: 125 }),
      audio: audioStream({ codec: 'aac', sample_rate: 44100, channels: 1 }),
    };
    const spec: Spec = {
      widthPx: 1080,
      heightPx: 1440,
      fps: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      durationSeconds: 2.833,
      tolerance: 0.1,
      audio: AudioAbsent,
    };
    const problems = checkSpec(spec, media);
    expect(problems.length).toBeGreaterThanOrEqual(6);
    const joined = problems.join('\n');
    for (const want of ['分辨率', '帧率', '编码', '像素格式', '时长', '音轨']) expect(joined).toContain(want);
    // 每条都要带实测值，否则调用方还得自己再跑一次 ffprobe 才知道差多少。
    for (const want of ['720x1280', 'vp9', 'yuv444p']) expect(joined).toContain(want);
    // 文案与 Go 逐字一致。
    expect(problems).toEqual([
      '分辨率不符：期望 1080x1440，实测 720x1280',
      '帧率不符：期望 30，实测 25',
      '视频编码不符：期望 h264，实测 vp9',
      '像素格式不符：期望 yuv420p，实测 yuv444p',
      '时长不符：期望 2.833 秒（容差 0.100），实测 5.000 秒',
      '应当没有音轨，实测存在 aac 音轨',
    ]);
  });

  it('passes when everything matches', () => {
    const media: Media = {
      path: '',
      duration_seconds: 2.833,
      video: videoStream({ codec: 'h264', width_px: 1080, height_px: 1440, pixel_format: 'yuv420p', fps_num: 30, fps_den: 1, nb_frames: 85 }),
      audio: null,
    };
    const spec: Spec = {
      widthPx: 1080,
      heightPx: 1440,
      fps: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      durationSeconds: 2.833,
      tolerance: 0.1,
      audio: AudioAbsent,
      frames: 85,
    };
    expect(checkSpec(spec, media)).toEqual([]);
  });

  // Spec 的零值表示「不检查这一项」，否则每个调用方都得把全部字段填满才能只查一件事。
  it('zero fields are not checked', () => {
    const media: Media = {
      path: '',
      duration_seconds: 5,
      video: videoStream({ codec: 'vp9', width_px: 1, height_px: 1, pixel_format: 'rgb24', fps_num: 7, fps_den: 1 }),
      audio: audioStream({ codec: 'aac', sample_rate: 8000, channels: 5 }),
    };
    expect(checkSpec({}, media)).toEqual([]);
  });

  it('audio expectations', () => {
    const withAudio: Media = { path: '', duration_seconds: 0, video: videoStream(), audio: audioStream({ codec: 'aac', sample_rate: 48000, channels: 2 }) };
    const silent: Media = { path: '', duration_seconds: 0, video: videoStream(), audio: null };
    expect(checkSpec({ audio: AudioAbsent }, withAudio).length).toBeGreaterThan(0);
    expect(checkSpec({ audio: AudioAbsent }, silent)).toEqual([]);
    expect(checkSpec({ audio: AudioPresent }, silent).length).toBeGreaterThan(0);
    expect(checkSpec({ audio: AudioIgnore }, withAudio)).toEqual([]);
    // 采样率和声道数只在有音轨时才有意义。
    expect(checkSpec({ audio: AudioPresent, sampleRate: 48000, channels: 2 }, withAudio)).toEqual([]);
    const problems = checkSpec(
      { audio: AudioPresent, sampleRate: 48000, channels: 2 },
      { path: '', duration_seconds: 0, video: videoStream(), audio: audioStream({ sample_rate: 44100, channels: 1 }) },
    );
    expect(problems).toHaveLength(2);
  });

  // 容器没声明 nb_frames 时不能把 0 当成「0 帧」报错——那是「未知」，要靠 countFrames 精确数。
  it('frames uses declared count only when available', () => {
    const unknown: Media = { path: '', duration_seconds: 0, video: videoStream({ nb_frames: 0 }), audio: null };
    expect(checkSpec({ frames: 85 }, unknown)).toEqual([]);
    const wrong: Media = { path: '', duration_seconds: 0, video: videoStream({ nb_frames: 84 }), audio: null };
    expect(checkSpec({ frames: 85 }, wrong)).toHaveLength(1);
  });

  it('tolerance is respected', () => {
    const media: Media = { path: '', duration_seconds: 2.9, video: videoStream(), audio: null };
    // 差 0.067 秒在 0.1 容差内，不该报错。
    expect(checkSpec({ durationSeconds: 2.833, tolerance: 0.1 }, media)).toEqual([]);
    // 差 0.067 秒超出 0.01 容差，应当报错。
    expect(checkSpec({ durationSeconds: 2.833, tolerance: 0.01 }, media)).toHaveLength(1);
  });
});

it('Spec rejects invalid tolerance', () => {
  for (const bad of [NaN, Infinity, -1]) {
    expect(() => validateSpec({ durationSeconds: 1, tolerance: bad }), String(bad)).toThrow('时长容差必须是有限且非负的数字');
  }
  expect(() => validateSpec({ durationSeconds: 1, tolerance: 0.1 })).not.toThrow();
});

// --- 以下需要真实 ffmpeg/ffprobe ---

describe.skipIf(!hasFfmpeg)('with real ffmpeg', () => {
  it('probe reads real file', () => {
    const tc = toolchain();
    const media = tc.probe(sample('testsrc=size=1080x1440:rate=30:duration=2'));
    expect(media.video!.width_px).toBe(1080);
    expect(media.video!.height_px).toBe(1440);
    expect(media.video!.codec).toBe('h264');
    expect(media.video!.pixel_format).toBe('yuv420p');
    expect(Math.abs(videoFPS(media.video!) - 30)).toBeLessThanOrEqual(1e-6);
    // lavfi testsrc 不该有音轨。
    expect(media.audio).toBeNull();
    expect(Math.abs(media.duration_seconds - 2)).toBeLessThanOrEqual(0.05);
  });

  it('probe rejects missing and non-media files', () => {
    const tc = toolchain();
    expect(() => tc.probe(path.join(tempDir(), 'nope.mp4'))).toThrow(/^无法读取媒体规格：/);
    const junk = path.join(tempDir(), 'junk.mp4');
    fs.writeFileSync(junk, 'this is not a video');
    expect(() => tc.probe(junk)).toThrow();
  });

  it('countFrames is exact', () => {
    expect(toolchain().countFrames(sample('testsrc=size=320x240:rate=30:duration=2'))).toBe(60);
  });

  it('decode accepts intact file and rejects truncated', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=2');
    expect(() => tc.decode(file)).not.toThrow();
    const body = fs.readFileSync(file);
    const broken = path.join(tempDir(), 'broken.mp4');
    // 砍掉后半段：moov 在尾部时会直接损坏，即便还能读出头也解不完。
    fs.writeFileSync(broken, body.subarray(0, Math.floor(body.length / 3)));
    expect(() => tc.decode(broken)).toThrow();
  });

  it('frameStats detects flat and dark frames', () => {
    const tc = toolchain();
    let stats = tc.frameStats(sample('color=c=black:size=320x240:rate=30:duration=1'), 0);
    // 纯黑帧应当判定为平坦、暗。
    expect(isFlat(stats)).toBe(true);
    expect(isDark(stats)).toBe(true);

    stats = tc.frameStats(sample('color=c=white:size=320x240:rate=30:duration=1'), 0);
    // 纯白帧也是空白帧，应当判定为平坦，但不该判定为暗。
    expect(isFlat(stats)).toBe(true);
    expect(isDark(stats)).toBe(false);

    // 有内容的帧不该触发——这是误判的方向，比漏判更该守。
    stats = tc.frameStats(sample('testsrc=size=320x240:rate=30:duration=1'), 0);
    expect(isFlat(stats)).toBe(false);
  });

  // 钉死空白帧阈值的上界。
  //
  // 上一条测试用的 testsrc 是高对比彩条，标准差远高于任何合理阈值，
  // 约束不到阈值本身——把阈值放大 25 倍它照样通过。真正的误判风险是这一类帧：
  // 深色背景上只有一行标题，亮部不到画面的 1%，标准差落在 20 出头。
  // 这是合法封面，判成空白帧就是假阳性。
  it('frameStats does not flag sparse text on dark background', () => {
    const tc = toolchain();
    const file = path.join(tempDir(), 'sparse.mp4');
    ffmpeg(
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=#0a0a0a:size=320x240:rate=30:duration=1',
      '-vf', 'drawbox=x=40:y=110:w=60:h=12:color=white@1:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
    );
    const stats = tc.frameStats(file, 0);
    expect(isFlat(stats), `mean=${stats.mean} stddev=${stats.stddev}`).toBe(false);
    expect(isBlank(stats)).toBe(false);
    // 这一帧确实偏暗，isDark 会报——但它只是提示，不该让 isBlank 成立。
    if (!isDark(stats)) console.log(`提示：该帧 mean=${stats.mean.toFixed(2)} 未触发 Dark，阈值可能偏低`);
  });

  it('frameStats seeks to requested time', () => {
    const tc = toolchain();
    // 前 1 秒纯黑，之后是彩色测试图；抽 0 秒和 1.5 秒应当得到不同结果。
    const file = path.join(tempDir(), 'split.mp4');
    ffmpeg(
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
    );
    expect(isFlat(tc.frameStats(file, 0))).toBe(true);
    // 1.5 秒处是测试图，不该平坦——否则说明 seek 没生效。
    expect(isFlat(tc.frameStats(file, 1.5))).toBe(false);
  });

  it('extractFrame writes readable PNG', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=1');
    const dest = path.join(tempDir(), 'nested', 'frame-0.png');
    tc.extractFrame(file, 0, dest);
    const body = fs.readFileSync(dest);
    expect(body.length).toBeGreaterThanOrEqual(8);
    expect(body.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('extractFrame rejects time beyond duration', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=1');
    // 超出时长的抽帧应当报错，而不是静默产出空文件。
    expect(() => tc.extractFrame(file, 99, path.join(tempDir(), 'frame.png'))).toThrow();
  });

  it('verify separates problems from probe failures', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=1');
    // 规格不符：跑成功了，但不合格。
    const report = tc.verify(file, { spec: { widthPx: 1080, heightPx: 1440 } });
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
    // 检查跑不成：抛错，而不是一份 ok=false 的报告。
    expect(() => tc.verify(path.join(tempDir(), 'nope.mp4'), {})).toThrow();
  });

  it('verify exactFrames overrides container declaration', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=2');
    let report = tc.verify(file, { spec: { frames: 60 }, exactFrames: true });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    // 报告里的帧数应当是精确统计值。
    expect(report.media.video!.nb_frames).toBe(60);
    report = tc.verify(file, { spec: { frames: 59 }, exactFrames: true });
    expect(report.ok).toBe(false);
  });

  // parse 放行纯音频文件后 media.video 可能是 null。exactFrames 会调用 countFrames
  // 再回填 media.video.nb_frames——对纯音频文件必须整段跳过这一步，直接落到
  // checkSpec 给出「文件没有视频流」这条问题。
  it('verify exactFrames on audio-only file does not crash', () => {
    const tc = toolchain();
    const file = path.join(tempDir(), 'audio-only.wav');
    ffmpeg('-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file);
    const report = tc.verify(file, { exactFrames: true });
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes('没有视频流'))).toBe(true);
  });

  it('verify frame zero: blank is a problem but dark is only a hint', () => {
    const tc = toolchain();
    let report = tc.verify(sample('color=c=black:size=320x240:rate=30:duration=1'), { checkFrameZero: true });
    expect(report.ok).toBe(false);
    expect(report.frame_zero).toBeDefined();

    // 深色背景 + 稀疏文字：偏暗但可读，只该进 hints，不该让 ok 变 false。
    const dark = path.join(tempDir(), 'dark.mp4');
    ffmpeg(
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=#0a0a0a:size=320x240:rate=30:duration=1',
      '-vf', 'drawbox=x=40:y=110:w=60:h=12:color=white@1:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', dark,
    );
    report = tc.verify(dark, { checkFrameZero: true });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.hints?.length ?? 0).toBeGreaterThan(0);
  });

  // 证明 decode 能发现 probe 发现不了的损坏。
  //
  // 必须用 +faststart 把 moov atom 放到文件头：默认编码把它写在尾部，
  // 一截断连 probe 都失败，测到的就是「文件读不了」而不是「能读但解不完」——
  // 后者才是这条检查存在的理由。
  it('verify decode catches truncated file', () => {
    const tc = toolchain();
    const file = sample('testsrc=size=320x240:rate=30:duration=2', '-movflags', '+faststart');
    const body = fs.readFileSync(file);
    const broken = path.join(tempDir(), 'broken.mp4');
    fs.writeFileSync(broken, body.subarray(0, Math.floor(body.length / 3)));
    // 前置条件：moov 在头部时 probe 应当仍然成功。
    expect(() => tc.probe(broken)).not.toThrow();
    let report = tc.verify(broken, { decode: true });
    expect(report.ok).toBe(false);
    // 不开 decode 时这个文件会被判定通过——这正是过去的状态。
    report = tc.verify(broken, {});
    expect(report.ok).toBe(true);
  });

  it('frameDifference separates same and different pictures', () => {
    const tc = toolchain();
    // 前 1 秒是一张画面，后 1 秒换成另一张：同一段内两帧应几乎相同，跨段应差很多。
    const file = path.join(tempDir(), 'seam.mp4');
    ffmpeg(
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=#102030:size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'color=c=#f0e0c0:size=320x240:rate=30:duration=1',
      '-filter_complex', '[0:v]drawbox=x=100:y=80:w=120:h=80:color=#f2b134:t=fill[a];[a][1:v]concat=n=2:v=1[out]',
      '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
    );
    // 同一画面相邻两帧差异应接近 0。
    expect(tc.frameDifference(file, 0.5, 0.5 + 1.0 / 30)).toBeLessThan(5);
    // 两张无关画面差异应高于不合格阈值 48。
    expect(tc.frameDifference(file, 29.0 / 30, 1)).toBeGreaterThanOrEqual(48);
  });
});

it('newToolchain reports missing tool with exit code 127 marker', () => {
  expect(() => newToolchain({ PATH: tempDir() })).toThrow(MissingToolPrefix);
});

it('report writeJSON is machine readable', () => {
  const file = path.join(tempDir(), 'nested', 'video-report.json');
  writeReportJSON(
    {
      schema_version: ReportSchemaVersion,
      path: 'final.mp4',
      ok: false,
      problems: ['分辨率不符：期望 1080x1440，实测 720x1280'],
      media: { path: '', duration_seconds: 1.5, video: videoStream({ width_px: 720, height_px: 1280 }), audio: null },
    },
    file,
  );
  const body = fs.readFileSync(file, 'utf8');
  for (const want of ['"schema_version": 1', '"ok": false', '"width_px": 720']) expect(body).toContain(want);
  // 与 Go 的 json.MarshalIndent 逐字节一致：nil 的 audio 为 null、omitempty 的字段省略、末尾换行。
  expect(body).toBe(`{
  "schema_version": 1,
  "path": "final.mp4",
  "ok": false,
  "media": {
    "path": "",
    "duration_seconds": 1.5,
    "video": {
      "codec": "",
      "width_px": 720,
      "height_px": 1280,
      "pixel_format": "",
      "fps_num": 0,
      "fps_den": 0,
      "nb_frames": 0
    },
    "audio": null
  },
  "problems": [
    "分辨率不符：期望 1080x1440，实测 720x1280"
  ]
}
`);
});

it('meanAbsoluteDifference rejects mismatched frames', () => {
  expect(() => meanAbsoluteDifference(Uint8Array.from([1, 2]), Uint8Array.from([1]))).toThrow('两帧像素长度不同（2 与 1），无法比对');
  expect(meanAbsoluteDifference(Uint8Array.from([0, 10]), Uint8Array.from([4, 0]))).toBe(7);
});
