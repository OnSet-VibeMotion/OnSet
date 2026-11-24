/**
 * 插件。
 * - 设置页：内置功能与「我的插件」——这台电脑上装的第三方插件，对所有项目生效：它会做什么、要了哪些权限、
 *   它的设置（含密钥）、要你点的操作与它的页面入口，添加、更新与去掉。没有打开项目也能管（PluginSettings），
 *   操作与页面要先打开项目；发布页这类制作页面里不放插件的配置；
 * - 插件自己的页面（StationPage）与嵌进自带页面的小窗（StationSlots），都经 StationFrame 的沙箱桥接。
 * 装、去掉、更新是后台任务（/api/stations），执行操作是项目的写任务；客户端自己不写项目文件。
 */
import '../stations.css';

export { clickedInPluginPage, resetPluginClicks } from './stations/frameBridge';
export { PluginSettings } from './stations/PluginSettings';
export { isStationTab, setStationPages, stationPageLabel } from './stations/registry';
export { PageMenu, StationPage, StationSlots } from './stations/StationViews';
