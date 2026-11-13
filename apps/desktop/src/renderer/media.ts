/**
 * 界面里所有带原生控件的 <video> / <audio> 都用这份属性。
 *
 * Chromium 的原生播放控件在「⋮」菜单里自带「下载」和「投放」：客户端里的视频就是项目文件，下载只会
 * 另存一份到「下载」文件夹，投放在桌面应用里也用不上。要拿成片，用成片页的「在 Finder 中显示」。
 */
export const playerProps = { controls: true, controlsList: 'nodownload noremoteplayback' } as const;
