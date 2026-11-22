import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MissingError } from '../prereq';
import * as prereqs from '../prereqs';
import { directoryLink } from '../testsupport/windowsfixtures';
import { generate } from './generate';
import {
  AceStepGGUFModel,
  AcestepBinDirEnv,
  AcestepCppCommit,
  AcestepModelsDirEnv,
  DefaultLocalLMModel,
  DefaultLocalSynthModel,
  DefaultLocalTextEncoderModel,
  DefaultLocalVAEModel,
  buildLocalRequest,
  localAcestepBinDir,
  localAcestepModelsDir,
  localAcestepStatus,
  requireLocalAcestep,
  resolveLocalLMModel,
  resolveLocalSynthModel,
} from './local';
import { configure, platformGuide } from './platforms';
import { doctor } from './prepare';
import { Store, loadCandidate, loadConfig } from './store';
import { Buf, cleanupTemps, fakeEnvironment, tempDir } from './testsupport';
import { config } from './types';

afterEach(cleanupTemps);

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Error,
  );
}

/** 构造一套假的本机 ace-lm / ace-synth 脚本与模型目录，记录每次调用的参数与请求 JSON。 */
function fakeLocalRuntime(): { binDir: string; modelsDir: string; logFile: string } {
  const binDir = tempDir();
  const modelsDir = tempDir();
  const logFile = path.join(tempDir(), 'calls.jsonl');
  fs.writeFileSync(path.join(modelsDir, DefaultLocalSynthModel), 'gguf');
  fs.writeFileSync(path.join(modelsDir, DefaultLocalTextEncoderModel), 'gguf');
  fs.writeFileSync(path.join(modelsDir, DefaultLocalLMModel), 'gguf');
  fs.writeFileSync(path.join(modelsDir, DefaultLocalVAEModel), 'gguf');

  const writeNodeBin = (name: string, body: string) => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  };

  writeNodeBin(
    'ace-lm',
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const reqIdx = args.indexOf('--request');
const reqPath = reqIdx >= 0 ? args[reqIdx + 1] : '';
const req = reqPath ? JSON.parse(fs.readFileSync(reqPath, 'utf8')) : null;
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ bin: 'ace-lm', args, req }) + '\\n');
if (process.env.FAKE_ACESTEP_FAIL_LM === '1') {
  console.error('simulated lm failure');
  process.exit(1);
}
const outPath = reqPath.replace(/\\.json$/, '0.json');
fs.writeFileSync(outPath, JSON.stringify({ ...req, audio_codes: '101,202,303' }));
`,
  );

  writeNodeBin(
    'ace-synth',
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const reqIdx = args.indexOf('--request');
const reqPath = reqIdx >= 0 ? args[reqIdx + 1] : '';
const req = reqPath ? JSON.parse(fs.readFileSync(reqPath, 'utf8')) : null;
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ bin: 'ace-synth', args, req }) + '\\n');
if (process.env.FAKE_ACESTEP_FAIL_SYNTH === '1') {
  console.error('simulated synth failure');
  process.exit(1);
}
const outPath = reqPath.replace(/\\.json$/, '0.mp3');
fs.writeFileSync(outPath, 'fake-mp3-audio');
`,
  );

  return { binDir, modelsDir, logFile };
}

function readCalls(logFile: string): Array<{ bin: string; args: string[]; req: Record<string, unknown> }> {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { bin: string; args: string[]; req: Record<string, unknown> });
}

