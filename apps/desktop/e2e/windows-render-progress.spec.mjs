import fs from 'node:fs';
import path from 'node:path';
import {test,expect,openProject} from './fixtures.mjs';

test('distinguishes model waiting, MCP rendering, reconnecting and completion on Windows',async({page,project})=>{
 test.skip(process.platform!=='win32','Windows progress adaptation');
 const directory=path.join(project.path,'scenes/scene-001'),stream=path.join(directory,'render-scene-001.stream.jsonl'),live=path.join(directory,'render-scene-001.live.json');
 const done={type:'item.completed',item:{id:'cmd',type:'command_execution',command:'inspect existing files',aggregated_output:'done',exit_code:0,status:'completed'}};
 fs.writeFileSync(stream,[{type:'thread.started',thread_id:'fixture'},done].map(row=>JSON.stringify(row)).join('\n')+'\n');
 fs.writeFileSync(live,JSON.stringify({pid:process.pid,renderer:'codex',started_at:new Date(Date.now()-180000).toISOString()}));
 const quiet=()=>{const old=new Date(Date.now()-110000);fs.utimesSync(stream,old,old);};quiet();
 await openProject(page,project);
 const card=page.locator('[data-render-scene="scene-001"]');
 await expect(card.locator('.ra-title')).toHaveText('scene-001 等待模型响应');
 await expect(card.locator('.ra-quiet')).toContainText('当前没有工具在执行');
 const item={id:'render',type:'mcp_tool_call',server:'onset',tool:'hyperframes',arguments:{subcommand:'render'}};
 fs.appendFileSync(stream,JSON.stringify({type:'item.started',item})+'\n');
 await expect(card.locator('.ra-title')).toHaveText('scene-001 取帧与编码中');
 fs.appendFileSync(stream,JSON.stringify({type:'item.completed',item:{...item,status:'completed',error:null,result:{content:[{type:'text',text:'render done'}]}}})+'\n'+JSON.stringify({type:'error',message:'Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)'})+'\n');quiet();
 await expect(card.locator('.ra-title')).toHaveText('scene-001 连接重试中');
 await expect(card.locator('.ra-current')).toContainText('tls handshake eof');
 await expect(card.locator('.ra-quiet')).toContainText('正在重连');
 fs.writeFileSync(path.join(directory,'render-scene-001.attempt.json'),JSON.stringify({schema:1,scene_id:'scene-001',renderer:'codex',outcome:'succeeded',started_at:new Date().toISOString(),ended_at:new Date().toISOString()}));fs.unlinkSync(live);
 await expect(card).toHaveCount(0,{timeout:6000});
});
