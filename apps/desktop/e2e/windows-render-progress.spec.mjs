import fs from 'node:fs';
import path from 'node:path';
import {test,expect,openProject} from './fixtures.mjs';

test('distinguishes model waiting, MCP rendering, reconnecting and completion on every platform',async({page,project})=>{
 const directory=path.join(project.path,'scenes/scene-001'),stream=path.join(directory,'render-scene-001.stream.jsonl'),live=path.join(directory,'render-scene-001.live.json');
 const done={type:'item.completed',item:{id:'cmd',type:'command_execution',command:'inspect existing files',aggregated_output:'done',exit_code:0,status:'completed'}};
 fs.writeFileSync(stream,[{type:'thread.started',thread_id:'fixture'},done].map(row=>JSON.stringify(row)).join('\n')+'\n');
 fs.writeFileSync(live,JSON.stringify({pid:process.pid,renderer:'codex',started_at:new Date(Date.now()-180000).toISOString()}));
 const quiet=()=>{const old=new Date(Date.now()-110000);fs.utimesSync(stream,old,old);};quiet();
 await openProject(page,project);
 const card=page.locator('[data-render-scene="scene-001"]');
 await expect(card.locator('.ra-title')).toHaveText('镜头 01');
 await expect(card.locator('.ra-status')).toHaveText('等模型回复');
 await expect(card.locator('.ra-freshness')).toHaveClass(/is-quiet/);
 await expect(card.locator('.ra-elapsed')).toContainText('累计');
 await expect(card.locator('.ra-freshness')).toContainText('未更新');
 const item={id:'render',type:'mcp_tool_call',server:'onset',tool:'hyperframes',arguments:{subcommand:'render'}};
 fs.appendFileSync(stream,JSON.stringify({type:'item.started',item})+'\n');
 await expect(card.locator('.ra-phase')).toHaveText('生成视频');
 await expect(card.locator('.ra-status')).toHaveText('进行中');
 // 后启动的命令已经结束，前面的 MCP 渲染仍在跑：不能误报为等模型。
 fs.appendFileSync(stream,JSON.stringify({...done,item:{...done.item,id:'parallel-command'}})+'\n');
 await expect(card.locator('.ra-phase')).toHaveText('生成视频');
 await expect(card.locator('.ra-status')).toHaveText('进行中');
 await expect(card.locator('.ra-current')).toHaveText('正在渲染视频');
 fs.appendFileSync(stream,JSON.stringify({type:'item.completed',item:{...item,status:'completed',error:null,result:{content:[{type:'text',text:'render done'}]}}})+'\n'+JSON.stringify({type:'error',message:'Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)'})+'\n');quiet();
 await expect(card.locator('.ra-status')).toHaveText('正在重连');
 await expect(card.locator('.ra-current')).toHaveText('模型连接中断，正在重试');
 await card.locator('.ra-head').click();
 await expect(card.locator('.ra-step').last()).toContainText('tls handshake eof');
 fs.writeFileSync(path.join(directory,'render-scene-001.attempt.json'),JSON.stringify({schema:1,scene_id:'scene-001',renderer:'codex',outcome:'succeeded',started_at:new Date().toISOString(),ended_at:new Date().toISOString()}));fs.unlinkSync(live);
 await expect(card).toHaveCount(0,{timeout:6000});
});

test('keeps runtime paths and check flags in details instead of render summaries',async({page,project})=>{
 const directory=path.join(project.path,'scenes/scene-001'),stream=path.join(directory,'render-scene-001.stream.jsonl');
 const command='"C:\\Program Files\\WindowsApps\\OpenAI.CodexRuntime\\pwsh.exe" -Command "inspect scene files"';
 const shell={id:'shell',type:'command_execution',command,status:'in_progress'};
 fs.writeFileSync(stream,[{type:'thread.started',thread_id:'fixture'},{type:'item.started',item:shell}].map(row=>JSON.stringify(row)).join('\n')+'\n');
 fs.writeFileSync(path.join(directory,'render-scene-001.live.json'),JSON.stringify({pid:process.pid,renderer:'codex',started_at:new Date().toISOString()}));
 await openProject(page,project);
 const card=page.locator('[data-render-scene="scene-001"]');
 await expect(card.locator('.ra-current')).toHaveText('正在运行制作命令');
 await card.locator('.ra-head').click();
 await expect(card.locator('.ra-target')).toContainText('OpenAI.CodexRuntime');
 const check={id:'check',type:'mcp_tool_call',server:'onset',tool:'hyperframes',arguments:{subcommand:'check',args:['--json']}};
 fs.appendFileSync(stream,JSON.stringify({type:'item.completed',item:{...shell,status:'completed',aggregated_output:'ok',exit_code:0}})+'\n'+JSON.stringify({type:'item.started',item:check})+'\n');
 await expect(card.locator('.ra-current')).toHaveText('正在检查画面');
 await expect(card.locator('.ra-phase')).toHaveText('检查画面');
 await expect(card.locator('.ra-step').last().locator('.ra-target')).toHaveText('--json');
});
