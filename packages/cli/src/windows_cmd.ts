import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as config from '@onset/engine/config';
import { windowsPython, lookPath, dataDir } from '@onset/engine/envutil';
import { downloadSource, type SourceKind } from '@onset/engine/windowsruntime';
import { currentEnvironment } from './cli';
import { num, projectRoot, str, strs } from './ops/common';
import { defineOp, type Op } from './ops/op';
import { windowsAlignOperation } from './windows_align';

/** 只在 Windows 登记，不改变其他平台的工具目录、参数或行为。 */
export function windowsOperations(platform: NodeJS.Platform = process.platform): Op[] {
  if (platform !== 'win32') return [];
  return [{
    name: 'windows_inspect', cli: ['windows', 'inspect'], summary: '查看 Windows 工具、并发与可选产物目录',
    description: '一次只读检查项目目录、Python、并发、非敏感制作配置、Git 状态和指定文件的流式 SHA256，支持配音。缺可选目录或未初始化 Git 是正常状态，不创建文件、不安装工具。优先用它合并配置、Git 和文件摘要检查，避免分别启动 shell。',
    examples: ['windows_inspect()', 'windows_inspect({"paths":["production/visual-qc","production/audio/source"]})'],
    params: { project_root: projectRoot, paths: { type: 'strings', description: '要检查的项目内相对路径；默认检查视觉校验和声音来源目录' }, hash_files: { type: 'strings', description: '一次核对至多 16 个项目内文件的 SHA256，支持配音；单文件最多 256 MiB、合计 512 MiB，流式读取，不含凭据或个人目录' } },
    run: async (p, context) => {
      const root = fs.realpathSync(str(p.project_root));
      const checked = (relative: string): string => {
        const target = path.resolve(root, relative), rel = path.relative(root, target);
        if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|[\\/])(?:\.env(?:\.|$)|\.git(?:[\\/]|$)|\.codex(?:[\\/]|$))/i.test(rel)) throw new Error('只能检查项目内的非凭据路径');
        if (fs.existsSync(target)) {
          const real = path.relative(root, fs.realpathSync(target));
          if (real.startsWith('..') || path.isAbsolute(real) || /(^|[\\/])(?:\.env(?:\.|$)|\.git(?:[\\/]|$)|\.codex(?:[\\/]|$))/i.test(real)) throw new Error('路径的实际位置越出了项目或指向凭据');
        }
        return target;
      };
      const requested = strs(p.paths);
      if (requested.length > 32) throw new Error('一次最多检查 32 个目录');
      const paths = (requested.length ? requested : ['production/visual-qc', 'production/audio/source']).map((relative) => {
        const target = checked(relative);
        const rel = path.relative(root, target);
        if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|[\\/])\.env(?:\.|$)/.test(rel)) throw new Error('只能检查项目内的非凭据路径');
        if (!fs.existsSync(target)) return { path: relative, exists: false };
        const real = path.relative(root, fs.realpathSync(target));
        if (real.startsWith('..') || path.isAbsolute(real)) throw new Error('路径的实际位置越出了项目');
        const stat = fs.statSync(target);
        return { path: relative, exists: true, directory: stat.isDirectory(), files: stat.isDirectory() ? fs.readdirSync(target).sort().slice(0, 100) : undefined, bytes: stat.isFile() ? stat.size : undefined };
      });
      const files = strs(p.hash_files);
      if (files.length > 16) throw new Error('一次最多核对 16 个文件');
      const hashes = [];let totalBytes=0;
      for (const relative of files) {
        const target = checked(relative);
        if (!fs.existsSync(target)) {hashes.push({path:relative,exists:false});continue;}
        const stat = fs.statSync(target);
        totalBytes+=stat.size;
        if (!stat.isFile() || stat.size > 256 * 1024 * 1024 || totalBytes > 512 * 1024 * 1024) throw new Error('摘要只支持单文件 256 MiB、合计 512 MiB 以内的普通文件');
        const hash=crypto.createHash('sha256');
        for await(const chunk of fs.createReadStream(target,{highWaterMark:256*1024,signal:context.signal}))hash.update(chunk);
        hashes.push({path:relative,exists:true,bytes:stat.size,sha256:hash.digest('hex')});
      }
      const env = currentEnvironment(), cfg = config.load(root, null);
      const modelFiles = ['am.mvn','config.yaml','configuration.json','model.pt','seg_dict','tokens.json'];
      const model = [env.ALIGN_MODEL, path.join(dataDir(env),'models','iic__speech_timestamp_prediction-v1-16k-offline')].filter((dir): dir is string => !!dir).find(dir => modelFiles.every(name => {
        try {return fs.statSync(path.join(dir,name)).isFile();} catch {return false;}
      }));
      const alignment_model = model ? {ready:true,path:model} : {ready:false,reason:'model_files_missing'};
      let git: Record<string, unknown> = {repository:false,reason:'not_initialized'};
      if (fs.existsSync(path.join(root,'.git'))) {
        try {
          const binary = lookPath('git.exe', env.PATH ?? '');
          const result = spawnSync(binary,['-C',root,'rev-parse','--is-inside-work-tree'],{env,encoding:'utf8',windowsHide:true,timeout:3000});
          git = result.status === 0 ? {repository:result.stdout.trim()==='true'} : {repository:false,reason:'metadata_unavailable',error:result.error?.message || result.stderr.trim().slice(0,300)};
        } catch {git={repository:false,reason:'git_unavailable'};}
      }
      const scenes = path.join(root, 'scenes');
      const running = fs.existsSync(scenes) ? fs.readdirSync(scenes).sort().flatMap((id) => {
        const live = path.join(scenes, id, `render-${id}.live.json`);
        if (!fs.existsSync(live)) return [];
        try { const state = JSON.parse(fs.readFileSync(live, 'utf8')); return [{ scene: id, started_at: state.started_at, pid: state.pid }]; } catch { return []; }
      }) : [];
      return { data: { platform: 'win32', python: windowsPython(env), alignment_model, configured_scene_jobs: cfg.sceneJobs, configuration: {ORCHESTRATOR:cfg.orchestrator,ORCHESTRATOR_MODEL:cfg.orchestratorModel,RENDERER:cfg.renderer,RENDERER_MODEL:cfg.rendererModel,TTS_PROVIDER:cfg.ttsProvider,ALIGN_PROVIDER:cfg.alignProvider}, git, hashes, running_scene_count: running.length, running_scenes: running, paths } };
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
  }, windowsAlignOperation()];
}

for (const operation of windowsOperations()) defineOp(operation);
