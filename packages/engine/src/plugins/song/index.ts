/**
 * 内置插件「歌曲讲解」（song）的进程内登记：流程 song 与它的制作提示词段落、song_* 操作与 validate_song（ops.ts）、
 * 渲染技能 song-explainer（skill.ts）、镜头的 song 块（block.ts）、渲染与拼接前的整批检查，以及「项目里有 song.yaml
 * 就不许关」。引擎里的歌曲实现（song/）仍在原包里，这里引用它。
 *
 * 流程 song 的提示词只有一段 main（assets/plugins/song/sections/main.md）：歌曲讲解的完整制作说明。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BuiltinPlugin } from '../../plugin/types';
import * as song from '../../song';
import { DefaultConfig } from '../../song/store';
import { songBlock } from './block';
import { songCoverage, songOps, songOutputsCurrent } from './ops';
import { songExplainerSkill } from './skill';

export { songBlock, verifySongInputs } from './block';
export { applySongCues, songCoverage, songOutputsCurrent, songScaffold } from './ops';
export { SongExplainerSkillName, songExplainerPrompt } from './skill';

const songTimelineParam = 'song_timeline';

/** 歌曲讲解流程的 id（锁文件记的就是它）。 */
export const SongFlow = 'song';

export const songPlugin: BuiltinPlugin = {
  id: 'song',
  apply(ctx) {
    ctx.station({
      // 站 id 不能与插件 id 相同（清单也按站解析），所以叫 song-prompt。
      id: 'song-prompt',
      name: '歌曲讲解',
      // 路线上没有自己的站点：歌曲讲解的路线暂时沿用口播（流程 song 的 base）。
      nodes: [],
      flows: [],
      after: '',
      sections: [{ id: 'main', file: 'sections/main.md' }],
    });
    ctx.flow({
      id: SongFlow,
      name: '歌曲讲解',
      base: 'speech',
      prompt: ['song-prompt/main'],
      first_page: 'script',
      marker: { file: 'song.yaml', body: DefaultConfig },
      excludes: { plugins: ['cast'], message: '首版不支持 song + cast' },
      // 开工前读一遍 song.yaml：写坏了在组合提示词时就报，不等编排工具跑到一半。
      check: (root) => void song.loadConfig(root),
    });
    songOps(ctx);
    ctx.skill(songExplainerSkill());
    ctx.sceneBlock(songBlock);
    ctx.preset({
      id: 'song',
      label: '歌曲 MV',
      hint: '把内容写成一首歌来讲',
      delivery: SongFlow,
      narration: 'solo',
      canvas: 'vertical-9x16',
      example: '把这篇文章写成一首歌，做成带歌词的 MV',
    });
    ctx.inUse((root) => (fs.existsSync(path.join(root, 'song.yaml')) ? 'song.yaml' : ''));
    ctx.renderCheck({
      params: { [songTimelineParam]: { type: 'string', description: '歌曲覆盖基准，与 srt 互斥；包含前奏至尾奏' } },
      // 覆盖校验在渲染之前跑：漏掉一镜或某镜时长写错，等全部渲染完拼接时才发现的话，每一镜都已经烧掉一次 AI CLI 调用。
      beforeRender(root, scenes, params) {
        const timeline = typeof params[songTimelineParam] === 'string' ? (params[songTimelineParam] as string) : '';
        if (timeline !== '' && typeof params.srt === 'string' && params.srt !== '') throw new Error('song_timeline 与 srt 互斥');
        if (timeline !== '') {
          const file = path.resolve(timeline);
          const songRoot = path.dirname(path.dirname(path.dirname(file)));
          if (file !== path.join(songRoot, song.Store, 'timeline.json')) throw new Error('song_timeline 必须指向 production/song/timeline.json');
          songCoverage(songRoot, scenes, song.loadTimeline(songRoot), true);
        } else if (song.enabled(root)) {
          throw new Error('歌曲项目必须提供 song_timeline：production/song/timeline.json');
        }
        if (timeline === '' && scenes.some((s) => s.song !== null)) throw new Error('歌曲镜头必须提供 song_timeline：production/song/timeline.json');
      },
      // 有人绕过 run-all 直接拼接时，同样拒绝过期的歌曲镜头。
      beforeConcat(_root, scenes) {
        songOutputsCurrent(scenes, '');
      },
    });
  },
};
