// 测试用：不需要项目的操作（清单 project: false）。没打开项目时工作目录是插件的数据目录、project_root 为空；
// 打开了项目时照常在项目里跑。登录记录只写插件的数据目录。
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const cwd = fs.realpathSync(process.cwd());
const expected = input.project_root === '' ? input.data_dir : input.project_root;
if (cwd !== fs.realpathSync(expected)) throw new Error(`工作目录不对：${cwd}`);
const name = input.params.name || '默认账号';
fs.writeFileSync(path.join(input.data_dir, 'login.json'), JSON.stringify({ name }) + '\n');
console.log(`已登录：${name}`);
console.log('onset-result ' + JSON.stringify({ logged_in: name, in_project: input.project_root !== '', message: `已登录：${name}` }));