describe('local ACE-Step 1.5 (acestep.cpp + GGUF)', () => {
  it('registers prereq item and reports ready only when binaries, marker and GGUF models are all present', () => {
    const item = prereqs.items().find((i) => i.id === 'song:acestep');
    expect(item).toBeDefined();
    expect(item?.group).toBe('song');
    expect(item?.required).toBe(false);
    expect(item?.later?.title).toBe('本机歌曲生成');

    const home = tempDir();
    const env = { HOME: home, PATH: '/usr/bin:/bin' };
    expect(localAcestepStatus(env).ok).toBe(false);
    expect(localAcestepStatus(env).where.startsWith(home)).toBe(true);
    expect(() => requireLocalAcestep(env)).toThrow(MissingError);

    // 只放二进制但没写完成标记：不算就绪。
    const binDir = localAcestepBinDir(env);
    fs.mkdirSync(binDir, { recursive: true });
    const ext = process.platform === 'win32' ? '.exe' : '';
    fs.writeFileSync(path.join(binDir, 'ace-lm' + ext), 'bin', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'ace-synth' + ext), 'bin', { mode: 0o755 });
    expect(localAcestepStatus(env).binariesReady).toBe(false);

    // 补上匹配的提交标记：二进制就绪，但缺 GGUF 模型。
    fs.writeFileSync(path.join(binDir, '.onset-acestep-cpp'), AcestepCppCommit + '\n');
    expect(localAcestepStatus(env).binariesReady).toBe(true);
    expect(localAcestepStatus(env).modelsReady).toBe(false);
    expect(localAcestepStatus(env).ok).toBe(false);

    // 自定义模型目录只有单个 synth 文件时不算就绪，必须备齐整套必需 GGUF 权重。
    const modelsDir = tempDir();
    fs.writeFileSync(path.join(modelsDir, DefaultLocalSynthModel), 'x');
    const readyEnv = { ...env, [AcestepModelsDirEnv]: modelsDir };
    expect(localAcestepStatus(readyEnv).modelsReady).toBe(false);
    expect(() => requireLocalAcestep(readyEnv)).toThrow(MissingError);
    fs.writeFileSync(path.join(modelsDir, DefaultLocalTextEncoderModel), 'x');
    fs.writeFileSync(path.join(modelsDir, DefaultLocalLMModel), 'x');
    fs.writeFileSync(path.join(modelsDir, DefaultLocalVAEModel), 'x');
    expect(localAcestepStatus(readyEnv).ok).toBe(true);
    expect(requireLocalAcestep(readyEnv).modelsDir).toBe(modelsDir);

    // 默认托管目录需精确文件清单及文件大小均匹配：被截断为零字节时即使传入配置也不算就绪。
    expect(localAcestepModelsDir(env)).toContain('Serveurperso__ACE-Step-1.5-GGUF');
    expect(AceStepGGUFModel.files.length).toBe(5);
    expect(AceStepGGUFModel.sources).toEqual(['huggingface']);
    const managedDir = localAcestepModelsDir(env);
    fs.mkdirSync(managedDir, { recursive: true });
    for (const f of AceStepGGUFModel.files) fs.writeFileSync(path.join(managedDir, f.path), '');
    const cfg = config({ provider: 'acestep-local', model: DefaultLocalSynthModel });
    expect(localAcestepStatus(env, process.platform, cfg).modelsReady).toBe(false);
    expect(() => requireLocalAcestep(env, process.platform, cfg)).toThrow(MissingError);
  });

  it('normalizes model names and builds requests for text2music and cover modes', () => {
    expect(resolveLocalSynthModel('')).toBe(DefaultLocalSynthModel);
    expect(resolveLocalSynthModel('acestep-v15-turbo')).toBe(DefaultLocalSynthModel);
    expect(resolveLocalSynthModel('acestep-v15-sft')).toBe('acestep-v15-sft-Q8_0.gguf');
    expect(resolveLocalSynthModel('acestep-v15-xl-turbo-Q6_K.gguf')).toBe('acestep-v15-xl-turbo-Q6_K.gguf');
    expect(resolveLocalLMModel('')).toBe(DefaultLocalLMModel);
    expect(resolveLocalLMModel('acestep-5Hz-lm-4B')).toBe('acestep-5Hz-lm-4B-Q8_0.gguf');

    const t2m = buildLocalRequest(
      config({ provider: 'acestep-local', model: DefaultLocalSynthModel, style: 'Mandarin pop', language: 'zh', target_seconds: 90, bpm: 108 }),
      '[Verse]\n你好世界',
    );
    expect(t2m).toMatchObject({
      task_type: 'text2music',
      caption: 'Mandarin pop',
      lyrics: '[Verse]\n你好世界',
      duration: 90,
      bpm: 108,
      vocal_language: 'zh',
      lm_model: DefaultLocalLMModel,
      synth_model: DefaultLocalSynthModel,
      vae: DefaultLocalVAEModel,
      output_format: 'mp3',
    });

    const cov = buildLocalRequest(
      config({ provider: 'acestep-local', model: DefaultLocalSynthModel, style: 'Acoustic cover', language: 'zh', bpm: 96, task_type: 'cover', source_audio: 'src.mp3' }),
      '[Chorus]\n换词翻唱',
    );
    expect(cov.task_type).toBe('cover');
    expect(cov.audio_cover_strength).toBe(0.5);
    expect(cov.duration).toBeUndefined();
    expect(cov.lm_model).toBeUndefined();

    const nofsq = buildLocalRequest(
      config({ provider: 'acestep-local', model: DefaultLocalSynthModel, style: 'Faithful cover', language: 'zh', bpm: 96, task_type: 'cover-nofsq', source_audio: 'src.mp3' }),
      '[Chorus]\n高保真翻唱',
    );
    expect(nofsq.task_type).toBe('cover-nofsq');
    expect(nofsq.audio_cover_strength).toBe(0.35);
  });

  it.skipIf(process.platform === 'win32')('runs text2music end-to-end with ace-lm -> ace-synth and reuses candidates', async () => {
    const { root, env } = fakeEnvironment();
    const { binDir, modelsDir, logFile } = fakeLocalRuntime();
    const runEnv = { ...env, PATH: `${env.PATH}:${path.dirname(process.execPath)}`, [AcestepBinDirEnv]: binDir, [AcestepModelsDirEnv]: modelsDir };

    configure(root, 'acestep-local', '', '', '');
    const cfg = loadConfig(root);
    expect(cfg.provider).toBe('acestep-local');
    expect(cfg.model).toBe(DefaultLocalSynthModel);

    const guide = new Buf();
    platformGuide(guide, 'acestep-local', runEnv);
    expect(guide.text).toContain('无需 API Key');
    expect(guide.text).toContain('cover');

    const docOut = new Buf();
    await doctor(root, runEnv, docOut);
    expect(docOut.text).toContain('OK 本机 ACE-Step 1.5');

    const out = new Buf();
    await generate(root, 1, 'local', runEnv, out);
    const calls = readCalls(logFile);
    expect(calls.map((c) => c.bin)).toEqual(['ace-lm', 'ace-synth']);
    expect(calls[0].req.task_type).toBe('text2music');
    expect(calls[0].req.lyrics).toContain('歌词');
    expect(calls[1].req.audio_codes).toBe('101,202,303');

    const dirs = fs.readdirSync(path.join(root, Store, 'candidates'));
    expect(dirs).toHaveLength(1);
    const cand = loadCandidate(root, dirs[0]);
    expect(cand.provider).toBe('acestep-local');

    // 二次生成同 batch 应直接复用候选，不再调用 ace-lm / ace-synth。
    await generate(root, 1, 'local', runEnv, out);
    expect(readCalls(logFile)).toHaveLength(2);
    expect(out.text).toContain('复用候选');
  });

  it.skipIf(process.platform === 'win32')('runs cover and cover-nofsq skipping ace-lm and invalidating cache when source audio changes', async () => {
    const { root, env } = fakeEnvironment();
    const { binDir, modelsDir, logFile } = fakeLocalRuntime();
    const runEnv = { ...env, PATH: `${env.PATH}:${path.dirname(process.execPath)}`, [AcestepBinDirEnv]: binDir, [AcestepModelsDirEnv]: modelsDir };

    const srcFile = path.join(root, 'source.mp3');
    fs.writeFileSync(srcFile, 'original-song-v1');
    configure(root, 'acestep-local', '', '', '', { taskType: 'cover', sourceAudio: 'source.mp3', coverStrength: 0.6 });

    const out = new Buf();
    await doctor(root, runEnv, out);
    await generate(root, 1, 'cov', runEnv, out);
    let calls = readCalls(logFile);
    expect(calls.map((c) => c.bin)).toEqual(['ace-synth']);
    expect(calls[0].args).toContain('--src-audio');
    expect(calls[0].args[calls[0].args.indexOf('--src-audio') + 1]).toMatch(/source\.mp3$/);
    expect(calls[0].args).not.toContain('--ref-audio');
    expect(calls[0].req.task_type).toBe('cover');
    expect(calls[0].req.audio_cover_strength).toBe(0.6);

    // 同平台仅修改 model 时，未提供的翻唱设置（source_audio / task_type / cover_strength）必须保留。
    configure(root, 'acestep-local', 'acestep-v15-sft-Q8_0.gguf', '', '');
    const kept = loadConfig(root);
    expect(kept.model).toBe('acestep-v15-sft-Q8_0.gguf');
    expect(kept.task_type).toBe('cover');
    expect(kept.source_audio).toBe('source.mp3');
    expect(kept.cover_strength).toBe(0.6);
    // 非法翻唱强度（负数、超过 1、NaN）必须拒绝，不能静默归零删除；合法 0 仍表示使用默认强度。
    expect(() => configure(root, 'acestep-local', '', '', '', { coverStrength: -0.1 })).toThrow('cover_strength');
    expect(() => configure(root, 'acestep-local', '', '', '', { coverStrength: 1.2 })).toThrow('cover_strength');
    expect(() => configure(root, 'acestep-local', '', '', '', { coverStrength: Number.NaN })).toThrow('cover_strength');
    // 还原模型继续后续验证。
    configure(root, 'acestep-local', DefaultLocalSynthModel, '', '');

    // 替换原曲文件内容：摘要变化，应生成新候选而不是误复用旧翻唱。
    fs.writeFileSync(srcFile, 'original-song-v2');
    await generate(root, 1, 'cov', runEnv, out);
    calls = readCalls(logFile);
    expect(calls).toHaveLength(2);
    expect(fs.readdirSync(path.join(root, Store, 'candidates'))).toHaveLength(2);

    // cover-nofsq 未单设 reference_audio 时自动同传 --ref-audio 指向原曲。
    configure(root, 'acestep-local', '', '', '', { taskType: 'cover-nofsq', sourceAudio: 'source.mp3' });
    await generate(root, 1, 'nofsq', runEnv, out);
    calls = readCalls(logFile);
    const last = calls[calls.length - 1];
    expect(last.bin).toBe('ace-synth');
    expect(last.args).toContain('--src-audio');
    expect(last.args).toContain('--ref-audio');
    expect(last.req.task_type).toBe('cover-nofsq');
    expect(last.req.audio_cover_strength).toBe(0.35);
  });

  it.skipIf(process.platform === 'win32')('validates cover constraints, missing runtime, symlink boundaries and failure state', async () => {
    const { root, env } = fakeEnvironment();
    // 其他平台配 cover 被拒绝。
    expect(() => configure(root, 'lyria', '', '', '', { taskType: 'cover', sourceAudio: 'source.mp3' })).toThrow('不支持翻唱');
    // cover 缺 source_audio 被拒绝。
    expect(() => configure(root, 'acestep-local', '', '', '', { taskType: 'cover' })).toThrow('source_audio');
    // cover_strength 越界被拒绝。
    expect(() => configure(root, 'acestep-local', '', '', '', { taskType: 'cover', sourceAudio: 'source.mp3', coverStrength: 1.5 })).toThrow('cover_strength');
    // 路径穿越与符号链接被拒绝。
    expect(() => configure(root, 'acestep-local', '', '', '', { taskType: 'cover', sourceAudio: '../evil.mp3' })).toThrow('相对路径');
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'x.mp3'), 'x');
    directoryLink(outside, path.join(root, 'linked'));
    expect(() => configure(root, 'acestep-local', '', '', '', { taskType: 'cover', sourceAudio: 'linked/x.mp3' })).toThrow('符号链接');

    // 未安装本机环境时在写候选前直接抛 MissingError。
    configure(root, 'acestep-local', '', '', '');
    const missingErr = await rejects(generate(root, 1, 'unready', env, new Buf()));
    expect(missingErr).toBeInstanceOf(MissingError);
    expect(fs.existsSync(path.join(root, Store, 'candidates'))).toBe(false);

    // ace-lm 失败不自动重发。
    const { binDir, modelsDir } = fakeLocalRuntime();
    const failEnv = {
      ...env,
      PATH: `${env.PATH}:${path.dirname(process.execPath)}`,
      [AcestepBinDirEnv]: binDir,
      [AcestepModelsDirEnv]: modelsDir,
      FAKE_ACESTEP_FAIL_LM: '1',
    };
    const err1 = await rejects(generate(root, 1, 'fail-lm', failEnv, new Buf()));
    expect(err1?.message).toContain('LM 阶段失败');
    const err2 = await rejects(generate(root, 1, 'fail-lm', failEnv, new Buf()));
    expect(err2?.message).toContain('状态不明');
  });
});
