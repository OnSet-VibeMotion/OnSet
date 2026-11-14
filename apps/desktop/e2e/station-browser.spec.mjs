import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, api, installPlugin } from './fixtures.mjs';

const origin = 'https://creator.example.test';
const html = '<input type="file"><input id="title"><button onclick="window.published=true">发布</button>';

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
  const unauthorized=await fetch(b.endpoint,{method:'POST',headers:{authorization:'Bearer wrong'},body:'{}'});
  const fromPage=await fetch(b.endpoint,{method:'POST',headers:{authorization:'Bearer '+b.token,origin:'https://creator.example.test'},body:'{}'});
  const rejected=[];
  for(const [method,params] of [['Page.navigate',{url:'file:///etc/passwd'}],['Page.navigate',{url:'https://outside.example/'}],['Network.getAllCookies',{}],['DOM.setFileInputFiles',{files:[r.data_dir+'/outside.mp4']}],['DOM.setFileInputFiles',{files:[r.project_root+'/escape.mp4']}],['DOM.setFileInputFiles',{files:[r.project_root+'/upload.mp4'],nodeId:1}]]) {
    try { await command(method,params); rejected.push(false); } catch { rejected.push(true); }
  }
  const object=await command('Runtime.evaluate',{expression:'document.querySelector(\"input[type=file]\")'});
  await command('DOM.setFileInputFiles',{objectId:object.result.objectId,files:[r.project_root+'/upload.mp4']});
  const result=await command('Runtime.evaluate',{expression:'document.cookie',returnByValue:true});
  await command('Runtime.evaluate',{expression:'document.querySelector("#title").value="自动填写"; document.cookie="account='+r.params.account+'; path=/"',returnByValue:true});
  console.log('onset-result '+JSON.stringify({previous:result.result.value,opened,bridge:b,rejected,unauthorized:unauthorized.status,fromPage:fromPage.status}));
 }catch(e){console.error(e.message);process.exitCode=1;}
});`);
  installPlugin(sandbox, dir, 'embedded-helper');
  await openProject(page, project);
  fs.mkdirSync(path.join(sandbox.stations, 'embedded-helper', 'data'), { recursive: true });
  const outside = path.join(sandbox.stations, 'embedded-helper', 'data', 'outside.mp4');
  fs.writeFileSync(outside, 'outside-project');
  fs.symlinkSync(outside, path.join(project.path, 'escape.mp4'));
  // Mock only HTTPS contents, in the same isolated session used by the production bridge.
  await electronApp.evaluate(({ session }, { directories, html }) => {
    for (const dir of directories) {
      session.fromPath(dir).protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    }
  }, { directories: ['account-a', 'account-b'].map(account => path.join(sandbox.stations, 'embedded-helper', 'data', 'web-sessions', account)), html });
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
  expect(first.rejected).toEqual([true, true, true, true, true, true]);
  const inspect = () => electronApp.evaluate(({ webContents, BrowserWindow }) => {
    const web = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.example.test'));
    return { windows: BrowserWindow.getAllWindows().length, native: !!web, preferences: web?.getLastWebPreferences() };
  });
  const info = await inspect();
  expect(info.native).toBe(true);
  expect(info.windows).toBe(2); // main + existing pet; no browser window was launched.
  expect(info.preferences.nodeIntegration).toBe(false);
  expect(info.preferences.sandbox).toBe(true);
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
  if (shutdown !== 'application') {
    await electronApp.evaluate(async ({ BrowserWindow, webContents }, destroyPagesFirst) => {
      const window = BrowserWindow.getAllWindows().find(w => w.isResizable());
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
});
