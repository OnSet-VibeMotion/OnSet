/**
 * Studio 后端的路由表装配与 ServeMux 风格分发。
 */
import { goClean } from '../gofmt';
import * as plugin from '../plugin';
import { agentModelsAPI, agentsAPI } from './agents';
import { agentServiceAPI, agentServiceModelsAPI, agentServicesAPI, agentVisionAPI } from './agentservices';
import {
  commandAPI,
  decodeAttachments,
  decodeView,
  filesAPI,
  productionStartAPI,
  sessionAPI,
  sessionsAPI,
  turnAPI,
} from './api_sessions';
import { rawAPI, stylesAPI, treeAPI } from './api_ui';
import { auditionAPI, auditionsAPI } from './auditions';
import { brandKitsAPI } from './brandkits';
import { previewAPI, renderAllAPI, sceneFeatureAPI, scenesAPI } from './features';
import { filmStylePosterAPI, filmStylesAPI, projectFilmStyleAPI } from './filmstyle';
import { notFound, writeError } from './http';
import { learningAPI, learningFeatureAPI } from './learning';
import { marketAPI } from './market';
import { mediaGenAPI } from './mediagen';
import { memoryActionAPI, memoryAPI, memoryApplicationsAPI, memoryExamAudioAPI, memoryRecallAPI } from './memory';
import { motionEffectsAPI, motionPreviewAPI } from './motion';
import { namingAPI } from './naming';
import { polishAPI } from './polish';
import { progressAPI } from './progress';
import { projectZipAPI } from './projectzip';
import { promptChecksAPI } from './promptchecks';
import { renderCheckAPI } from './rendercheck';
import { reviewCommentsAPI } from './reviewcomments';
import { scriptAPI } from './script';
import { settingsAPI, settingsGlobalAPI, settingsProjectAPI } from './settings';
import { setupAPI, setupCancelAPI, setupRunAPI } from './setup';
import { skillsAPI, skillsInstallAPI } from './skills';
import { currentSkinAPI, skinsAPI } from './skins';
import { stationMediaAPI, stationsAPI, stationUIAPI } from './stations';
import { storyboardAPI } from './storyboard';
import type { Server } from './studio';
import {
  createProjectAPI,
  currentProjectAPI,
  directoriesAPI,
  openProjectAPI,
  type ProjectAPIHost,
  projectsAPI,
  removeProjectAPI,
  switchProjectAPI,
} from './studio_projects_api';
import { assetsAPI, reviewAPI, reviewRunAPI, stateAPI } from './studio_review_api';
import { taskFeatureAPI, tasksAPI } from './tasks';
import { uploadsAPI } from './uploads';
import { voiceAPI, voiceDesignAPI, voiceDraftAPI, voiceRecordAPI, voicesAPI } from './voices';

export type Handler = (request: Request, rest: string) => Response | Promise<Response>;

