import fs from 'node:fs';
import path from 'node:path';
import * as config from '@onset/engine/config';
import { windowsPython } from '@onset/engine/envutil';
import { downloadSource, type SourceKind } from '@onset/engine/windowsruntime';
import { currentEnvironment } from './cli';
import { num, projectRoot, str, strs } from './ops/common';
import { defineOp, type Op } from './ops/op';

/** 只在 Windows 登记，不改变其他平台的工具目录、参数或行为。 */
export function windowsOperations(platform: NodeJS.Platform = process.platform): Op[] {
  if (platform !== 'win32') return [];
  return [{
    name: 'windows_inspect', cli: ['windows', 'inspect'], summary: '查看 Windows 工具、并发与可选产物目录',
    description: '只读检查本项目的可选目录、已准备的 Python 和实际并发。目录尚未生成时返回 exists=false，不将其当成制作失败，不创建目录或修改制作文件。',
    examples: ['windows_inspect()', 'windows_inspect({"paths":["production/visual-qc","production/audio/source"]})'],
    params: { project_root: projectRoot, paths: { type: 'strings', description: '要检查的项目内相对路径；默认检查视觉校验和声音来源目录' } },
    run: (p) => {
      const root = fs.realpathSync(str(p.project_root));
      const requested = strs(p.paths);
      if (requested.length > 32) throw new Error('一次最多检查 32 个目录');
      const paths = (requested.length ? requested : ['production/visual-qc', 'production/audio/source']).map((relative) => {
        const target = path.resolve(root, relative);
        const rel = path.relative(root, target);
        if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|[\\/])\.env(?:\.|$)/.test(rel)) throw new Error('只能检查项目内的非凭据路径');
        if (!fs.existsSync(target)) return { path: relative, exists: false };
        const real = path.relative(root, fs.realpathSync(target));
        if (real.startsWith('..') || path.isAbsolute(real)) throw new Error('路径的实际位置越出了项目');
        const stat = fs.statSync(target);
        return { path: relative, exists: true, directory: stat.isDirectory(), files: stat.isDirectory() ? fs.readdirSync(target).sort().slice(0, 100) : undefined, bytes: stat.isFile() ? stat.size : undefined };
      });
      const scenes = path.join(root, 'scenes');
      const running = fs.existsSync(scenes) ? fs.readdirSync(scenes).sort().flatMap((id) => {
        const live = path.join(scenes, id, `render-${id}.live.json`);
        if (!fs.existsSync(live)) return [];
        try { const state = JSON.parse(fs.readFileSync(live, 'utf8')); return [{ scene: id, started_at: state.started_at, pid: state.pid }]; } catch { return []; }
      }) : [];
      return { data: { platform: 'win32', python: windowsPython(currentEnvironment()), configured_scene_jobs: config.load(root, null).sceneJobs, running_scene_count: running.length, running_scenes: running, paths } };
    },
  }, {
    name: 'source_download', cli: ['windows', 'source-download'], summary: '验证并下载 Windows 项目的公开来源素材',
    description: '经已准备好的 Python、系统代理和经验证 TLS 下载公开作品页、JSON、ZIP 或音频；不依赖 Schannel 或 Node REPL fetch。类型、ZIP CRC、摘要和可选曲目条目核验通过后写入来源收件目录，失败清理临时数据。不会覆盖任何不同的已有文件。动态作品页会返回公开 JSON 与下载端点提示；曲目身份核验不等于许可批准，许可须另核对一手证据。',
    examples: ['source_download({"url":"https://example.org/work.html","output":"production/sources/work.html","kind":"html"})', 'source_download({"url":"https://example.org/pieces.json","output":"production/sources/pieces.json","kind":"json","record_field":"isrc","record_value":"track-id","record_title":"Track title"})'],
    params: {
      project_root: projectRoot,
      url: { type: 'string', description: '公开 HTTP(S) 作品页或来源地址，不含登录信息和凭据', required: true },
      work_url: { type: 'string', description: '可选的一手作品页，用于下载端点要求的 Referer；不发送登录凭据' },
      output: { type: 'string', description: 'production/audio/source、production/sources 或 assets/sources 下的相对文件名', required: true },
      kind: { type: 'string', description: '必须是 zip、audio、html 或 json', required: true },
      sha256: { type: 'string', description: '已知时核对下载文件的 SHA-256' },
      max_megabytes: { type: 'integer', description: '最大下载体积，1..256 MiB', default: 64 },
      timeout_seconds: { type: 'number', description: '单次连接和读取超时，0..60 秒', default: 20 },
      record_field: { type: 'string', description: 'JSON 条目中用于唯一核对身份的字段，例如 isrc' },
      record_value: { type: 'string', description: '该身份字段必须匹配的值' },
      record_title: { type: 'string', description: 'JSON 条目的 title 必须匹配的标题' },
    },
    run: async (p, context) => ({ data: await downloadSource({ root: str(p.project_root), url: str(p.url), workURL: str(p.work_url), output: str(p.output), kind: str(p.kind) as SourceKind, env: currentEnvironment(), maxBytes: num(p.max_megabytes) * 1024 * 1024, timeoutSeconds: num(p.timeout_seconds), sha256: str(p.sha256), recordField: str(p.record_field), recordValue: str(p.record_value), recordTitle: str(p.record_title), signal: context.signal }) }),
  }];
}

for (const operation of windowsOperations()) defineOp(operation);
