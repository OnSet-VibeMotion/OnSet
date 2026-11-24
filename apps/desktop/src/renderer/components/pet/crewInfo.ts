import type { CrewSignal, PetCommand } from '../chat/crew';
import {
  type CrewInfo,
  crewMoodOf,
  directorIdle,
  duration,
  type Idler,
  idleLabels,
  opIndex,
  type PieItem,
  type Who,
} from './crewState';
import { clamp } from './iso';

export interface CrewInfoContext {
  signal: CrewSignal;
  idlers: { director: Idler; ops: Idler[]; editor: Idler; voice: Idler };
  shooting: string[];
  filmingOps: boolean[];
  editing: boolean;
  voicing: boolean;
  nowMs: number;
}

/** 每个人的状态面板：在做什么、需求条、心情、动作队列，都从真实的会话与镜头数据算。 */
export function buildCrewInfo(who: Who, ctx: CrewInfoContext): CrewInfo {
  const { signal, idlers: idle, shooting, filmingOps, editing, voicing, nowMs } = ctx;
  const mood = signal.mood;
  const crewMood = crewMoodOf(signal);
  const dIdle = mood === 'idle' ? directorIdle[idle.director.act] : null;
  if (who === 'director') {
    const elapsed = signal.running && signal.turnStarted ? nowMs - Date.parse(signal.turnStarted) : 0;
    const done = signal.plan.filter((p) => p.status === 'completed').length;
    const doing = dIdle && mood === 'idle' ? (idleLabels.director[idle.director.act] ?? '待命') : signal.line;
    return {
      name: '制作人',
      role: '编排',
      doing,
      mood: crewMood,
      needs: [
        {
          label: '精力',
          value: signal.running ? clamp(1 - elapsed / (40 * 60_000), 0.12, 1) : 1,
          note: signal.running ? `这一轮 ${duration(elapsed)}` : '歇着',
        },
        ...(signal.plan.length > 0
          ? [{ label: '进度', value: done / signal.plan.length, note: `${done} / ${signal.plan.length}` }]
          : []),
      ],
      queue: signal.plan.map((p) => ({ text: p.text, state: p.status })),
    };
  }
  if (who === 'editor' || who === 'voice') {
    const working = who === 'editor' ? editing : voicing;
    const act = who === 'editor' ? idleLabels.editor[idle.editor.act] : idleLabels.voice[idle.voice.act];
    return {
      name: who === 'editor' ? '剪辑师' : '配音演员',
      role: who === 'editor' ? '拼接、复查、字幕' : '配音',
      doing: working ? signal.line : (act ?? '闲着'),
      mood: working ? '专注' : crewMood === '低落' ? '低落' : '悠闲',
      needs: [{ label: '精力', value: working ? 0.7 : 1, note: working ? '在忙' : '歇着' }],
      queue: working ? [{ text: signal.line, state: 'in_progress' }] : [],
    };
  }
  const i = opIndex(who);
  const scenes = i === 2 ? shooting.slice(2) : shooting[i] !== undefined ? [shooting[i]] : [];
  const filming = filmingOps[i] && scenes.length > 0 && scenes[0] !== '';
  const since = filming ? signal.renderSince[scenes[0]] : '';
  const elapsed = since ? nowMs - Date.parse(since) : 0;
  return {
    name: `摄影 ${i + 1}`,
    role: '渲染镜头',
    doing: filming ? `在拍 ${scenes.join('、')}` : (idleLabels.operator[idle.ops[i].act] ?? '闲着'),
    mood: filming ? '专注' : crewMood === '低落' ? '低落' : '悠闲',
    needs: filming
      ? [
          {
            label: '已拍',
            value: clamp(elapsed / (15 * 60_000), 0.04, 1),
            note: since ? duration(elapsed) : '刚开机',
            kind: 'time' as const,
          },
          { label: '精力', value: clamp(1 - elapsed / (30 * 60_000), 0.2, 1), note: '' },
        ]
      : [{ label: '精力', value: 1, note: '歇着' }],
    queue: scenes.filter(Boolean).map((id, k) => ({ text: `拍 ${id}`, state: k === 0 ? 'in_progress' : 'pending' })),
    scene: filming ? scenes[0] : '',
  };
}

/** 点人弹出的环形菜单：都是真能做的事。 */
export function buildPieItems(who: Who, signal: CrewSignal, infoOf: (who: Who) => CrewInfo): PieItem[] {
  if (who === 'director') {
    return [
      { label: '看制作路线', command: { kind: 'open', page: 'progress' } },
      { label: '对他说一句', compose: true },
      ...(signal.running ? [{ label: '停下这一轮', command: { kind: 'stop' } as PetCommand }] : []),
      { label: '回到对话', command: { kind: 'focus' } },
    ];
  }
  if (who === 'editor') {
    return [
      { label: '看成片', command: { kind: 'open', page: 'final' } },
      { label: '看复查', command: { kind: 'open', page: 'review' } },
      ...(signal.canSend && !signal.running
        ? [{ label: '叫他拼成片', command: { kind: 'say', text: '把镜头拼成成片，拼好后做一遍复查' } as PetCommand }]
        : []),
    ];
  }
  if (who === 'voice') {
    return [
      { label: '看口播稿', command: { kind: 'open', page: 'script' } },
      { label: '音色库', command: { kind: 'open', page: 'voice' } },
    ];
  }
  const sc = infoOf(who).scene ?? '';
  return sc
    ? [
        { label: `看 ${sc}`, command: { kind: 'open', page: 'scene', target: sc } },
        { label: '全部镜头', command: { kind: 'open', page: 'scene' } },
      ]
    : [{ label: '看镜头', command: { kind: 'open', page: 'scene' } }];
}