export function buildRouteTable(s: Server, host: ProjectAPIHost, health: () => Response): [string, Handler][] {
  return [
    ['/api/health', () => health()],
    ['/api/projects', () => projectsAPI(host)],
    ['/api/projects/open', (r) => openProjectAPI(host, r)],
    ['/api/projects/create', (r) => createProjectAPI(host, r)],
    ['/api/projects/name', (r) => namingAPI(r)],
    ['/api/directories', (r) => directoriesAPI(r)],
    ['/api/projects/recent/remove', (r) => removeProjectAPI(host, r)],
    ['/api/workspaces/current', () => currentProjectAPI(host)],
    ['/api/workspaces/switch', (r) => switchProjectAPI(host, r)],
    ['/api/state', () => stateAPI(s)],
    ['/api/scenes', () => scenesAPI(s)],
    ['/api/script', (r) => scriptAPI(s, r)],
    ['/api/storyboard', (r) => storyboardAPI(s, r)],
    ['/api/polish', (r) => polishAPI(s, r, { view: decodeView, attachments: decodeAttachments })],
    ['/api/prompt-checks', (r) => promptChecksAPI(s, r, '')],
    ['/api/prompt-checks/', (r, rest) => promptChecksAPI(s, r, rest)],
    ['/api/progress', (r) => progressAPI(s, r, '')],
    ['/api/progress/', (r, rest) => progressAPI(s, r, rest)],
    ['/api/market', (r) => marketAPI(s, r, '')],
    ['/api/market/', (r, rest) => marketAPI(s, r, rest)],
    ['/api/stations', (r) => stationsAPI(s, r, '')],
    ['/api/stations/', (r, rest) => stationsAPI(s, r, rest)],
    ['/station-ui/', (r, rest) => stationUIAPI(s, r, rest)],
    ['/station-media/', (r, rest) => stationMediaAPI(s, r, rest)],
    ['/api/assets', () => assetsAPI(s)],
    ['/api/scenes/', (r, rest) => sceneFeatureAPI(s, r, rest)],
    ['/api/tasks', (r) => tasksAPI(s, r)],
    ['/api/tasks/', (r, rest) => taskFeatureAPI(s, r, rest)],
    ['/api/review', (r) => reviewAPI(s, r)],
    ['/api/review/run', (r) => reviewRunAPI(s, r)],
    ['/api/render/all', (r) => renderAllAPI(s, r)],
    ['/api/sessions', (r) => sessionsAPI(s, r)],
    ['/api/sessions/', (r, rest) => sessionAPI(s, r, rest)],
    ['/api/production/start', (r) => productionStartAPI(s, r)],
    ['/api/turns/', (r, rest) => turnAPI(s, r, rest)],
    ['/api/commands/', (r, rest) => commandAPI(s, r, rest)],
    ['/api/files', (r) => filesAPI(s, r)],
    ['/api/uploads', (r) => uploadsAPI(s, r)],
    ['/api/skills', () => skillsAPI(s)],
    ['/api/skills/install', (r) => skillsInstallAPI(s, r)],
    ['/api/agents', (r) => agentsAPI(s, r)],
    ['/api/agents/', (r, rest) => agentModelsAPI(r, rest)],
    ['/preview/scenes/', (r, rest) => previewAPI(s, r, rest)],
    ['/api/styles', (r) => stylesAPI(r)],
    ['/api/tree', (r) => treeAPI(s, r)],
    ['/api/raw', (r) => rawAPI(s, r)],
    ['/api/memory', (r) => memoryAPI(s, r)],
    ['/api/memory/recall', (r) => memoryRecallAPI(s, r)],
    ['/api/memory/applications', (r) => memoryApplicationsAPI(s, r)],
    ['/api/memory/exams/', (r, rest) => memoryExamAudioAPI(s, r, rest)],
    ['/api/memory/actions/', (r, rest) => memoryActionAPI(s, r, rest)],
    ['/api/auditions', (r) => auditionsAPI(s, r)],
    ['/api/auditions/', (r, rest) => auditionAPI(s, r, rest)],
    ['/api/learning', (r) => learningAPI(s, r)],
    ['/api/learning/', (r, rest) => learningFeatureAPI(s, r, rest)],
    // 先按当前项目换上第三方插件带来的风格库。
    ['/api/film-styles', (r) => filmStylesAPI(r)],
    ['/api/film-styles/', (r, rest) => filmStylePosterAPI(r, rest)],
    ['/api/motion-effects', (r) => motionEffectsAPI(r)],
    ['/preview/motion/', (r, rest) => motionPreviewAPI(r, rest)],
    ['/api/film-style', (r) => projectFilmStyleAPI(s, r)],
    ['/api/settings', (r) => settingsAPI(s, r)],
    ['/api/agent-services', (r) => agentServicesAPI(r)],
    ['/api/agent-services/', (r, rest) => agentServiceAPI(r, rest)],
    ['/api/agent-services/models', (r) => agentServiceModelsAPI(r)],
    ['/api/agent-services/vision', (r) => agentVisionAPI(r)],
    ['/api/settings/global', (r) => settingsGlobalAPI(r)],
    ['/api/settings/project', (r) => settingsProjectAPI(s, r)],
    ['/api/voices', (r) => voicesAPI(s, r)],
    ['/api/voices/', (r, rest) => voiceAPI(r, rest)],
    ['/api/voice-record', (r) => voiceRecordAPI(r)],
    ['/api/voice-design', (r) => voiceDesignAPI(r)],
    ['/api/voice-drafts/', (r, rest) => voiceDraftAPI(r, rest)],
    ['/api/brand-kits', (r) => brandKitsAPI(s, r, '')],
    ['/api/brand-kits/', (r, rest) => brandKitsAPI(s, r, rest)],
    ['/api/media-gen/', (r, rest) => mediaGenAPI(s, r, rest)],
    ['/api/review-comments', (r) => reviewCommentsAPI(s, r, '')],
    ['/api/review-comments/', (r, rest) => reviewCommentsAPI(s, r, rest)],
    ['/api/project-zip/', (r, rest) => projectZipAPI(s, r, rest)],
    ['/api/skins', (r) => skinsAPI(s, r)],
    ['/api/skins/current', (r) => currentSkinAPI(s, r)],
    ['/api/setup', (r) => setupAPI(r, s.projectRoot())],
    ['/api/setup/run', (r) => setupRunAPI(r, s.projectRoot())],
    ['/api/setup/cancel', (r) => setupCancelAPI(r)],
    ['/api/setup/render-check', (r) => renderCheckAPI(r)],
    // 内置插件在 apply 里登记的接口（例如发布页的 /api/publish）。
    ...plugin
      .pluginRoutes()
      .map(({ value: route }): [string, Handler] => [route.pattern, (r, rest) => route.handle(s, r, rest)]),
  ];
}

