// 测试用：列表操作（清单 list: true）。读插件数据目录里的登录记录，画成账号卡片（头像是 1×1 的 PNG）。
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const file = path.join(input.data_dir, 'login.json');
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const items = fs.existsSync(file)
  ? [{ title: JSON.parse(fs.readFileSync(file, 'utf8')).name, detail: '已登录', image: avatar, actions: [{ label: '退出', op: 'logout', params: {}, confirm: '退出后要重新登录，确定吗？' }] }]
  : [];
console.log('onset-result ' + JSON.stringify({ items }));
