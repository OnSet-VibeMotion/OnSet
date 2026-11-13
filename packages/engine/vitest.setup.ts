// 全局设置（<数据目录>/am/settings.conf）是用户级的：测试不能读到开发者自己在客户端「设置」页里选的工具，
// 指到一个不存在的临时文件，config.load 就只看项目配置与内置默认。要测全局设置的用例自己再设 AM_SETTINGS_FILE。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 镜头扩展块（cast、song、beat）在 scene/blocks/index.ts 里登记，经 scene 的包入口 index.ts 加载。
// scene/ 自己的测试直接 import './scene'，绕过了包入口，这里替它们登记一次。
import './src/scene/blocks';

process.env.AM_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-settings-test-')), 'settings.conf');
// 编排工具与渲染器 PATH 最前面那个只有 am 的目录（envutil.agentBinDir）默认写在 <数据目录>/am 下，测试里指到临时目录。
process.env.AM_AGENT_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-bin-test-'));
// 导演的模型服务密钥（director.defaultDir）也是用户级的：测试不能读到、更不能改开发者自己填的 key。
process.env.AM_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-dir-test-'));
// 第三方站的存放目录（含插件的数据目录）也指到临时目录：测试不能往开发者真实的 ~/.local/share/am/stations 写。
process.env.AM_STATIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-stations-test-'));
