/**
 * 写进对话约定（studioInteraction）的界面互通说明：怎样切页、标步骤、记关卡确认。
 */
import type { Step, ViewPage } from './index';

function stepHints(all: readonly Step[]): string {
  const general = all.filter((x) => !x.flow).map((x) => `${x.id}（${x.hint}）`);
  const own = all.filter((x) => x.flow).map((x) => `${x.flow}项目的第一步是 ${x.id}（${x.hint}）`);
  return general.join('、') + own.map((x) => '；' + x).join('');
}

export function formatViewInteraction(allPages: readonly ViewPage[], allSteps: readonly Step[]): string {
  const pages = allPages.map((page) => {
    let item = page.id + '（' + page.label;
    if (page.target === 'scene') item += '，后面跟镜头编号';
    else if (page.target === 'scene?') item += '，可以跟镜头编号';
    else if (page.target === 'file') item += '，后面跟项目里的相对路径';
    return item + '）';
  });
  return (
    '- 要用户看某样东西时，调用 studio_show({"page": "<页面>", "target": "<对象>", "note": "一句说明"})（对象与说明可省），网页会直接切到那一页，比在回复里贴大段内容或让用户自己去找好。页面：' +
    pages.join('、') +
    '。例如口播稿写好、请用户审稿时调用 studio_show({"page": "script", "note": "口播稿写好了，请看一遍"})；某个镜头渲染完请用户看效果时调用 studio_show({"page": "scene", "target": "scene-003"})。不要连续切来切去，一次只把用户带到眼下最该看的那一页。口播稿、分镜计划与处理方案、镜头、成片与配音合成版、发布信息都有自己的页面，用那一页，不要用 file 页打开它们的原文。\n' +
    '- 每一轮结束前（汇报、停下来等用户之前）调用 studio_step({"step": "<步骤>"})，标出整片制作现在处在哪一步，网页顶栏会标出来：' +
    stepHints(allSteps) +
    '。它只做标记，不切页。\n' +
    '- 审核关卡（审稿、分镜审核这类停下来等用户确认的地方）：用户在对话里明确确认了（例如「就按这个分镜，开始渲染」），接着往下做之前先调用 studio_confirm({"said": "<用户确认的原话>"})，制作路线上那一关会标成已确认；用户只是提修改意见、或还没表态时不要调用，也不要替用户确认。\n' +
    '- 用户的消息后面可能附一句「用户发这条消息时，Studio 网页上开着……」，说的是用户正在看的页面；用户说「这个镜头」「这段」时指的就是那里。'
  );
}
