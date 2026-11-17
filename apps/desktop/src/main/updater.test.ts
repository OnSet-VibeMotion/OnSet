import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  feed: 'https://first.example',
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => fake.handlers.set(name, fn) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('./network', () => ({ proxyRules: (value: string) => value }));
vi.mock('@onset/engine/config', () => ({ machineSetting: (_env: unknown, key: string) => key === 'UPDATE_FEED_URL' ? fake.feed : '', parseConfFile: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: Object.assign(new EventEmitter(), {
  netSession: { setProxy: vi.fn().mockResolvedValue(undefined) },
  setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn().mockResolvedValue([]), quitAndInstall: vi.fn(),
}) }));
import { autoUpdater } from 'electron-updater';
import { installUpdater } from './updater';
const update = { version: '2.0.0', files: [], path: 'update.zip', sha512: '', releaseDate: '2026-11-17' };
const action = (name: string, force?: boolean) => fake.handlers.get('onset:update-action')!(null, name, force);
const state = () => fake.handlers.get('onset:update-state')!();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('ONSET_DESKTOP_BACKGROUND', '');
  vi.stubEnv('ONSET_DISABLE_UPDATE', '');
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  fake.feed = 'https://first.example';
  autoUpdater.removeAllListeners();
  vi.clearAllMocks();
  vi.mocked(autoUpdater.checkForUpdates).mockImplementation(async () => {
    autoUpdater.emit('update-available', update);
    return { isUpdateAvailable: true } as never;
  });
  installUpdater({ activeWork: () => [{ project: 'film', holder: 'render' }] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('requires an explicit installation and preserves the busy-work confirmation', async () => {
  expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  autoUpdater.emit('update-downloaded', { ...update, downloadedFile: '/tmp/update.zip' });
  expect((await action('install')).ok).toBe(false);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  expect((await action('install', true)).ok).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
});
it('checks the new feed before downloading and does not download when it has no update', async () => {
  await action('check');
  fake.feed = 'https://second.example';
  vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(async () => {
    autoUpdater.emit('update-not-available', update);
    return { isUpdateAvailable: false } as never;
  });
  await action('download');
  await vi.waitFor(() => expect(state().status).toBe('latest'));
  expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({ provider: 'generic', url: fake.feed });
  expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
});

it('reports native installation preparation errors and allows a fresh check', async () => {
  autoUpdater.emit('update-downloaded', { ...update, downloadedFile: '/tmp/update.zip' });
  expect((await action('install', true)).ok).toBe(true);
  expect(state().status).toBe('installing');
  expect((await action('install', true)).ok).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  autoUpdater.emit('error', new Error('native preparation failed'));
  expect(state()).toMatchObject({ status: 'error', version: '', error: 'native preparation failed' });
  await action('check');
  expect(state().status).toBe('available');
});
