/**
 * 全部内置插件的登记处（进程内 apply）。新增一个内置功能：在 plugins/<id>/ 写它的 apply，在这里加一行登记，
 * 在 assets/plugins/<id>/am-station.json 写清单（开关、名字、说明）。宿主的 flow、progress、工具服务都不用改。
 *
 * 由 plugin 包的入口导入（登记靠这里的副作用，集中在一处才不会漏）。
 */
import { registerBuiltin } from '../plugin/registry';
import { publishing } from './publishing';
import { songPlugin } from './song';

registerBuiltin(publishing);
registerBuiltin(songPlugin);
