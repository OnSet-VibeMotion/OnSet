import path from 'node:path';
import { configureInstalledRuntime } from './localRuntime';

/*
 * 应用入口。包装脚本以 ONSET_BROWSER_MODE=1 启动本应用时，进的是借给 HyperFrames 渲染的浏览器模式（browser.ts），
 * 不加载客户端主进程：那边模块一加载就登记协议、抢单实例锁，会和正在运行的客户端打架。
 * 两边各自打包成独立文件，这里按路径动态加载，esbuild 不会把它们并进同一个包。
 */
const load = require;
// 在加载引擎模块、选择 userData 与单实例锁之前统一本机数据路径。
if (process.env.ONSET_BROWSER_MODE !== '1') configureInstalledRuntime(process.execPath, process.env);
load(path.join(__dirname, process.env.ONSET_BROWSER_MODE === '1' ? 'browser.js' : 'main.js'));
