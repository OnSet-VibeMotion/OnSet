import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, api, installPlugin } from './fixtures.mjs';

const origin = 'https://creator.example.test';
// 像抖音的编辑页：只在 beforeunload 里把编辑中的内容存成草稿，存完还要求确认离开。
const draftOnUnload = `<script>addEventListener('beforeunload', e => { localStorage.setItem('draft', 'saved-before-unload'); e.preventDefault(); e.returnValue = ''; })</script>`
  // 也像编辑中的网站那样随时往本地存储写：片场开着页面时几秒内就要落到磁盘上，不等关窗口。
  + `<script>localStorage.setItem('live', 'written-while-open')</script>`;
const html = draftOnUnload + '<input type="file"><input id="title"><input id="typed"><button onclick="window.published=true">发布</button><button id="poke" style="position:fixed;left:10px;top:200px;width:80px;height:30px" onclick="window.poked=event.isTrusted">点我</button>';

for (const shutdown of ['application', 'window', 'page-before-window']) test(`plugin fills an embedded page, leaves manual publishing available, isolates accounts and revokes automation (${shutdown})`, async ({ electronApp, page, project, sandbox }) => {
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
    ops: [{ name: 'prepare', summary: '准备网页', trigger: 'user', command: ['{node}', 'prepare.cjs'], params: { account: { type: 'string', required: true, description: '账号编号' } } }],
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
  }, { directories: ['account-a', 'account-b'].map(account => sessionDir(account)), html });
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
  if (shutdown !== 'page-before-window') {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.getTitle() === '内嵌上传 · account-b');
      if (!window) throw Error('找不到 account-b 的窗口');
      window.close();
    });
    await expect.poll(() => drafted('account-b'), { timeout: 10_000 }).toBe(true);
  }
  if (shutdown === 'application') {
    // 由片场自己退出（不经 Playwright 关页面，那样会替网页走关闭流程，测不出问题）：退出前等插件页面存完草稿。
    const exited = new Promise(resolve => electronApp.process().once('exit', resolve));
    await electronApp.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await exited;
    expect(drafted('account-a')).toBe(true);
  }
  if (shutdown !== 'application') {
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
