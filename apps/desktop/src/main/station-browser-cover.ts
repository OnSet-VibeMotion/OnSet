const escapeHTML = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const defaultHint = '请检查账号与内容，发布由你确认';
export const barHeight = 56;

export function toolbarDataURL(title: string, hint: string): string {
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#171614;color:#f4eee4;font:14px system-ui;display:flex;align-items:center;gap:20px;height:${barHeight}px;padding:0 20px;box-sizing:border-box;user-select:none}a{color:inherit;text-decoration:none;border:1px solid #666057;padding:6px 14px;border-radius:20px;white-space:nowrap}strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{color:#c0b7a9;white-space:nowrap}</style><a href="https://onset.invalid/return">返回片场</a><strong>${escapeHTML(title)}</strong><small>${escapeHTML(hint)}</small>`,
    )
  );
}

/** 遮罩页：只有宿主写的这一页，文字经 update() 用 textContent 填，不拼 HTML。 */
const coverHTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%}
body{background:rgba(12,11,10,.6);display:flex;align-items:center;justify-content:center;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#f4eee4;cursor:progress;user-select:none}
.card{width:min(440px,calc(100vw - 64px));box-sizing:border-box;background:rgba(26,24,22,.94);border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:26px 28px 22px;box-shadow:0 24px 64px rgba(0,0,0,.5)}
.top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.spin{flex:none;width:18px;height:18px;border:2px solid rgba(244,238,228,.2);border-top-color:#e8a24a;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:15px;font-weight:600;margin:0;letter-spacing:.02em}
#message{color:#ddd5c8;margin:0 0 16px;line-height:1.55;min-height:22px;word-break:break-all}
.track{height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
#bar{height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#e8a24a,#f3c784);transition:width .5s ease}
.track.wait #bar{width:32%;animation:wait 1.4s ease-in-out infinite}
@keyframes wait{from{transform:translateX(-100%)}to{transform:translateX(320%)}}
.foot{margin:12px 0 0;color:#a49b8e;font-size:12px}
</style>
<div class="card" role="status" aria-live="polite"><div class="top"><div class="spin"></div><h1>插件正在自动操作，请勿操作此页面</h1></div>
<p id="message"></p><div class="track wait" id="track"><div id="bar"></div></div>
<p class="foot">完成后自动解开，可以先回片场继续工作</p></div>
<script>
window.update = function (state) {
  document.getElementById('message').textContent = state.message;
  // 进度条是整次操作的进度；这一步走到哪（例如上传百分比）写在说明里。
  var track = document.getElementById('track');
  track.className = typeof state.progress === 'number' ? 'track' : 'track wait';
  document.getElementById('bar').style.width = typeof state.progress === 'number' ? Math.round(state.progress * 100) + '%' : '';
};
</script>`;

export function coverDataURL(): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(coverHTML);
}
