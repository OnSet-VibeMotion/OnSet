// 测试用：报告回执与环境里能看到的东西（检查凭据没有漏进来）。
const fs = require('node:fs');
fs.readFileSync(0);
const receipt = 'production/publish/receipts.json';
console.log(fs.existsSync(receipt) ? fs.readFileSync(receipt, 'utf8').trimEnd() : '还没有回执');
console.log(`secret=${process.env.ONSET_TEST_SECRET || 'none'} data=${process.env.ONSET_STATION_DATA ? 'set' : ''}`);
