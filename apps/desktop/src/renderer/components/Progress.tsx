import { useState } from 'react';
import { post } from '../api';
import type { Attachment, ProgressState, ProgressStation, ProgressTurn } from '../types';
import { Icon } from './Icon';
import { pageView } from './pageViews';
import '../progress.css';

/** 顶栏五步的名字：站按它分组。内置插件登记的步骤（例如卡点的节拍）用它那一页的名字。 */
const stepLabels: Record<string, string> = {
  script: '口播稿',
  storyboard: '分镜',
  scene: '镜头',
  final: '成片',
  publish: '发布',
};

/**
 * 能在界面上点「确认」的宿主审核关卡，以及确认时发给 AI 的话。内置插件的关卡（例如卡点的故事审核）由插件登记
 * 那句话（判断函数的 guide.confirm），经 /api/progress 的 station.guide.confirm 带过来。
 */
export const gateMessages: Record<string, string> = {
  'gate-script': '口播稿我看过了，没问题，按这版继续配音。',
  'gate-voice': '配音我听过了，没问题，继续。',
  'gate-storyboard': '分镜我看过了，没问题，开始渲染。',
};

/** 关卡确认时发给 AI 的话：宿主的查表，内置插件的用它登记的。 */
export function gateMessage(station: Pick<ProgressStation, 'id' | 'guide'>): string | undefined {
  return gateMessages[station.id] ?? station.guide?.confirm;
}

/** 用户确认一道关卡：先记下确认（记不下也不拦着），再把话交给 AI。message 不给时按宿主的表。 */
export async function confirmGate(id: string, onQuick: (text: string, attachments: Attachment[]) => void, message?: string): Promise<void> {
  try {
    await post(`/api/progress/gates/${id}`);
  } catch {
    // 记录失败（比如内容还没写出来）不影响把确认告诉 AI。
  }
  onQuick(message ?? gateMessages[id], []);
}

/** 上游改过、要重做时发给 AI 的话：知道是哪儿改了就一并说清。「接下来」卡片也用它。 */
export function redoMessage(s: Pick<ProgressStation, 'label' | 'stale_note'>): string {
  return s.stale_note ? `「${s.label}」要重做：${s.stale_note}。请按制作说明改好，再请我看一遍。` : `「${s.label}」的上游改过了，请按新的重做这一步。`;
}

/** 「11-10 10:07」：同一年里不写年份。 */
export function shortTime(at: string | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? date : `${d.getFullYear()}-${date}`;
}

/** 现在在哪、在等谁：对话顶上那一行与路线页页头共用。 */
export function currentSummary(progress: ProgressState | null): { station: ProgressStation | null; text: string } {
  if (!progress) return { station: null, text: '' };
  const station = progress.stations.find((s) => s.id === progress.current) ?? null;
  if (!station) return { station: null, text: '全部做完了' };
  if (station.status === 'changed') return { station, text: '改过了，等你再看一遍' };
  if (station.status === 'stale') return { station, text: '上游改过，要重做' };
  if (progress.waiting_on === 'user') return { station, text: station.gate ? '等你确认' : station.detail ? `${station.detail}，等你处理` : '等你处理' };
  return { station, text: 'AI 在做' };
}

/** 对话里确认的原话：太长时截一截，免得挤掉一整行。 */
function quoteOf(said: string): string {
  const chars = [...said.replace(/\s+/g, ' ').trim()];
  return chars.length > 24 ? chars.slice(0, 23).join('') + '…' : chars.join('');
}

function statusNote(station: ProgressStation): string {
  switch (station.status) {
    case 'confirmed':
      if (station.said) return station.at ? `你在 ${shortTime(station.at)} 说：「${quoteOf(station.said)}」` : `你说：「${quoteOf(station.said)}」`;
      return station.at ? `你在 ${shortTime(station.at)} 确认了` : '你确认了';
    case 'passed':
      return '已经过了';
    case 'changed':
      return '确认后又改过，要重新看';
    case 'skipped':
      return '没留下产物';
    case 'stale':
      return station.stale_note ?? '上游改过，要重做';
    case 'todo':
      return station.optional ? '可选' : '';
    default:
      return '';
  }
}

function markOf(station: ProgressStation, current: boolean): { cls: string; text: string } {
  if (current) return { cls: 'now', text: '' };
  switch (station.status) {
    case 'done':
    case 'confirmed':
    case 'passed':
      return { cls: 'ok', text: '✓' };
    case 'skipped':
      return { cls: 'skip', text: '–' };
    case 'stale':
    case 'changed':
      return { cls: 'warn', text: '!' };
    default:
      return { cls: 'todo', text: '' };
  }
}

interface Props {
  progress: ProgressState | null;
  /** 项目没有流程记录时 /api/state 给的说明（这时排不出路线）。 */
  flowError?: string;
  busy: string;
  /** 打开某一页（口播稿、分镜……）。 */
  onPage: (page: string) => void;
  onFile: (path: string) => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  /** 跳到对话里的那一轮。 */
  onTurn: (sessionId: string, turnId: string) => void;
}

