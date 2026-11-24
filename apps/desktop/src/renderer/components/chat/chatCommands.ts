import type { Attachment, ViewRequest } from '../../types';
import type { GuideAction } from '../guide';
import { confirmGate } from '../Progress';
import type { SlashCommand } from './complete';

export interface CommandContext {
  attachments: Attachment[];
  drawing: { ok: boolean; reason: string };
  fill: (text: string) => void;
  setError: (msg: string) => void;
  onSession: (id: string) => void;
  onView: (view: ViewRequest) => void;
  onClearAttachments: () => void;
  onAddAttachments: (attachments: Attachment[]) => void;
  run: (path: string, payload?: Record<string, unknown>) => void;
  deliver: (message: string, attachments: Attachment[], interrupt?: boolean) => Promise<boolean>;
  startProduction: (message?: string) => Promise<void>;
  cancel: () => Promise<void>;
  handoff: () => Promise<void>;
}

export function executeGuideAction(action: GuideAction, ctx: CommandContext): void {
  switch (action.kind) {
    case 'page':
      ctx.onView({ page: action.page, target: action.target });
      return;
    case 'say':
      void ctx.deliver(action.text, []);
      return;
    case 'draft':
      ctx.fill(action.text);
      return;
    case 'gate':
      void confirmGate(action.gate, (text) => void ctx.deliver(text, []), action.text);
      return;
    case 'start':
      if (!ctx.drawing.ok) {
        ctx.setError(ctx.drawing.reason);
        return;
      }
      void ctx.startProduction();
      return;
    case 'op':
      // NextStep 已经让用户确认过；执行是写任务，进度在任务列表里。
      ctx.run(`/api/stations/${encodeURIComponent(action.station)}/ops/${encodeURIComponent(action.op)}`, {
        params: {},
      });
      return;
  }
}

/** 执行一条 / 命令：网页里直接做的清空输入框，交给编排工具的换成一句模板。 */
export function executeSlashCommand(command: SlashCommand, arg: string, ctx: CommandContext): void {
  switch (command.name) {
    case 'new':
      ctx.fill('');
      ctx.onSession('');
      return;
    case 'handoff':
      ctx.fill('');
      void ctx.handoff();
      return;
    case 'stop':
      ctx.fill('');
      void ctx.cancel();
      return;
    case 'start':
      ctx.fill('');
      if (!ctx.drawing.ok) {
        ctx.setError(ctx.drawing.reason);
        return;
      }
      void ctx.startProduction('');
      return;
    case 'script':
      ctx.fill('');
      ctx.onView({ page: 'script' });
      return;
    case 'show':
      ctx.fill('');
      ctx.onView({ page: arg });
      return;
    case 'confirm-script':
      ctx.fill('');
      void ctx
        .deliver('口播稿我看过了，没问题，按这版继续配音。', ctx.attachments)
        .then((ok) => ok && ctx.onClearAttachments());
      return;
    case 'redo':
      ctx.onAddAttachments([{ ref: true, scene_id: arg }]);
      ctx.fill(`重做镜头 ${arg}：保留文案、时长和与相邻镜头的交接约定，`);
      return;
    case 'render':
      ctx.fill('');
      ctx.run(`/api/scenes/${encodeURIComponent(arg)}/render`);
      return;
    case 'render-all':
      ctx.fill('');
      ctx.run('/api/render/all');
      return;
    case 'validate':
      ctx.fill('');
      ctx.run('/api/commands/scene.validate', { scene_id: arg });
      return;
    case 'concat':
      ctx.fill('');
      ctx.run('/api/commands/project.concat');
      return;
    case 'review':
      ctx.fill('');
      ctx.run('/api/review/run');
      return;
    case 'remember':
      ctx.fill('记住这个偏好，以后都这样做：');
      return;
    default:
      if (command.plugin?.tab) {
        ctx.fill('');
        ctx.onView({ page: command.plugin.tab });
      } else if (command.plugin) ctx.fill(command.plugin.prompt);
  }
}
