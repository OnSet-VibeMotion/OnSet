// electron-builder 的 afterPack：把固定版本 npm 整棵拷进当前平台的应用资源目录。
//
// 不走 extraResources：electron-builder 复制 extraResources 时一律丢掉 node_modules（filter 显式写进去也不行，实测），
// 拷进去的 npm 只剩 bin/ 与 lib/，一运行就报 Cannot find module 'graceful-fs'。
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const source = path.join(__dirname, '..', 'vendor', 'npm');
  if (!fs.existsSync(path.join(source, 'bin', 'npm-cli.js'))) {
    throw new Error('vendor/npm 不存在：先运行 npm run vendor -w onset-desktop');
  }
  const target = path.join(context.packager.getResourcesDir(context.appOutDir), 'npm');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, filter: (src) => path.basename(src) !== '.onset-vendor' });
};
