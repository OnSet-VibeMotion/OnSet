import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, api, installPlugin } from './fixtures.mjs';

const origin = 'https://creator.example.test';
// 像抖音的编辑页：只在 beforeunload 里把编辑中的内容存成草稿，存完还要求确认离开。
// 存草稿故意慢一点（同步忙等 1500ms，仍在 UnloadGraceMs 内）：退出不等关闭流程的话，进程会在存完之前就结束了；
// 也给「移除期间另一连接重开」的用例留出落进销毁窗口的时间。
const draftOnUnload = `<script>addEventListener('beforeunload', e => { const t=Date.now(); while(Date.now()-t<1500){} localStorage.setItem('draft', 'saved-before-unload'); e.preventDefault(); e.returnValue = ''; })</script>`
  // 也像编辑中的网站那样随时往本地存储写：片场开着页面时几秒内就要落到磁盘上，不等关窗口。
  + `<script>localStorage.setItem('live', 'written-while-open')</script>`;
const html = draftOnUnload + '<input type="file"><input id="title"><input id="typed"><button onclick="window.published=true">发布</button><button id="poke" style="position:fixed;left:10px;top:200px;width:80px;height:30px" onclick="window.poked=event.isTrusted">点我</button>';

for (const shutdown of ['application', 'window', 'page-before-window', 'quit-with-all-closing']) test(`plugin fills an embedded page, leaves manual publishing available, isolates accounts and revokes automation (${shutdown})`, async ({ electronApp, page, project, sandbox }) => {
  const errors = [];
  electronApp.on('console', message => {
    if (message.text().startsWith('STATION_BROWSER_UNCAUGHT:')) errors.push(message.text());
  });
  // 默认异常对话框会阻塞测试退出；收集后显式断言，异常仍然让测试失败。
  await electronApp.evaluate(({ dialog }) => {
    dialog.showErrorBox = (title, content) => console.error('STATION_BROWSER_UNCAUGHT:' + title + '\n' + content);
  });
  const dir = path.join(sandbox.home, 'embedded-plugin');
  fs.writeFileSync(path.join(project.path, 'upload.mp4'), 'fixture-video');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'onset-station.json'), JSON.stringify({
    id: 'embedded-helper', name: '内嵌上传', version: '1', nodes: [{ id: 'embedded-step', label: '内嵌页面', step: 'publish', outputs: ['production/embedded/done.json'] }], browser: { origins: [origin] },
    produces: [{ prefix: 'production/embedded/' }],
    ops: [{ name: 'prepare', summary: '准备网页', trigger: 'user', command: ['{node}', 'prepare.cjs'], params: { account: { type: 'string', required: true, description: '账号编号' } } },
      { name: 'forget', summary: '移除账号', trigger: 'user', command: ['{node}', 'forget.cjs'], params: { account: { type: 'string', required: true, description: '账号编号' } } },
      { name: 'reopen', summary: '重开账号', trigger: 'user', command: ['{node}', 'reopen.cjs'], params: { account: { type: 'string', required: true, description: '账号编号' } } }],
  }));
  fs.writeFileSync(path.join(dir, 'prepare.cjs'), `
let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end', async()=>{
 try {
  const r=JSON.parse(input), b=r.browser;
  const rpc=async(body)=>{ const response=await fetch(b.endpoint,{method:'POST',headers:{authorization:'Bearer '+b.token,'content-type':'application/json'},body:JSON.stringify(body)}); const result=await response.json(); if(!response.ok)throw Error(result.error); return result; };
  const opened=await rpc({action:'open',account:r.params.account,label:r.params.account,url:'${origin}/'});
  const command=(method,params)=>rpc({action:'command',method,params});
  // 自动操作期间盖上遮罩：下面的上传、填写、键盘与鼠标都在遮罩下进行，照样要生效。
  const badBusy=[];
  for(const body of [{action:'busy',message:'x',progress:2},{action:'busy',message:''},{action:'busy',message:'a\\nb'}]){ try { await rpc(body); badBusy.push(false); } catch { badBusy.push(true); } }
  await rpc({action:'busy',message:'正在上传视频 40%',progress:0.4});
  const masked=(await rpc({action:'state'})).busy;
  const unauthorized=await fetch(b.endpoint,{method:'POST',headers:{authorization:'Bearer wrong'},body:'{}'});
  const fromPage=await fetch(b.endpoint,{method:'POST',headers:{authorization:'Bearer '+b.token,origin:'https://creator.example.test'},body:'{}'});
  const rejected=[];
  for(const [method,params] of [['Page.navigate',{url:'file:///etc/passwd'}],['Page.navigate',{url:'https://outside.example/'}],['Network.getAllCookies',{}],['DOM.setFileInputFiles',{files:[r.data_dir+'/outside.mp4']}],['DOM.setFileInputFiles',{files:[r.project_root+'/escape.mp4']}],['DOM.setFileInputFiles',{files:[r.project_root+'/upload.mp4'],nodeId:1}],['Input.dispatchKeyEvent',{type:'bogus'}],['Input.dispatchMouseEvent',{type:'mouseWheel',x:1,y:1}],['Input.dispatchMouseEvent',{type:'mousePressed'}]]) {
    try { await command(method,params); rejected.push(false); } catch { rejected.push(true); }
  }
  const object=await command('Runtime.evaluate',{expression:'document.querySelector(\"input[type=file]\")'});
  await command('DOM.setFileInputFiles',{objectId:object.result.objectId,files:[r.project_root+'/upload.mp4']});
  const result=await command('Runtime.evaluate',{expression:'document.cookie',returnByValue:true});
  await command('Runtime.evaluate',{expression:'document.querySelector("#title").value="自动填写"; document.cookie="account='+r.params.account+'; max-age=86400; path=/"',returnByValue:true});
  // 键盘与鼠标：像人一样逐字输入、真的点一下（页面看到的是可信事件）。
  await command('Runtime.evaluate',{expression:'document.querySelector("#typed").focus()'});
  for(const key of ['#','话']){ await command('Input.dispatchKeyEvent',{type:'keyDown',key,text:key}); await command('Input.dispatchKeyEvent',{type:'keyUp',key}); }
  for(const type of ['mouseMoved','mousePressed','mouseReleased']) await command('Input.dispatchMouseEvent',{type,x:50,y:215,button:'left',clickCount:1});
  const typedResult=await command('Runtime.evaluate',{expression:'[document.querySelector("#typed").value, window.poked===true]',returnByValue:true});
  console.log('onset-result '+JSON.stringify({previous:result.result.value,opened,bridge:b,rejected,unauthorized:unauthorized.status,fromPage:fromPage.status,input:typedResult.result.value,masked,badBusy}));
 }catch(e){console.error(e.message);process.exitCode=1;}
});`);
  // 移除账号：先等页面销毁走完（网页在关闭流程里写草稿）再清存储，清完重开页面核对草稿没了。
  // 旧写法（forget 不等销毁）草稿会在清掉之后被写回来，这里读到的就是复活的草稿。
  fs.writeFileSync(path.join(dir, 'forget.cjs'), `
let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end', async()=>{
 try {
  const r=JSON.parse(input), b=r.browser;
  const rpc=async(body)=>{ const response=await fetch(b.endpoint,{method:'POST',headers:{authorization:'Bearer '+b.token,'content-type':'application/json'},body:JSON.stringify(body)}); const result=await response.json(); if(!response.ok)throw Error(result.error); return result; };
  await rpc({action:'open',account:r.params.account,label:r.params.account,url:'${origin}/'});
  // 发 forget 前留个标记：测试看到它就知道互斥即将登记，可以放另一连接进来试重开了。
  const fs=require('fs'); fs.mkdirSync(r.project_root+'/production/embedded',{recursive:true}); fs.writeFileSync(r.project_root+'/production/embedded/forgetting.json','1');
  await rpc({action:'forget',account:r.params.account});
  await rpc({action:'open',account:r.params.account,label:r.params.account,url:'${origin}/'});
  const draft=await rpc({action:'command',method:'Runtime.evaluate',params:{expression:'localStorage.getItem("draft")',returnByValue:true}});
  await rpc({action:'close'});
  console.log('onset-result '+JSON.stringify({draft:draft.result.value}));
 }catch(e){console.error(e.message);process.exitCode=1;}
});`);
  // 移除期间试重开：等 forget 的标记出现（写在 forget 请求发出前）再反复试 open——被「另一项操作填写」拒绝
  // 说明互斥还没登记（forget 请求还在路上），接着等；被「正在移除」拒绝才是主进程确认了的同步点。不赌固定延迟。
  fs.writeFileSync(path.join(dir, 'reopen.cjs'), `
let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end', async()=>{
 try {
  const r=JSON.parse(input), b=r.browser;
  const rpc=async(body)=>{ const response=await fetch(b.endpoint,{method:'POST',headers:{authorization:'Bearer '+b.token,'content-type':'application/json'},body:JSON.stringify(body)}); const result=await response.json(); if(!response.ok)throw Error(result.error); return result; };
  const fs=require('fs'), marker=r.project_root+'/production/embedded/forgetting.json';
  const deadline=Date.now()+10000;
  while(!fs.existsSync(marker)){ if(Date.now()>deadline) throw Error('没等到移除标记'); await new Promise(s=>setTimeout(s,50)); }
  let opened=false;
  while(Date.now()<deadline){
    try { await rpc({action:'open',account:r.params.account,label:r.params.account,url:'${origin}/'}); opened=true; break; }
    catch(e){ if(!String(e.message).includes('正在由另一项操作')) throw e; await new Promise(s=>setTimeout(s,100)); }
  }
  if(!opened) throw Error('没等到移除窗口');
  console.log('onset-result '+JSON.stringify({reopened:true}));
 }catch(e){console.error(e.message);process.exitCode=1;}
});`);
  installPlugin(sandbox, dir, 'embedded-helper');
  // 插件内嵌网页的登录存储在片场的应用数据目录下（station-browser.ts 的 sessionDirectory），不在插件的 data_dir 里。
  const sessionDir = (account) => path.join(sandbox.userData, 'station-sessions', 'embedded-helper', account);
  await openProject(page, project);
  fs.mkdirSync(path.join(sandbox.stations, 'embedded-helper', 'data'), { recursive: true });
  const outside = path.join(sandbox.stations, 'embedded-helper', 'data', 'outside.mp4');
  fs.writeFileSync(outside, 'outside-project');
  fs.symlinkSync(outside, path.join(project.path, 'escape.mp4'));
  // Mock only HTTPS contents, in the same isolated session used by the production bridge.
  await electronApp.evaluate(({ session }, { directories, html }) => {
    for (const dir of directories) {
      session.fromPath(dir).protocol.handle('https', request => {
        const requestUA = JSON.stringify(request.headers.get('user-agent')).replaceAll('<', '\\u003c');
        return new Response(`<script>window.requestUA=${requestUA}</script>${html}`, { headers: { 'content-type': 'text/html' } });
      });
    }
  }, { directories: ['account-a', 'account-b', 'account-c'].map(account => sessionDir(account)), html });
  const run = async account => {
    const started = await api(page, '/api/stations/embedded-helper/ops/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { account } }) });
    expect(started.status, JSON.stringify(started.body) + JSON.stringify((await api(page, '/api/stations')).body.problems)).toBe(202);
    let result;
    await expect.poll(async () => {
      const s = (await api(page, '/api/stations')).body.stations.find(s => s.id === 'embedded-helper');
      result = s.ops[0].last_run;
      return result?.task_id === started.body.task_id;
    }).toBe(true);
    expect(result.ok, result.text).toBe(true);
    return result.data;
  };
  const first = await run('account-a');
  expect(first.previous).toBe('');
  expect(first.unauthorized).toBe(403);
  expect(first.fromPage).toBe(403);
  expect(first.rejected).toEqual([true, true, true, true, true, true, true, true, true]);
  expect(first.input).toEqual(['#话', true]);
  expect(first.masked).toBe(true);
  expect(first.badBusy).toEqual([true, true, true]);
  const inspect = () => electronApp.evaluate(async ({ webContents, BrowserWindow }) => {
    const web = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.example.test'));
    const agents = await web?.executeJavaScript('[navigator.userAgent, window.requestUA]');
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find(w => w.isResizable() && w.webContents.getURL().startsWith('onset://app'));
    const own = windows.find(w => w.contentView.children.some(v => v.webContents === web));
    return {
      windows: windows.length, native: !!web, preferences: web?.getLastWebPreferences(), agents, chrome: process.versions.chrome,
      separate: !!own && own !== main, mainViews: main?.contentView.children.length,
      maskVisible: own?.contentView.children.at(-1)?.getVisible(),
    };
  });
  const info = await inspect();
  expect(info.native).toBe(true);
  // 主窗口、桌宠，加上这个账号页面自己的窗口；不往主窗口里塞页面，也没有启动外部浏览器。
  expect(info.windows).toBe(3);
  expect(info.separate).toBe(true);
  expect(info.mainViews).toBe(0);
  // 操作结束（连接撤销）时遮罩自动揭开，页面留给用户手动发布。
  expect(info.maskVisible).toBe(false);
  expect(info.preferences.nodeIntegration).toBe(false);
  expect(info.preferences.sandbox).toBe(true);
  const [pageUA, requestUA] = info.agents;
  expect(pageUA).toContain(` Chrome/${info.chrome} Safari/`);
  expect(pageUA).not.toMatch(/片场\/|Electron\//);
  expect(requestUA).toBe(pageUA);
  await electronApp.evaluate(async ({ webContents }) => {
    const web = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.example.test'));
    if (await web.executeJavaScript('document.querySelector("input[type=file]").files[0].name') !== 'upload.mp4') throw Error('没有上传');
    if (await web.executeJavaScript('!!window.published')) throw Error('插件自动发布了');
    if (await web.executeJavaScript('document.querySelector("#title").value') !== '自动填写') throw Error('没有填入');
    await web.executeJavaScript('document.querySelector("#title").value="用户修改"; document.querySelector("button").click()');
    if (!await web.executeJavaScript('window.published')) throw Error('不能手动发布');
  });
  await expect(fetch(first.bridge.endpoint, { method: 'POST', headers: { authorization: 'Bearer '+first.bridge.token }, body: '{}' })).rejects.toThrow();
  // 移除账号（forget）：等页面销毁完成后再清存储，关闭流程里写的草稿不会在清掉之后复活。
  const forgotten = await api(page, '/api/stations/embedded-helper/ops/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { account: 'account-c' } }) });
  expect(forgotten.status, JSON.stringify(forgotten.body)).toBe(202);
  let forgetRun;
  await expect.poll(async () => {
    const s = (await api(page, '/api/stations')).body.stations.find(s => s.id === 'embedded-helper');
    forgetRun = s.ops.find(o => o.name === 'forget').last_run;
    return forgetRun?.task_id === forgotten.body.task_id;
  }).toBe(true);
  expect(forgetRun.ok, forgetRun.text).toBe(true);
  expect(forgetRun.data.draft).toBeNull();
  // 移除等待销毁期间，另一项操作重开同一账号要被拒绝：同目录复用同一 Session，放行后清存储会伤及新页面。
  // reopen 自己等 forget 的标记出现再动手（见 reopen.cjs），两个任务先后脚发起即可，不依赖启动快慢。
  const marker = path.join(project.path, 'production', 'embedded', 'forgetting.json');
  fs.rmSync(marker, { force: true });
  const forgetting = await api(page, '/api/stations/embedded-helper/ops/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { account: 'account-c' } }) });
  expect(forgetting.status, JSON.stringify(forgetting.body)).toBe(202);
  const intruder = await api(page, '/api/stations/embedded-helper/ops/reopen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { account: 'account-c' } }) });
  expect(intruder.status, JSON.stringify(intruder.body)).toBe(202);
  let intruderRun;
  await expect.poll(async () => {
    const s = (await api(page, '/api/stations')).body.stations.find(s => s.id === 'embedded-helper');
    intruderRun = s.ops.find(o => o.name === 'reopen').last_run;
    return intruderRun?.task_id === intruder.body.task_id;
  }).toBe(true);
  expect(intruderRun.ok).toBe(false);
  expect(intruderRun.text).toContain('正在移除');
  let forgetAgain;
  await expect.poll(async () => {
    const s = (await api(page, '/api/stations')).body.stations.find(s => s.id === 'embedded-helper');
    forgetAgain = s.ops.find(o => o.name === 'forget').last_run;
    return forgetAgain?.task_id === forgetting.body.task_id;
  }).toBe(true);
  expect(forgetAgain.ok, forgetAgain.text).toBe(true);
  expect(forgetAgain.data.draft).toBeNull();
  const second = await run('account-b');
  expect(second.previous).toBe('');
  expect((await run('account-a')).previous).toContain('account=account-a');
  // 插件网页操作不占项目写锁：两个账号可以同时上传。
  const both = await Promise.all(['account-a', 'account-b'].map(account => api(page, '/api/stations/embedded-helper/ops/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { account } }) })));
  expect(both.map(r => r.status)).toEqual([202, 202]);
  for (const r of both) await expect.poll(async () => (await api(page, '/api/tasks/' + r.body.task_id)).body.status).toBe('succeeded');
  // 像用户那样点关闭按钮关掉 account-b 的窗口：网页走完关闭流程，它在 beforeunload 里存的草稿马上落盘。
  // 以前片场用 close({ waitForBeforeUnload: false }) 直接销毁页面，抖音这类只在 beforeunload 里存草稿的网站，关了窗口草稿就没了。
  // 换回旧写法时这里（关窗口、退出两种）会失败：草稿没存下来。
  const drafted = account => {
    const dir = path.join(sessionDir(account), 'Local Storage', 'leveldb');
    return fs.existsSync(dir) && fs.readdirSync(dir).filter(f => /\.(log|ldb)$/.test(f)).some(f => fs.readFileSync(path.join(dir, f)).includes('saved-before-unload'));
  };
  // 页面开着、什么都没关：网页写进本地存储的东西几秒内已经在磁盘上（片场每 FlushIntervalMs 落一次盘）。
  // 测试里 Chromium 自己也会很快写盘，这条拦不住去掉定时落盘；它保证的是开着页面时磁盘上一直是新的。
  const onDisk = (account, text) => {
    const dir = path.join(sessionDir(account), 'Local Storage', 'leveldb');
    return fs.existsSync(dir) && fs.readdirSync(dir).filter(f => /\.(log|ldb)$/.test(f)).some(f => fs.readFileSync(path.join(dir, f)).includes(text));
  };
  for (const account of ['account-a', 'account-b']) await expect.poll(() => onDisk(account, 'written-while-open'), { timeout: 15_000 }).toBe(true);
  if (shutdown === 'window') {
    // 点了关闭，窗口先藏起来但还在：网页在后台存完、落完盘才真正销毁。
    const closing = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.getTitle() === '内嵌上传 · account-b');
      if (!window) throw Error('找不到 account-b 的窗口');
      window.close();
      return { destroyed: window.isDestroyed(), visible: window.isVisible() };
    });
    expect(closing).toEqual({ destroyed: false, visible: false });
    await expect.poll(() => drafted('account-b'), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.getTitle() === '内嵌上传 · account-b'))).toBe(false);
  }
  if (shutdown === 'application') {
    // 由片场自己退出（不经 Playwright 关页面，那样会替网页走关闭流程，测不出问题）：退出前等插件页面存完草稿。
    // 关了窗口马上退出、还连退两次：account-b 已移出页面登记但销毁没完成，第一次退出要等它存完，
    // 第二次退出不能绕过等待。旧写法（openPages === 0 就放行、close() 收不到正在关的页面）这里会丢草稿。
    const exited = new Promise(resolve => electronApp.process().once('exit', resolve));
    await electronApp.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.getTitle() === '内嵌上传 · account-b');
      if (!window) throw Error('找不到 account-b 的窗口');
      window.close();
      setImmediate(() => { app.quit(); app.quit(); });
    });
    await exited;
    expect(drafted('account-a')).toBe(true);
    expect(drafted('account-b')).toBe(true);
  }
  if (shutdown === 'quit-with-all-closing') {
    // 先关 account-a 并等它销毁完，再关最后一个页面 account-b 马上连退两次：pages 已空、只剩销毁中的页面，
    // 退出也要等它存完草稿（旧写法 openPages === 0 直接放行，这里会丢）。
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.getTitle() === '内嵌上传 · account-a');
      if (!window) throw Error('找不到 account-a 的窗口');
      window.close();
    });
    await expect.poll(() => drafted('account-a'), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.getTitle() === '内嵌上传 · account-a'))).toBe(false);
    const exited = new Promise(resolve => electronApp.process().once('exit', resolve));
    await electronApp.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.getTitle() === '内嵌上传 · account-b');
      if (!window) throw Error('找不到 account-b 的窗口');
      window.close();
      setImmediate(() => { app.quit(); app.quit(); });
    });
    await exited;
    expect(drafted('account-a')).toBe(true);
    expect(drafted('account-b')).toBe(true);
  }
  if (shutdown !== 'application' && shutdown !== 'quit-with-all-closing') {
    await electronApp.evaluate(async ({ BrowserWindow, webContents }, destroyPagesFirst) => {
      const window = BrowserWindow.getAllWindows().find(w => w.isResizable() && w.webContents.getURL().startsWith('onset://app'));
      if (!window) throw Error('主窗口不存在');
      if (destroyPagesFirst) {
        const pages = webContents.getAllWebContents().filter(w => w.getURL().startsWith('https://creator.example.test'));
        await Promise.all(pages.map(w => new Promise(resolve => {
          w.once('destroyed', resolve);
          w.close({ waitForBeforeUnload: false });
        })));
      }
      // 让主进程先回复，再关闭窗口；Windows 关闭主窗口时还会退出应用。
      setImmediate(() => window.close());
    }, shutdown === 'page-before-window');
    await expect.poll(() => page.isClosed()).toBe(true);
  }
  await electronApp.close();
  expect(errors).toEqual([]);
  // 页面写的带有效期的 cookie（像登录状态那样）落到了磁盘上：客户端重启后选了账号不用再登录。
  // 以前存储放在插件 data_dir 下，cookie 从不写盘（session.fromPath 只在 userData 里写）。
  for (const account of ['account-a', 'account-b']) {
    const cookies = path.join(sessionDir(account), 'Cookies');
    expect(fs.existsSync(cookies), account).toBe(true);
    expect(fs.readFileSync(cookies).includes(account), account).toBe(true);
  }

});
