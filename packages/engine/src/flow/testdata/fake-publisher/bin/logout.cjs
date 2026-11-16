// 测试用：列表项上的按钮（清单 form: false），设置里不出表单。
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.rmSync(path.join(input.data_dir, 'login.json'), { force: true });
console.log('onset-result ' + JSON.stringify({ message: '已退出' }));
