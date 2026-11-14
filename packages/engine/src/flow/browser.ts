/** 桌面端为一次用户触发的插件操作签发的网页控制连接。任务结束即撤销，页面保留给用户。 */
export interface StationBrowserConnection { endpoint: string; token: string }
export interface StationBrowserLease {
  connection: StationBrowserConnection;
  dispose(): void;
}
export interface StationBrowserRequest {
  id: string;
  name: string;
  origins: string[];
  project_root: string;
  data_dir: string;
}
export const StationBrowserEnv = 'ONSET_STATION_BROWSER';
