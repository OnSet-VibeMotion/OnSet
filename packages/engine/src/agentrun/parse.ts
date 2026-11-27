//
// agentrun 运行编排工具，并把各家 CLI 的结构化输出统一成同一套事件。
//
// onset run 与 onset studio 共用这一条路径：前者把事件打印成可读文字，后者推给网页。
// 各家的流格式在 2026-11 实测录下，见 testdata/；codebuddy 本机未登录，只录到
// 401 的错误流，结构按与 claude 相同处理，未经完整实测。
import { accumulateUsage, newUsage, type SessionTotal, type Usage, ValidTools } from '../tools';
import { BackgroundTasks, CompactionStatus, parseClaudeLike, TaskBoard } from './parse_claude';
import { parseCodex } from './parse_codex';
import { normalizeAgyTool, parseAgy, parseMcode, parseOpencode } from './parse_other';
import {
  type BackgroundTask,
  type ContextCompaction,
  clip,
  compactionEvent,
  type Event,
  eventJSON,
  type Kind,
  KindBackgroundTasks,
  KindContextCompaction,
  KindDone,
  KindError,
  KindPlan,
  KindSession,
  KindText,
  KindThinking,
  KindToolCall,
  KindToolResult,
  KindUsage,
  maxToolOutput,
  obj,
  type PlanItem,
  unwrapOnsetToolCall,
} from './parse_types';

export type { BackgroundTask, ContextCompaction, Event, Kind, PlanItem };
export {
  clip,
  compactionEvent,
  eventJSON,
  KindBackgroundTasks,
  KindContextCompaction,
  KindDone,
  KindError,
  KindPlan,
  KindSession,
  KindText,
  KindThinking,
  KindToolCall,
  KindToolResult,
  KindUsage,
  maxToolOutput,
  normalizeAgyTool,
  TaskBoard,
  unwrapOnsetToolCall,
};

/**
 * 把一行原始输出译成零到多条事件。Parser 有状态（会话 id 去重、用量累计），
 * 一次运行用一个。
 */
export class Parser {
  /** 目前从流里读到的会话 id；run 预先指定会话时直接写入。 */
  session = '';
  private readonly accumulated: Usage = newUsage();
  private readonly tasks = new TaskBoard();
  private readonly backgroundTasks = new BackgroundTasks();
  private readonly compaction = new CompactionStatus();
  private readonly mcodeCalls = new Map<string, string>();
  private readonly agyCalls = new Set<string>();
  private readonly agyText = new Map<number, string>();

  /** 不校验工具名；外部一律经 newParser 创建。 */
  constructor(readonly tool: string) {}

  /** 目前从流里读到的会话 id。 */
  sessionID(): string {
    return this.session;
  }

  /** 续接同一个 CLI 会话时，接上上一轮的任务清单（见 TaskBoard）。 */
  seedPlan(plan: PlanItem[]): void {
    this.tasks.seed(plan);
  }

  /**
   * 续接同一个 CLI 会话时，给上一次记下的会话累计值（tools.sessionBaseline）；null 表示续接但不知道。
   * 有的工具续接后报的是整个会话的累计数（tools 的 cumulativeFields），减掉它才是这一次的。
   */
  seedBaseline(baseline: SessionTotal | null): void {
    this.accumulated.baseline = baseline;
  }

  /** 累计用量；一条用量事件都没读到时 usageEmpty() 为 true。 */
  usage(): Usage {
    const { baseline: _baseline, ...usage } = this.accumulated;
    return usage;
  }

  /** 译一行。认不出的行返回空数组，不报错：各家会在流里夹带限流、钩子之类的事件。 */
  parse(line: string): Event[] {
    accumulateUsage(this.tool, line, this.accumulated);
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return [];
    }
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) return [];
    const e = obj(raw);
    let events: Event[];
    switch (this.tool) {
      case 'codex':
        events = parseCodex(e);
        break;
      case 'opencode':
        events = parseOpencode(e);
        break;
      case 'mcode':
        events = parseMcode(e, this.mcodeCalls);
        break;
      case 'agy':
        events = parseAgy(e, this.agyText, this.agyCalls);
        break;
      default: {
        events = parseClaudeLike(e, this.tasks);
        const background = this.backgroundTasks.parse(e);
        if (background) events.push(background);
        const compact = this.compaction.parse(e);
        if (compact) events.push(compact);
      }
    }
    const out: Event[] = [];
    for (const event of events) {
      if (event.kind === KindSession) {
        if (!event.session_id || event.session_id === this.session) continue;
        this.session = event.session_id;
      }
      out.push(event);
    }
    return out;
  }
}

/** 为工具创建解析器；未知工具抛错。 */
export function newParser(tool: string): Parser {
  if (!ValidTools.has(tool)) throw new Error(`未知工具：${tool}`);
  return new Parser(tool);
}
