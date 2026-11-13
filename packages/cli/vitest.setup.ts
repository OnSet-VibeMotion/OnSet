// 全局设置（<数据目录>/am/settings.conf）是用户级的：测试不能读到开发者自己在客户端「设置」页里选的工具，
// 指到一个不存在的临时文件，config.load 就只看项目配置与内置默认。要测全局设置的用例自己再设 AM_SETTINGS_FILE。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach } from 'vitest';

process.env.AM_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-settings-test-')), 'settings.conf');
// 编排工具与渲染器 PATH 最前面那个只有 am 的目录（envutil.agentBinDir）默认写在 <数据目录>/am 下，测试里指到临时目录。
process.env.AM_AGENT_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-bin-test-'));
// 导演的模型服务密钥（director.defaultDir）也是用户级的：测试不能读到、更不能改开发者自己填的 key。
process.env.AM_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-dir-test-'));
// 第三方插件的存放目录（已装插件清单、插件的数据目录）也指到临时目录：测试不能往开发者真实的 ~/.local/share/am/stations 写。
// 插件装在用户级、对所有项目生效，所以每个用例一个新目录：一个用例装的插件不能漏进下一个用例。
process.env.AM_STATIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-stations-test-'));
beforeEach(() => {
  process.env.AM_STATIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-stations-test-'));
});
