/**
 * 单人歌曲讲解的操作：生成或导入候选、试听选择、歌词对齐、镜头歌曲 cue 与合成。由歌曲讲解插件在 apply 里登记
 * （songOps），cli 的操作表经 plugin_ops.ts 照旧 defineOp。
 */
import path from 'node:path';
import { envMap } from '../../envutil';
import { newToolchain } from '../../mediaprobe';
import { bool, positiveDuration, projectRoot, str, timeout, withTimeoutSignal } from '../../opkit';
import type { PluginContext } from '../../plugin/types';
import * as scene from '../../scene';
import * as schedule from '../../schedule';
import * as song from '../../song';
import { applySongCues, formatList, songCoverage, songOutputsCurrent } from './cues';
import { registerSongAuthorOps, type SongOpDef } from './ops_author';

export { applySongCues, songCoverage, songOutputsCurrent, songScaffold } from './cues';

const currentEnvironment = (): Record<string, string> => envMap();

export function songOps(ctx: PluginContext): void {
  ctx.opGroup({
    path: ['song'],
    summary: '单人歌曲讲解：生成、试听选择、歌词对齐与镜头节拍',
    description:
      '歌曲讲解以 song.yaml 启用，与默认口播独立。先生成或导入候选，用户试听 song_select() 后 song_prepare()；核对时间轴再 song_cues()、validate_song() 和渲染。song_providers() 查看平台与 API Key 申请入口，song_configure() 选择平台。首版不支持 cast。所有产物保存在 production/song，密钥仅来自进程环境。',
  });

  const songRoot = { ...projectRoot, description: '歌曲项目根目录' };
  const songTimeout = timeout('30m', '生成/对齐（ACE-Step/fal/Mureka 可续跑）');

  /** 带超时的歌曲操作：project_root 与 timeout 两个参数，超时与调用方的取消合在一起。 */
  function songOp(def: SongOpDef): void {
    ctx.op({
      name: def.name,
      cli: ['song', def.cli],
      summary: def.summary,
      description: def.summary + '。\n\n' + def.help,
      examples: def.examples,
      params: {
        ...(def.params ?? {}),
        project_root: songRoot,
        timeout: songTimeout,
      },
      run: (p, opCtx) =>
        def.run(p, opCtx, withTimeoutSignal(opCtx.signal, positiveDuration(p.timeout, 'timeout')), str(p.project_root)),
    });
  }

  registerSongAuthorOps(ctx, songOp, songRoot);

  songOp({
    name: 'song_prepare',
    cli: 'prepare',
    summary: '对齐歌词、分析节拍，或导入修正时间轴',
    help: '默认调用独立 Python 环境中的 Xingyu 0.6.1，再用 librosa 0.11.0 提取真实节拍；模型由用户独立安装。保留原始报告、行映射和问题清单。失败时修正 timeline-draft.json，通过 timeline 导入；确认歌词、术语和句首误差后加 "reviewed": true 才能分镜渲染。估算字词不参与逐字同步。',
    examples: ['song_prepare()', 'song_prepare({"timeline": "production/song/timeline.json", "reviewed": true})'],
    params: {
      timeline: {
        type: 'string',
        description: '导入人工修正的统一时间轴 JSON',
      },
      reviewed: {
        type: 'boolean',
        description: '确认导入的时间轴已核对歌词、术语和句首时间',
      },
    },
    run: async (p, { out }, signal, root) => {
      const canvas = scene.canvasOf(root, 'frame.md');
      await song.prepare(root, str(p.timeline), bool(p.reviewed), currentEnvironment(), out, signal);
      song.exportPhrases(root, canvas.fps);
    },
  });

  songOp({
    name: 'song_cues',
    cli: 'cues',
    summary: '计算镜头局部歌词和节拍，绑定全局摘要',
    help: '按镜头目录字典序累计整数帧时长，将全局歌词及节拍裁切为局部秒数。总长度必须为 ceil(实际歌曲秒数 × fps)，含前奏与尾奏。更新 scene.json 的 song 块和 song-cues.json；校验失败不写文件，成功后旧镜头需 "force": true 重渲染。',
    examples: ['song_cues({"scenes": "scenes/"})'],
    params: {
      scenes: {
        type: 'string',
        description: '镜头目录的上级目录',
        required: true,
        positional: 0,
      },
    },
    run: (p, { out }, _signal, root) => {
      applySongCues(root, str(p.scenes), out);
    },
  });

  songOp({
    name: 'song_mux',
    cli: 'mux',
    summary: '将完整歌曲与整数帧静音母版合成',
    help: '检查静音母版总帧数与歌曲时间轴一致，复制视频并加入完整歌曲。只允许末尾不足一帧的静音补齐，不变速、不叠 BGM、不做侧链。输出为 MP4 并执行完整解码与规格检查。',
    examples: ['song_mux({"master": "production/silent-master.mp4", "out": "final.mp4"})'],
    params: {
      master: {
        type: 'string',
        description: '静音母版',
        required: true,
        positional: 0,
      },
      out: { type: 'string', description: '成片输出路径（MP4）' },
    },
    run: async (p, _ctx, signal, root) => {
      const master = str(p.master);
      const output = str(p.out);
      if (output === '') throw new Error('必须提供 out');
      const t = song.loadTimeline(root);
      if (!t.reviewed) throw new Error('时间轴尚未人工复核');
      const c = song.selected(root);
      let dir = '';
      try {
        dir = song.candidateDir(root, c.id);
      } catch {
        // Go 版忽略这里的错误。
      }
      const canvas = scene.canvasOf(root, 'frame.md');
      const m = newToolchain(currentEnvironment());
      const report = m.verify(master, {
        spec: { widthPx: canvas.widthPx, heightPx: canvas.heightPx },
      });
      if (!report.ok) throw new Error(`静音母版画幅不符：${formatList(report.problems ?? [])}`);
      const scenes = schedule.plan(path.join(root, 'scenes'));
      songCoverage(root, scenes, t, true);
      songOutputsCurrent(scenes, master);
      await m.muxSong(master, path.join(dir, c.audio), output, t.duration_seconds, canvas.fps, signal);
      return { data: { out: output } };
    },
  });

  ctx.op({
    name: 'validate_song',
    cli: ['validate', 'song'],
    summary: '校验歌曲选择、歌词、时间轴和镜头覆盖',
    verb: '校验歌曲时间轴',
    description:
      '检查已选歌曲和歌词摘要、已人工复核的统一时间轴，以及所有镜头从零至尾奏的整数帧覆盖。检查每镜头局部歌词和全局摘要；发现过期依赖时必须重跑 song_cues() 并重渲染。不通过时报错。',
    examples: ['validate_song()'],
    params: {
      project_root: projectRoot,
      scenes: { type: 'string', description: '镜头目录，默认项目 scenes/' },
    },
    run: (p, { out }) => {
      const root = str(p.project_root);
      const t = song.loadTimeline(root);
      if (!t.reviewed) throw new Error('时间轴尚未人工复核');
      const dir = str(p.scenes) !== '' ? str(p.scenes) : path.join(root, 'scenes');
      const scenes = schedule.plan(dir);
      songCoverage(root, scenes, t, true);
      out.write('歌曲与镜头时间轴校验通过\n');
      return { data: { ok: true, scenes: scenes.length } };
    },
  });
}
