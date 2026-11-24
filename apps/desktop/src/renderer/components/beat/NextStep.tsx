import type { ReactNode } from 'react';
import { useState } from 'react';
import { errorText, post } from '../../api';
import type { Attachment, BeatState } from '../../types';

/** 在节拍页直接装节拍分析工具：走客户端的安装页同一个接口，进度在顶栏「还差几项工具」里也看得到。 */
function InstallBeatTools() {
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState('');
  const start = async () => {
    setState('running');
    try {
      await post('/api/setup/run', { only: ['beat'] });
    } catch (err) {
      setState('error');
      setError(errorText(err));
    }
  };
  if (state === 'running')
    return <span className="beat-installing">正在安装，装好后这里会自动往下走（进度在顶栏的工具准备里）</span>;
  return (
    <>
      <button className="primary" onClick={() => void start()}>
        安装节拍分析工具
      </button>
      {state === 'error' && <span className="beat-install-error">{error}</span>}
    </>
  );
}

/** 「接下来」：用一句话说清楚下一步做什么、由谁做，按钮把这件事交给对话或指向页面里的控件。 */
export function nextStep(
  stage: number,
  b: BeatState | null,
  busy: boolean,
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void,
): { text: string; action?: ReactNode } | null {
  const ask = (label: string, text: string, draftOnly = false) => (
    <button className="primary" disabled={busy && !draftOnly} onClick={() => onQuick(text, [], draftOnly)}>
      {label}
    </button>
  );
  switch (stage) {
    case 0:
      return {
        text: '先把故事定下来：这部片子讲什么、情绪怎么走，每一段画面里出现哪些字、配哪句字幕。故事和文案写好、你看过之后，再挑音乐、对节拍。',
        action: ask('让它写故事和文案', '先写这部卡点片的故事和文案（production/beat/story.md），写好带我到节拍页看。'),
      };
    case 1:
      return {
        text: '故事有了，接下来选音乐。把音乐文件拖进对话框，或者说想要什么样的曲子；导入后会自动分析出节拍。',
        action: ask('在对话里导入音乐', '导入这首音乐并分析节拍：', true),
      };
    case 2:
      if (b?.analyzer && !b.analyzer.ready) {
        return {
          text: b.analyzer.command
            ? '音乐已导入。分析节拍要用的工具还没装（约 1 GB，所有卡点项目共用，只装一次），装好再回来分析。'
            : `音乐已导入，但 beat.yaml 指定的 Python 不存在（${b.analyzer.location}）。改成存在的路径，或删掉 python 这一行改用共享环境。`,
          action: b.analyzer.command ? <InstallBeatTools /> : undefined,
        };
      }
      return {
        text: '音乐已导入，还没有分析节拍。分析完会在下面画出每一拍和每个小节。',
        action: ask('让它分析节拍', '分析这首音乐的节拍（beat_analyze），分析完带我去节拍页试听。'),
      };
    case 3:
      return {
        text: '试听下面的节拍：每拍一声，重拍更高。「1」都落在音乐的重音上，就点「听过了，确认网格」；对不上就换每小节几拍或重拍是第几拍。',
      };
    case 4:
      return {
        text: `节拍已确认${b?.track ? `，共 ${b.grid?.downbeats.length ?? 0} 小节` : ''}。接下来按小节把故事切成镜头：每段占几小节、切点落在哪个重拍上，写好会在波形上方显示镜头条。`,
        action: ask(
          '按小节写分镜计划',
          '节拍网格确认了，按故事稿的段落按小节写分镜计划（production/beat/plan.json），写好带我回节拍页看切点。',
        ),
      };
    case 5:
      return {
        text: `分镜计划和节拍对上了：${b?.plan?.length ?? 0} 个镜头，切点全在重拍上。接下来建镜头、写入时长，再逐个渲染。`,
        action: ask(
          '开始做镜头',
          '分镜计划确认了。建好镜头目录，用 beat_cues 写入时长与拍点（args 填 scenes/），然后开始渲染镜头。',
        ),
      };
  }
  return null;
}
