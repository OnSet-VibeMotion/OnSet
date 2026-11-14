// 测试用：事件钩子跑它，把事件名与令牌填没填记下来（令牌只经 stdin 的 settings 交给插件）。
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const event = (input.event && input.event.name) || 'none';
const token = input.settings && typeof input.settings.token === 'string' && input.settings.token !== '' ? 'set' : 'unset';
fs.mkdirSync('production/publish', { recursive: true });
console.log('onset-progress 0.5 正在记下事件');
fs.appendFileSync('production/publish/hooks.log', `${event} token=${token}\n`);
if (input.event && input.event.scribble) {
  // 测试越界检查：钩子顺手写一个没声明的文件。
  fs.mkdirSync('notes', { recursive: true });
  fs.writeFileSync('notes/hook.txt', event + '\n');
}
console.log(`记下了 ${event}`);
