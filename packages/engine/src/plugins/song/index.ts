/**
 * 内置插件「歌曲讲解」（song）的进程内登记：它带来的流程 song 与那个流程的制作提示词段落。
 *
 * 只登记流程与段落。歌曲讲解的操作、in_use 仍经清单（assets/plugins/song/am-station.json）。
 * 引擎代码（song/）、镜头的 song 块与 song-explainer 技能都不动：它们进项目文件与渲染指纹。
 *
 * 流程 song 的提示词只有一段 main（assets/plugins/song/sections/main.md）：歌曲讲解的完整制作说明。
 */
import type { BuiltinPlugin } from '../../plugin/types';
import { DefaultConfig } from '../../song/store';

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
    });
  },
};
