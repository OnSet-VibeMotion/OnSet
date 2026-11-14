import type {ActivityStep} from '../types';

/** Use actual provider/tool events. A completed command is not a currently running render. */
export function windowsRenderProgress(steps:ActivityStep[],completeToolEvents=true):{title:string;line?:string;quiet:string} {
  const last=steps.at(-1);
  if(!last)return {title:'启动中',quiet:'等待制作进程的第一条日志'};
  if(last.kind==='error'&&/reconnect|stream disconnected|tls handshake|连接.*重试/i.test(last.text??''))return {title:'连接重试中',line:last.text,quiet:'模型连接中断，正在重连；已有文件保持保留'};
  if(last.kind==='tool'&&last.state==='running'){
    const tool=(last.tool??'').replace(/^mcp__onset__/,'');
    const input=last.input&&typeof last.input==='object'?last.input as Record<string,unknown>:{};
    if(tool==='hyperframes'&&input.subcommand==='render')return {title:'取帧与编码中',quiet:'渲染工具尚未返回结果'};
    return {title:'工具运行中',quiet:'正在等待当前工具返回结果'};
  }
  if(last.kind==='text'&&(last.text??'').includes('视频已渲染完成'))return {title:'收尾中',quiet:'视频已报告生成，等待制作进程完成收尾'};
  if(last.kind==='text')return {title:'制作中',quiet:'正在等待下一条制作日志'};
  if(last.kind==='error')return {title:'处理错误中',line:last.text,quiet:'当前步骤发生错误，等待制作进程处理'};
  return completeToolEvents?{title:'等待模型响应',line:'上一项已结束，等待模型继续',quiet:'当前没有工具在执行，正在等待模型继续回复'}:{title:'等待状态更新',line:'上一项已结束，等待后续日志',quiet:'上一项已结束，等待后续日志'};
}
