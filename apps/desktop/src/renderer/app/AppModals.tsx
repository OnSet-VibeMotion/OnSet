import { Icon } from '../components/Icon';
import type { Tab } from '../components/Preview';
import { ProjectDialog } from '../components/ProjectDialog';
import { Settings } from '../components/Settings';
import { SetupGuide, type useSetup } from '../components/SetupGuide';
import type { Project } from '../types';

export interface AppModalsProps {
  setup: ReturnType<typeof useSetup>;
  setupOpen: boolean;
  onCloseSetup: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  version: number;
  currentId: string;
  run: (path: string, payload?: Record<string, unknown>, onAccepted?: () => void) => Promise<void>;
  onOpenSettingsPage: (page: Tab) => void;
  onAgentsChanged: () => void;
  onPluginsChanged: () => void;
  dialog: boolean;
  projects: Project[];
  onCloseDialog: () => void;
  onProjectOpened: () => Promise<void>;
  toast: string;
}

export function AppModals(props: AppModalsProps) {
  return (
    <>
      {props.setupOpen && props.setup.status && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onCloseSetup()}>
          <section className="modal" role="dialog" aria-label="前置资源" id="setup-dialog">
            <header className="modal-head">
              <h2>前置资源</h2>
              <span className="spacer" />
              <button className="ghost icon" onClick={props.onCloseSetup} aria-label="关闭">
                <Icon name="close" />
              </button>
            </header>
            <div className="pad">
              <SetupGuide setup={props.setup} compact />
            </div>
          </section>
        </div>
      )}
      {props.settingsOpen && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onCloseSettings()}>
          <section className="modal settings-modal" role="dialog" aria-label="设置" id="settings-dialog">
            <header className="modal-head">
              <h2>设置</h2>
              <span className="spacer" />
              <button className="ghost icon" onClick={props.onCloseSettings} aria-label="关闭">
                <Icon name="close" />
              </button>
            </header>
            <div className="settings-frame">
              <Settings
                version={props.version}
                run={props.run}
                project={props.currentId !== ''}
                onOpenPage={(page) => props.onOpenSettingsPage(page as Tab)}
                onAgentsChanged={props.onAgentsChanged}
                onPluginsChanged={props.onPluginsChanged}
              />
            </div>
          </section>
        </div>
      )}
      {props.dialog && (
        <ProjectDialog
          projects={props.projects}
          currentId={props.currentId}
          onClose={props.onCloseDialog}
          onOpened={props.onProjectOpened}
        />
      )}
      {props.toast && (
        <div className="toast" role="status">
          {props.toast}
        </div>
      )}
    </>
  );
}
