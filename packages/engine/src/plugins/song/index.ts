/**
 * 内置插件「歌曲讲解」（song）的进程内登记：它带来的流程 song 与那个流程的制作提示词段落。
 *
 * 只登记流程与段落。歌曲讲解的操作、in_use 仍经清单（assets/plugins/song/am-station.json 的 am_ops，过渡做法），
 * 引擎代码（song/）、镜头的 song 块与 song-explainer 技能都不动：它们进项目文件与渲染指纹。
 *
 * | 段落 | 用在哪 |
 * |---|---|
 * | main、contract-head、contract | 流程 song 的提示词：PROMPT-SONG.md，再接「歌曲模式必要契约」与同一份内置正文。与老项目的 runPrompt 逐字节相同 |
 * | branch（prompt.md） | 口播流程提示词的最后一节「歌曲讲解分支」。老项目由清单的 prompt 在运行时接上，所以它不进生成的 PROMPT-PRODUCTION.md |
 *
 * PROMPT-SONG.md 仍在 assets/shared/（随新建项目下发到项目根，song_init 也从那里拷），段落直接读它，不另放一份。
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
      // 路线上没有自己的站点：歌曲讲解的路线暂时沿用口播（流程 song 的 base），与老项目一致。
      nodes: [],
      flows: [],
      after: '',
      sections: [
        { id: 'branch', file: 'prompt.md', append: true, flows: ['speech'] },
        { id: 'main', file: '../../shared/PROMPT-SONG.md' },
        { id: 'contract-head', file: 'sections/contract-head.md' },
        { id: 'contract', file: '../../shared/PROMPT-SONG.md' },
      ],
    });
    ctx.flow({
      id: SongFlow,
      name: '歌曲讲解',
      base: 'speech',
      prompt: ['song-prompt/main', 'song-prompt/contract-head', 'song-prompt/contract'],
      first_page: 'script',
      marker: { file: 'song.yaml', body: DefaultConfig },
      excludes: { plugins: ['cast'], message: '首版不支持 song + cast' },
    });
  },
};
