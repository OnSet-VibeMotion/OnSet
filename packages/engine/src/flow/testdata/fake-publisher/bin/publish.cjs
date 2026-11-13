// 测试用的假发布：从 stdin 读参数，只写回执，不联网。用 {node} 跑：用户机器上不必装 Node。
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const platform = input.params.platform;
const receipt = { platform, url: `https://example.invalid/${platform}/1` };
fs.mkdirSync('production/publish', { recursive: true });
fs.writeFileSync('production/publish/receipts.json', JSON.stringify(receipt) + '\n');
console.log(`已发到 ${platform}`);
console.log('am-result ' + JSON.stringify(receipt));
