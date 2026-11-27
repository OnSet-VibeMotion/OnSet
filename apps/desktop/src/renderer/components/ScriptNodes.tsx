import type { ScriptBlock, ScriptNode, ScriptResponse } from '../types';

export const timingNotes: Record<NonNullable<ScriptResponse['voice']>['timing'], string> = {
  dialogue: '点击角色名，从这句开始试听',
  aligned: '逐字跟读 · 点击文字可跳转试听',
  subtitled: '按字幕逐句跟读 · 点击文字可跳转试听',
  segmented: '按配音段落跟读，完成对齐后会更准确 · 点击文字可跳转试听',
  estimated: '逐字跟读按时长估算，完成对齐后会更准确 · 点击文字可跳转试听',
};

export function duration(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 给正文段落编号（标题不算），右键引用时说「口播稿第 3 段」。 */
export function numberParagraphs(blocks: ScriptBlock[]): { block: ScriptBlock; para: number }[] {
  let para = 0;
  return blocks.map((block) => ({ block, para: block.kind === 'para' ? ++para : 0 }));
}

/** 稿子里有没有读法或短语标记：没有就不显示图例。 */
export function hasMarks(nodes: ScriptNode[]): boolean {
  return nodes.some((node) => node.kind !== 'text' || hasMarks(node.children ?? []));
}

interface Reading {
  time: number;
  onSeek: (time: number) => void;
}

function Characters({
  text = '',
  timings,
  time,
  onSeek,
}: { text?: string; timings?: ScriptNode['timings'] } & Reading) {
  if (!timings) return <>{text}</>;
  return (
    <>
      {[...text].map((char, i) => {
        const timing = timings[i];
        return timing ? (
          <span
            key={i}
            className={`script-char${time >= timing.start && time < timing.end ? ' now' : ''}`}
            data-start={timing.start}
            title="点击跳到这里试听"
            onClick={() => {
              if (window.getSelection()?.isCollapsed !== false) onSeek(timing.start);
            }}
          >
            {char}
          </span>
        ) : (
          <span key={i}>{char}</span>
        );
      })}
    </>
  );
}

export function ScriptNodes({ nodes, time, onSeek }: { nodes: ScriptNode[] } & Reading) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'alt':
            if (!node.text) {
              return (
                <span key={index} className="spoken-only" title="只朗读、不显示在字幕里">
                  <Characters text={node.spoken} timings={node.timings} time={time} onSeek={onSeek} />
                </span>
              );
            }
            if (!node.spoken) {
              return (
                <span key={index} className="display-only" title="只显示在字幕里、不朗读">
                  {node.text}
                </span>
              );
            }
            return (
              <ruby key={index} className="alt" title={`字幕显示「${node.text}」，配音读作「${node.spoken}」`}>
                <Characters text={node.text} timings={node.timings} time={time} onSeek={onSeek} />
                <rt>{node.spoken}</rt>
              </ruby>
            );
          case 'phrase':
            return (
              <mark
                key={index}
                className="phrase"
                title={`受保护短语 ${node.id}：会单独出现在画面上，配音不能在中间断开`}
              >
                <ScriptNodes nodes={node.children ?? []} time={time} onSeek={onSeek} />
              </mark>
            );
          default:
            return (
              <span key={index}>
                <Characters text={node.text} timings={node.timings} time={time} onSeek={onSeek} />
              </span>
            );
        }
      })}
    </>
  );
}