export function ProgressTab(props: Props) {
  const { progress } = props;
  if (props.flowError)
    return (
      <div className="empty" id="progress-flow-error">
        {props.flowError}
      </div>
    );
  if (!progress) return <div className="empty">正在读制作进度…</div>;
  const { station: now, text } = currentSummary(progress);
  const done = progress.stations.filter((s) => !s.optional && ['done', 'skipped', 'confirmed', 'passed'].includes(s.status)).length;
  const total = progress.stations.filter((s) => !s.optional).length;
  const groups: { step: string; stations: ProgressStation[] }[] = [];
  for (const station of progress.stations) {
    const last = groups[groups.length - 1];
    if (last && last.step === station.step) last.stations.push(station);
    else groups.push({ step: station.step, stations: [station] });
  }
  return (
    <div className="progress-page" id="progress-page">
      <header className="pg-head">
        <h1 className="pg-title">制作路线</h1>
        <div className="pg-stats">
          <span>
            {done} / {total} 站
          </span>
          <span className="pg-bar" aria-hidden="true">
            <i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
          </span>
        </div>
        <p className="pg-now" id="progress-now">
          {now ? (
            <>
              现在在 <strong>{now.label}</strong>
              <span className={'pg-who ' + (progress.waiting_on === 'user' || now.status === 'changed' ? 'user' : 'ai')}>{text}</span>
            </>
          ) : (
            <strong>{text}</strong>
          )}
        </p>
      </header>
      <ol className="pg-groups">
        {groups.map((group, gi) => (
          <li key={group.step + gi} className="pg-group">
            <h2 className="pg-group-title">
              <span className="pg-group-no">{String(gi + 1).padStart(2, '0')}</span>
              {stepLabels[group.step] ?? pageView(group.step)?.label ?? group.step}
            </h2>
            <ol className="pg-stations">
              {group.stations.map((station) => (
                <StationRow key={station.id} station={station} current={station.id === progress.current} {...props} />
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StationRow(props: Props & { station: ProgressStation; current: boolean }) {
  const { station, current } = props;
  const [open, setOpen] = useState(false);
  const mark = markOf(station, current);
  const note = statusNote(station);
  const canLook = !!station.page || !!station.file;
  const look = () => (station.page ? props.onPage(station.page) : station.file && props.onFile(station.file));
  const confirmable = station.gate && gateMessage(station) && (current || station.status === 'changed');
  return (
    <li className={'pg-station' + (station.gate ? ' gate' : '') + (current ? ' current' : '') + ' ' + station.status} data-station={station.id}>
      <span className={'pg-mark ' + mark.cls} aria-hidden="true">
        {mark.text}
      </span>
      <div className="pg-body">
        <div className="pg-line">
          <span className="pg-label">{station.label}</span>
          {station.detail && <span className="pg-detail">{station.detail}</span>}
          {note && <span className={'pg-note ' + station.status}>{note}</span>}
          <span className="spacer" />
          {station.at && station.status !== 'confirmed' && <time className="pg-time">{shortTime(station.at)}</time>}
          {station.turns.length > 0 && (
            <button className="ghost pg-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title="动过这一站的几轮对话">
              {station.turns.length} 轮
              <Icon name={open ? 'chevron' : 'next'} size={10} />
            </button>
          )}
        </div>
        {current && (
          <div className="pg-actions">
            {canLook && (
              <button onClick={look}>{station.gate ? '去看看' : '打开'}</button>
            )}
            {confirmable && (
              <button className="primary" disabled={!!props.busy} onClick={() => void confirmGate(station.id, props.onQuick, gateMessage(station))}>
                确认，继续
              </button>
            )}
            {!station.gate && station.status === 'stale' && (
              <button className="primary" disabled={!!props.busy} onClick={() => props.onQuick(redoMessage(station), [])}>
                让 AI 重做
              </button>
            )}
            {!station.gate && station.status === 'todo' && station.id !== 'publish' && (
              <button className="primary" disabled={!!props.busy} onClick={() => props.onQuick(`继续做「${station.label}」这一步。`, [])}>
                让 AI 继续
              </button>
            )}
          </div>
        )}
        {!current && station.status === 'changed' && confirmable && (
          <div className="pg-actions">
            {canLook && <button onClick={look}>去看看</button>}
            <button className="primary" disabled={!!props.busy} onClick={() => void confirmGate(station.id, props.onQuick, gateMessage(station))}>
              确认，继续
            </button>
          </div>
        )}
        {open && (
          <ul className="pg-turns">
            {station.turns.map((turn) => (
              <TurnRow key={turn.turn_id} turn={turn} onTurn={props.onTurn} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

const turnStatus: Record<string, string> = { failed: '失败', cancelled: '停了', interrupted: '中断', reverted: '已回退' };

function TurnRow({ turn, onTurn }: { turn: ProgressTurn; onTurn: Props['onTurn'] }) {
  return (
    <li>
      <button className="pg-turn" onClick={() => onTurn(turn.session_id, turn.turn_id)} title={'在对话里看这一轮\n' + turn.paths.join('\n') + (turn.files > turn.paths.length ? '\n…' : '')}>
        <time>{shortTime(turn.at)}</time>
        <span className="pg-turn-msg ellipsis">「{turn.message || '（没有文字）'}」</span>
        {turnStatus[turn.status] && <span className="pg-turn-status">{turnStatus[turn.status]}</span>}
        <span className="pg-turn-files">{turn.files} 个文件</span>
      </button>
    </li>
  );
}
