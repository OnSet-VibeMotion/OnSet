import type { StationInfo, StationPageInfo } from '../../types';
import { setPluginCommands } from '../chat/complete';

/** 已加载的插件（顶栏、嵌入位、对话里的「↗ 页面」与斜杠命令都要它）；app 读到 /api/stations 时更新。 */
const pageRegistry = new Map<string, { page: StationPageInfo; station: StationInfo }>();
let loadedStations: StationInfo[] = [];

export function setStationPages(stations: StationInfo[]): void {
  loadedStations = stations;
  pageRegistry.clear();
  for (const station of stations) for (const page of station.pages) pageRegistry.set(page.tab, { page, station });
  setPluginCommands(stations.flatMap((s) => s.commands));
}

export function stationPageLabel(tab: string): string | undefined {
  return pageRegistry.get(tab)?.page.label;
}

export function isStationTab(tab: string): boolean {
  return tab.startsWith('x:');
}

export function getStationPage(tab: string): { page: StationPageInfo; station: StationInfo } | undefined {
  return pageRegistry.get(tab);
}

export function getLoadedStations(): StationInfo[] {
  return loadedStations;
}
