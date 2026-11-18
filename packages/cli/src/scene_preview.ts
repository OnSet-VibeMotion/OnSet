import fs from 'node:fs';
import path from 'node:path';
import * as determinism from '@onset/engine/determinism';
import { formatFixed, goRound } from '@onset/engine/gofmt';
import * as hyperframes from '@onset/engine/hyperframes';
import { contactSheetImages, newToolchain } from '@onset/engine/mediaprobe';
import * as scene from '@onset/engine/scene';
import { currentEnvironment } from './cli';
import { compactHyperFrames } from './hfoutput';
import { defineOp, ParamError } from './ops/op';
import { str } from './ops/common';

const maxFrames = 9;

function previewFrames(value: string, last: number): number[] {
  const frames = value.trim() === ''
    ? [0, goRound(last / 4), goRound(last / 2), goRound(last * 3 / 4), last]
    : value.split(',').map(frame => /^[0-9]+$/.test(frame.trim()) ? Number(frame) : NaN);
  if (frames.some(frame => !Number.isSafeInteger(frame) || frame < 0 || frame > last)) {
    throw new ParamError(`frames 要用镜头内帧号，范围 0–${last}`);
  }
  if (frames.length > maxFrames) throw new ParamError(`frames 最多 ${maxFrames} 个采样点`);
  return [...new Set(frames)].sort((a, b) => a - b);
}

function artifact(dir: string, file: unknown): string {
  if (typeof file !== 'string' || file === '') throw new Error('截图结果缺少文件路径');
  const resolved = scene.contained(dir, path.isAbsolute(file) ? path.relative(dir, file) : file, '截图路径');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error(`截图文件为空：${file}`);
  return resolved;
}

function checkWarnings(text: string, report: string): string[] {
  const result = JSON.parse(text);
  if (result?.ok !== true) throw new Error(`合成检查未通过，完整记录：${report}`);
  const sections = result as Record<string, { findings?: Array<{
    severity?: string;
    message?: string;
    selector?: string;
    time?: number;
  }> } | null>;
  return ['lint', 'runtime', 'layout', 'motion', 'contrast', 'craft']
    .flatMap(name => sections[name]?.findings ?? [])
    .filter(finding => finding.severity === 'warning')
    .map(finding => {
      const time = typeof finding.time === 'number' ? ` @ ${formatFixed(finding.time, 3)} 秒` : '';
      return `${(finding.message ?? '').slice(0, 220)} ${finding.selector ?? ''}${time}`.trim();
    });
}

defineOp({
  name: 'scene_preview_check',
  cli: ['scene', 'preview-check'],
  scopes: ['renderer'],
  summary: '一次做合成检查和关键帧联系表',
  description: '在当前镜头检查布局、运动和对比度，再截取指定的本地帧。按报告的帧序查看一张联系表；有疑问再打开局部或连续帧。合成检查报错时先修复。',
  examples: ['scene_preview_check({"frames":"0,45,89"})'],
  params: {
    frames: { type: 'string', description: '逗号分隔的本镜头整数帧号，最多 9 个；默认首帧、四分位和末帧' },
  },
  run: async (p, { out, signal }) => {
    const s = scene.load('.');
    const { fps } = scene.sceneCanvas(s);
    const frames = previewFrames(str(p.frames), goRound(s.duration_seconds * fps) - 1);
    const source = determinism.scan(s.directory);
    if (!source.ok) throw new Error(`合成源码存在确定性问题：\n  - ${determinism.problems(source).join('\n  - ')}`);
    const env = currentEnvironment();
    const cli = hyperframes.requireCLI(env);
    const artifacts = scene.contained(s.directory, '.onset', '预览目录');
    fs.mkdirSync(artifacts, { recursive: true });
    const dir = fs.mkdtempSync(path.join(artifacts, 'preview-'));
    const run = async (args: string[]): Promise<string> => {
      const spec = hyperframes.cliCommandFor(cli, env, args);
      let stdout = '';
      let stderr = '';
      const report = path.join(dir, args[0] + '.log');
      try {
        await hyperframes.runCommand(spec.file, spec.args, {
          cwd: s.directory, env: spec.env, signal,
          stdout: { write: chunk => { stdout += chunk; } },
          stderr: { write: chunk => { stderr += chunk; } },
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const detail = compactHyperFrames(stdout + '\n' + stderr).text.trim().slice(-3000);
        throw new Error(`${args[0]} 失败：${detail || (error as Error).message}\n完整记录：${report}`, { cause: error });
      } finally {
        fs.writeFileSync(report, stdout + (stderr ? '\n' + stderr : ''));
      }
      return stdout;
    };
    const checkReport = path.join(dir, 'check.log');
    const warnings = checkWarnings(await run(['check', '--json', '--max-issues', '20']), checkReport);
    const timePoints = frames.map(frame => formatFixed(frame / fps, 6)).join(',');
    const result = JSON.parse((await run([
      'snapshot', '--json', '--describe', 'false', '--no-end', '--output', dir, '--at', timePoints,
    ])).trim()) as { ok?: boolean; frames?: { path: unknown }[]; contactSheets?: unknown[] };
    if (result.ok !== true || result.frames?.length !== frames.length) {
      throw new Error(`截图帧数与请求不一致，完整记录：${path.join(dir, 'snapshot.log')}`);
    }
    const stills = result.frames.map(frame => artifact(dir, frame.path));
    let sheet = '';
    if (result.contactSheets?.length === 1) sheet = artifact(dir, result.contactSheets[0]);
    else {
      sheet = path.join(dir, 'contact-sheet.png');
      await contactSheetImages(newToolchain(env), stills, sheet, signal);
    }
    out.write(`检查通过。联系表：${sheet}，帧序 ${frames.join(', ')}。\n`);
    for (const warning of warnings.slice(0, 5)) out.write(`提示：${warning}\n`);
    if (warnings.length > 5) out.write(`另有 ${warnings.length - 5} 条提示，见完整记录。\n`);
    out.write(`完整检查记录：${checkReport}\n`);
    return { data: { sheet, frames } };
  },
});
