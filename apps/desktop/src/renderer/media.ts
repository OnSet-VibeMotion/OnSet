/**
 * 界面里所有带原生控件的 <video> / <audio> 都用这份属性。
 *
 * Chromium 的原生播放控件在「⋮」菜单里自带「下载」和「投放」：客户端里的视频就是项目文件，下载只会
 * 另存一份到「下载」文件夹，投放在桌面应用里也用不上。要拿成片，用成片页的「在 Finder 中显示」。
 */
export const playerProps = { controls: true, controlsList: 'nodownload noremoteplayback' } as const;

let activePlayback: { owner: object; pause: () => void } | null = null;

/** 试听共用一个播放席位；WebAudio 的节拍预览也走这里。 */
export function claimAudioPlayback(owner: object, pause: () => void): void {
  const previous = activePlayback;
  activePlayback = { owner, pause };
  if (previous && previous.owner !== owner) previous.pause();
}

export function releaseAudioPlayback(owner: object): void {
  if (activePlayback?.owner === owner) activePlayback = null;
}

/** 捕获不冒泡的 play 事件，也覆盖后来出现的聊天附件、文件预览与隐藏的音色播放器。 */
export function installExclusiveAudioPlayback(): void {
  const playing = (event: Event) => {
    const player = event.target;
    if (!(player instanceof HTMLMediaElement) || player.paused || player.muted || player.volume === 0) return;
    claimAudioPlayback(player, () => player.pause());
  };
  const stopped = (event: Event) => {
    if (event.target instanceof HTMLMediaElement && event.target.paused) releaseAudioPlayback(event.target);
  };
  document.addEventListener('play', playing, true);
  // 静音的视频预览可以继续动；播放中取消静音时也要接管声音，避免重新叠音。
  document.addEventListener('volumechange', playing, true);
  document.addEventListener('pause', stopped, true);
  document.addEventListener('ended', stopped, true);
}