function redirect(url: URL, pathname: string): Response {
  const location = pathname + url.search;
  return new Response(`<a href="${location}">Moved Permanently</a>.\n\n`, {
    status: 301,
    headers: { Location: location, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Go 版的 static：/api/ 下不存在的路径给 JSON 404；界面文件由 Electron 加载，这里一律 404。 */
function fallback(pathname: string): Response {
  if (pathname.startsWith('/api/')) return writeError(404, 'not_found', 'Studio API 路径不存在');
  return notFound();
}

/**
 * fetch 风格的入口：按 Go 的 http.ServeMux 规则匹配（精确路径优先、以 / 结尾的模式按最长前缀匹配，
 * 不规整的路径 301 到规整后的路径）。
 */
export async function dispatchRoute(routes: [string, Handler][], request: Request): Promise<Response> {
  const url = new URL(request.url);
  // 插件页面在沙箱 iframe 里（不透明源，Origin 是 "null"），只能经宿主转交，不能直接调接口：
  // CSP 已经拦下它的请求，这里再兜一层，免得哪天 CSP 写漏了。
  if (url.pathname.startsWith('/api/') && request.headers.get('Origin') === 'null') {
    return writeError(403, 'forbidden', '插件页面不能直接调用 Studio 接口');
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('400 Bad Request', { status: 400 });
  }
  let clean = goClean(pathname);
  if (pathname.endsWith('/') && clean !== '/') clean += '/';
  if (clean !== pathname) return redirect(url, clean);
  let best: [string, Handler] | undefined;
  for (const route of routes) {
    const [pattern] = route;
    if (pattern === pathname) {
      best = route;
      break;
    }
    if (pattern.endsWith('/') && pathname.startsWith(pattern) && (!best || pattern.length > best[0].length))
      best = route;
  }
  // 只注册了子树（/api/turns/）时，不带斜杠的请求 301 到带斜杠的路径。
  if (!best && routes.some(([pattern]) => pattern === pathname + '/')) return redirect(url, pathname + '/');
  try {
    if (!best) return fallback(pathname);
    const [pattern, handler] = best;
    return await handler(request, pattern.endsWith('/') ? pathname.slice(pattern.length) : '');
  } catch (err) {
    return writeError(500, 'internal_error', (err as Error).message);
  }
}
