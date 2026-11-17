import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Buffer, initProject, run, runCLI, setenv, tempDir } from './testutil';
import { Version } from './cli';
import { FunASRTimestampModel } from '@onset/engine/config';
import { modelDir } from '@onset/engine/toolinstall';

describe('cli', () => {
  it('help lists public commands', async () => {
    const out = new Buffer();
    expect(await run(['--help'], out)).toBe(0);
    for (const command of ['init', 'run', 'scene', 'archive', 'validate', 'config']) expect(out.text).toContain(command);
  });

  it('init creates a project without network when skipped', async () => {
    const target = path.join(tempDir(), 'project');
    const out = new Buffer();
    expect(await run(['init', target, '--canvas', 'vertical-3x4', '--skip-hyperframes'], out), out.text).toBe(0);
    // 不写提示词文件，只记下流程与画幅；提示词开工时组合，prompt show 能看全文。
    expect(fs.existsSync(path.join(target, 'PROMPT.md'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'onset.flow.json'), 'utf8')).production).toEqual({ id: 'speech', canvas: 'vertical-3x4', render_prompt: 2 });
    const shown = new Buffer();
    expect(await run(['prompt', 'show', '--project-root', target], shown), shown.text).toBe(0);
    expect(shown.text).toContain('## 第一阶段：盘点输入和制作规格');
  });

  it('config get uses the project root', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    process.chdir(root);
    const out = new Buffer();
    const code = await run(['config', 'get', 'RENDERER'], out);
    expect(code === 0 && out.text.trim() === 'claude', `code=${code} output=${out.text}`).toBe(true);
  });

  it('config get TTS_MODEL prints the Breeze model repo until onset setup downloads it, and nothing for cloud voices', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nTTS_PROVIDER=breeze\n');
    process.chdir(root);
    // 数据目录指到空的临时目录：开发机上 onset setup 真下好的模型不能混进来。
    setenv('XDG_DATA_HOME', tempDir());
    const out = new Buffer();
    expect(await run(['config', 'get', 'TTS_MODEL'], out), out.text).toBe(0);
    // Windows Breeze is the native CUDA tool, not the Apple-only MLX repository.
    expect(out.text.trim()).toBe(process.platform === 'win32' ? '' : 'mlx-community/Breeze-TTS-2-mlx-8bit');
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nTTS_PROVIDER=minimax\n');
    const empty = new Buffer();
    expect(await run(['config', 'get', 'TTS_MODEL'], empty), empty.text).toBe(0);
    expect(empty.text).toBe('\n');
  });

  it('unknown command uses exit one', async () => {
    expect(await run(['unknown'])).toBe(1);
  });

  it.skipIf(process.platform !== 'win32')('config get ALIGN_MODEL exposes the prepared FunASR directory on Windows', async () => {
    const root = tempDir();
    const data = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nALIGN_PROVIDER=funasr\n');
    process.chdir(root);
    setenv('XDG_DATA_HOME', data);
    const missing = new Buffer();
    expect(await run(['config', 'get', 'ALIGN_MODEL'], missing)).toBe(0);
    expect(missing.text.trim()).toBe(FunASRTimestampModel.repo);
    const directory = modelDir(FunASRTimestampModel, { XDG_DATA_HOME: data });
    fs.mkdirSync(directory, { recursive: true });
    for (const file of FunASRTimestampModel.files) {
      const target = path.join(directory, file.path);
      fs.writeFileSync(target, '');
      fs.truncateSync(target, file.size);
    }
    const ready = new Buffer();
    expect(await run(['config', 'get', 'ALIGN_MODEL'], ready)).toBe(0);
    expect(ready.text.trim()).toBe(directory);
  });

  it('validate publish command', async () => {
    const root = await initProject();
    const out = new Buffer();
    const file = path.join(root, 'templates', 'publish.md');
    expect(await run(['validate', 'publish', file, '--project-root', root], out), out.text).toBe(0);
  });


  it('empty run-all and no validate style', async () => {
    const root = await initProject();
    const out = new Buffer();
    expect(await run(['validate', 'style', '--project-root', root], out), out.text).not.toBe(0);
    const project = tempDir();
    fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    fs.mkdirSync(path.join(project, 'scenes'));
    process.chdir(project);
    const out2 = new Buffer();
    expect(await run(['scene', 'run-all', 'scenes', '--jobs', '1', '--retries', '0'], out2), out2.text).toBe(0);
  });

  it('init conflict, and same-tool config succeeds', async () => {
    const target = tempDir();
    fs.writeFileSync(path.join(target, 'frame.md'), 'custom');
    expect(await run(['init', target, '--canvas', 'vertical-3x4', '--skip-hyperframes'])).toBe(1);
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    process.chdir(root);
    const out = new Buffer();
    expect(await run(['config', 'get', 'RENDERER'], out), out.text).toBe(0);
    expect(out.text.trim()).toBe('codex');
  });

  it('archive dry run does not mutate', async () => {
    const root = tempDir();
    const git = (...args: string[]) => {
      const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
      const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    };
    git('init', '-b', 'main');
    fs.writeFileSync(path.join(root, 'README.md'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    git('switch', '-c', 'video/test');
    fs.writeFileSync(path.join(root, 'scene.txt'), 'scene');
    process.chdir(root);
    const out = new Buffer();
    expect(await run(['archive', '--dry-run', '--archive-root', path.join(tempDir(), 'archive')], out), out.text).toBe(0);
    expect(fs.existsSync(path.join(root, 'scene.txt')), 'dry run mutated project').toBe(true);
  });

  it('run-all rejects NaN tolerance even when no scenes exist', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    fs.mkdirSync(path.join(root, 'scenes'));
    process.chdir(root);
    expect(await run(['scene', 'run-all', 'scenes', '--duration-tolerance', 'nan'])).toBe(1);
  });

  it('init rejects an unknown canvas', async () => {
    const out = new Buffer();
    const code = await run(['init', path.join(tempDir(), 'video'), '--canvas', 'vertical-4x5', '--skip-hyperframes'], out);
    expect(code).not.toBe(0);
    expect(out.text).toContain('vertical-9x16');
  });

  it('init writes the chosen canvas', async () => {
    const target = path.join(tempDir(), 'video');
    const out = new Buffer();
    expect(await run(['init', target, '--canvas', 'vertical-9x16', '--skip-hyperframes'], out), out.text).toBe(0);
    const body = fs.readFileSync(path.join(target, 'frame.md'), 'utf8');
    expect(body, 'frame.md 未写入 9:16 画幅').toContain('height_px: 1920');
    expect(body, 'frame.md 的字幕安全区未按 9:16 推导').toContain('top_px: 1470');
    // 共享树与画幅树都要落地；旧版风格的说明书、示例图与风格描述不再出现。
    for (const name of [path.join('assets', 'fonts', 'noto-sans-sc-400.woff2'), path.join('templates', 'project-rules.md')]) {
      expect(fs.existsSync(path.join(target, name)), `缺少 ${name}`).toBe(true);
    }
    for (const name of ['docs', path.join('assets', 'style-guide')]) expect(fs.existsSync(path.join(target, name)), `不该有 ${name}`).toBe(false);
    // --style 已经没有了。
    expect(await run(['init', path.join(tempDir(), 'v2'), '--canvas', 'vertical-9x16', '--style', 'custom', '--skip-hyperframes'], new Buffer())).not.toBe(0);
  });

  // 非交互环境不静默取默认画幅：选错画幅会让整个项目的排版基准和成片规格全错。
  it('init requires an explicit canvas when not interactive', async () => {
    const out = new Buffer();
    const code = await run(['init', path.join(tempDir(), 'video'), '--skip-hyperframes'], out);
    expect(code).not.toBe(0);
    expect(out.text).toContain('--canvas');
  });

  it('init narration solo has no roster', async () => {
    const root = tempDir();
    const target = path.join(root, 'solo');
    await runCLI(root, 'init', target, '--canvas', 'vertical-3x4', '--skip-hyperframes');
    expect(fs.existsSync(path.join(target, 'cast.yaml')), '单口播项目不该有 cast.yaml').toBe(false);
  });

  it('init narration cast writes the roster', async () => {
    const root = tempDir();
    const target = path.join(root, 'story');
    await runCLI(root, 'init', target, '--canvas', 'vertical-3x4', '--narration', 'cast', '--skip-hyperframes');
    const body = fs.readFileSync(path.join(target, 'cast.yaml'), 'utf8');
    // packs: [] 是明确裁定过的设计：onset init 刚建的项目本来就还没有角色包。
    for (const want of ['schema: cast/v1', 'packs: []', 'ground_y: 0.78', 'turn: 240', 'interject: 100']) expect(body).toContain(want);
    // 多角色的作业规程是口播制作提示词的附录，不再是项目里的一份文件。
    expect(fs.existsSync(path.join(target, 'PROMPT-CAST-ADDENDUM.md'))).toBe(false);
  });

  it('init rejects an unknown narration', async () => {
    const root = tempDir();
    await expect(runCLI(root, 'init', path.join(root, 'x'), '--canvas', 'vertical-3x4', '--narration', 'duet')).rejects.toThrow();
  });

  // 渲染前一次列全所有非整数帧时长的镜头，且不启动任何渲染器。
  it('run-all rejects fractional frame durations before rendering', async () => {
    const project = tempDir();
    fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    for (const [id, duration] of Object.entries({ 'scene-001': '14.367', 'scene-002': '4', 'scene-003': '2.01' })) {
      const dir = path.join(project, 'scenes', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
      fs.writeFileSync(path.join(dir, 'scene.json'), `{"id":"${id}","duration_seconds":${duration},"output":"${id}.mp4","transcript":"transcription.srt","text":"hi"}`);
    }
    // PATH 里放一个一旦被调用就留痕的假 claude，证明渲染前就被拦下。
    const bin = tempDir();
    const marker = path.join(project, 'renderer-called');
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    setenv('PATH', bin + path.delimiter + process.env.PATH);
    process.chdir(project);
    const out = new Buffer();
    expect(await run(['scene', 'run-all', 'scenes', '--jobs', '1', '--retries', '0'], out), out.text).not.toBe(0);
    for (const want of ['未对齐整数帧', 'scene-001', 'scene-003']) expect(out.text).toContain(want);
    expect(out.text).not.toContain('镜头 scene-002');
    expect(fs.existsSync(marker), '渲染器不应被调用').toBe(false);
  });

  // 版本号只来自发布时注入的 tag；未注入的本地构建必须自称 dev。
  it('--version reports the injected version', async () => {
    const out = new Buffer();
    expect(await run(['--version'], out), out.text).toBe(0);
    expect(out.text).toContain(Version);
    expect(Version).toBe('dev');
  });
});
