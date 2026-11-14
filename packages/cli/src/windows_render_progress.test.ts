import {expect,it} from 'vitest';
import {windowsRenderProgress} from '../../../apps/desktop/src/renderer/components/render-progress';

it('distinguishes a running renderer from a completed shell command waiting for the model',()=>{
 expect(windowsRenderProgress([{kind:'tool',tool:'shell',state:'done'}]).title).toBe('等待模型响应');
 expect(windowsRenderProgress([{kind:'tool',tool:'shell',state:'done'}],false).title).toBe('等待状态更新');
 expect(windowsRenderProgress([{kind:'tool',tool:'mcp__onset__hyperframes',input:{subcommand:'render'},state:'running'}]).title).toBe('取帧与编码中');
 expect(windowsRenderProgress([{kind:'tool',tool:'mcp__onset__job_wait',state:'running'}]).title).toBe('工具运行中');
});

it('shows connection retry evidence and resets that status once real work resumes',()=>{
 const retry={kind:'error' as const,text:'Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)'};
 expect(windowsRenderProgress([retry])).toMatchObject({title:'连接重试中',line:retry.text});
 expect(windowsRenderProgress([retry,{kind:'tool',tool:'shell',state:'running'}]).title).toBe('工具运行中');
 expect(windowsRenderProgress([{kind:'text',text:'[[USER_MESSAGE]]视频已渲染完成：scene-005.mp4'}]).title).toBe('收尾中');
 expect(windowsRenderProgress([{kind:'text',text:'已完成入口修订，正在检查'}])).toMatchObject({title:'制作中'});
 expect(windowsRenderProgress([{kind:'text',text:'已完成入口修订，正在检查'}]).line).toBeUndefined();
});
