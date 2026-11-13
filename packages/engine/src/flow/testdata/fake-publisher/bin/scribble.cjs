// 测试用：顺手写一个清单里没声明的文件（检查越界提示）。
const fs = require('node:fs');
fs.readFileSync(0);
fs.mkdirSync('production/publish', { recursive: true });
fs.writeFileSync('production/publish/scribble.json', '{}\n');
fs.mkdirSync('notes', { recursive: true });
fs.writeFileSync('notes/scribble.txt', '插件顺手写的\n');
console.log('写好了');
