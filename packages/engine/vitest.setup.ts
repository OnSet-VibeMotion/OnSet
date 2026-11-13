// 全局设置（<数据目录>/am/settings.conf）是用户级的：测试不能读到开发者自己在客户端「设置」页里选的工具，
// 指到一个不存在的临时文件，config.load 就只看项目配置与内置默认。要测全局设置的用例自己再设 AM_SETTINGS_FILE。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AM_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-settings-test-')), 'settings.conf');
// 编排工具与渲染器 PATH 最前面那个只有 am 的目录（envutil.agentBinDir）默认写在 <数据目录>/am 下，测试里指到临时目录。
process.env.AM_AGENT_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-bin-test-'));
