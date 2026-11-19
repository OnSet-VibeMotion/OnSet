import type { BrowserWindow } from 'electron';

/**
 * 插件网页各自的窗口（station-browser.ts）。它们不是片场的主窗口：找主窗口（pet.ts 的 mainWindow）、
 * 「主窗口关了就退出」都要跳过它们。
 */
export const pluginWindows = new WeakSet<BrowserWindow>();
