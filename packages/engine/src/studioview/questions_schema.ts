/**
 * 结构化多题提问（studio_ask）的统一数据契约、JSON Schema、入参/答复校验与可读格式化。
 */
export const QuestionsSubdir = 'questions';
export const KindQuestion = 'question';
export const KindQuestionDeferred = 'question-deferred';
export const KindQuestionResolved = 'question-resolved';
export const StudioAskToolName = 'studio_ask';
export const QuestionPollInterval = 300;
export const MaxQuestions = 6;
export const MinQuestionOptions = 2;
export const MaxQuestionOptions = 8;

export interface QuestionOption {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface QuestionItem {
  id: string;
  header?: string;
  question: string;
  multi_select?: boolean;
  required?: boolean;
  options: QuestionOption[];
  allow_other?: boolean;
  other_placeholder?: string;
}

export interface QuestionRequest {
  id: string;
  title?: string;
  questions: QuestionItem[];
  source?: 'tool' | 'prose';
}

export interface QuestionAnswerItem {
  question_id: string;
  label: string;
  selected: string[];
  other?: string;
}

export type QuestionResolutionStatus = 'answered' | 'skipped' | 'cancelled' | 'expired';

export interface QuestionResponse {
  status: QuestionResolutionStatus;
  answers?: QuestionAnswerItem[];
  answer_map?: Record<string, string | string[]>;
  note?: string;
}

/** studio_ask 的 JSON Schema（MCP 与内置制作人共用同一份定义）。 */
export const studioAskInputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '整组提问的简短背景标题（可选，例如「开工前确认 3 项规格」）' },
    questions: {
      type: 'array',
      description: `1–${MaxQuestions} 个独立问题；把当前决策节点的多个相关维度合并在一次调用里`,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '题目标识（可选，如 "opening"、"style"；省略自动按 q1/q2 编号）' },
          header: { type: 'string', description: '短标签（≤8 字，用于进度条，如「开场方式」「配音节奏」）' },
          question: { type: 'string', description: '完整问题描述' },
          multi_select: { type: 'boolean', description: '是否允许勾选多项（缺省 false 单选）' },
          required: { type: 'boolean', description: '是否必答（缺省 true）' },
          allow_other: { type: 'boolean', description: '是否内置「其他」自定义输入（缺省 true，无需手写其他选项）' },
          other_placeholder: { type: 'string', description: '「其他」输入框占位提示（可选）' },
          options: {
            type: 'array',
            description: `${MinQuestionOptions}–${MaxQuestionOptions} 个候选选项`,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '选项标识（可选）' },
                label: { type: 'string', description: '选项主文案（简短清晰）' },
                description: { type: 'string', description: '选项差异、适用场景或代价说明（可选）' },
                recommended: { type: 'boolean', description: '是否为推荐项（可选）' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

export const studioAskDescription =
  '在执行过程中向用户展示结构化多问题多选项卡片并等待答复（支持 1–6 题、单选/多选、推荐标记与内置其他输入）。';

export const studioAskHelp = `${studioAskDescription}

把当前节点需要拍板的多个相关维度（如开场方式、画风、节奏、重点章节）合并进一次 studio_ask 调用，
不要分多轮逐个追问，也不要压成 2–3 个打包套餐。界面每题默认自带「其他」自定义输入，选项列表里不要重复写「其他」。
用户提交后会立刻拿到结构化 answers 与 answer_map，在同一轮内直接按用户选择继续执行。

例子：
  studio_ask({"title": "开工前确认 2 项规格", "questions": [{"id": "opening", "header": "开场", "question": "前 15 秒希望用哪种钩子？", "options": [{"label": "直接抛核心反差数据", "description": "3 秒直入结论，信息密度高", "recommended": true}, {"label": "先抛问题留悬念", "description": "节奏更舒缓，适合故事感"}]}, {"id": "focus", "header": "重点章节", "question": "哪些部分需要重点放慢展开？", "multi_select": true, "options": [{"label": "原理拆解"}, {"label": "实测数据对比"}, {"label": "踩坑复盘"}]}]})`;

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 校验并规范化 studio_ask 入参：保证 1–6 题、每题 2–8 项非空选项与唯一题号。 */
export function normalizeQuestionInput(raw: unknown): { title?: string; questions: QuestionItem[] } {
  const obj = asObj(raw);
  const title = trimStr(obj.title);
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    throw new Error('studio_ask 缺少 questions：至少提供 1 个问题');
  }
  if (obj.questions.length > MaxQuestions) {
    throw new Error(`studio_ask 一次最多提 ${MaxQuestions} 个问题（收到 ${obj.questions.length} 个）`);
  }
  const usedIDs = new Set<string>();
  const questions: QuestionItem[] = obj.questions.map((entry, idx) => {
    const q = asObj(entry);
    const question = trimStr(q.question);
    if (question === '') throw new Error(`第 ${idx + 1} 题缺少 question 文案`);
    if (!Array.isArray(q.options)) throw new Error(`第 ${idx + 1} 题缺少 options 选项列表`);
    const seenLabels = new Set<string>();
    const options: QuestionOption[] = [];
    for (const rawOpt of q.options) {
      const opt = typeof rawOpt === 'string' ? { label: rawOpt } : asObj(rawOpt);
      const label = trimStr(opt.label);
      if (label === '' || seenLabels.has(label)) continue;
      seenLabels.add(label);
      const id = trimStr(opt.id);
      const description = trimStr(opt.description);
      const recommended = opt.recommended === true ? true : undefined;
      options.push({
        ...(id ? { id } : {}),
        label,
        ...(description ? { description } : {}),
        ...(recommended ? { recommended } : {}),
      });
    }
    if (options.length < MinQuestionOptions) {
      throw new Error(`第 ${idx + 1} 题至少需要 ${MinQuestionOptions} 个不同选项（收到 ${options.length} 个）`);
    }
    if (options.length > MaxQuestionOptions) {
      throw new Error(`第 ${idx + 1} 题最多支持 ${MaxQuestionOptions} 个选项（收到 ${options.length} 个）`);
    }
    let id = trimStr(q.id) || `q${idx + 1}`;
    if (usedIDs.has(id)) {
      let suffix = 2;
      while (usedIDs.has(`${id}_${suffix}`)) suffix++;
      id = `${id}_${suffix}`;
    }
    usedIDs.add(id);
    const header = trimStr(q.header);
    const multi = q.multi_select === true || q.multiSelect === true;
    const required = q.required !== false;
    const allowOther = q.allow_other !== false && q.allowOther !== false;
    const placeholder = trimStr(q.other_placeholder) || trimStr(q.otherPlaceholder);
    return {
      id,
      ...(header ? { header } : {}),
      question,
      ...(multi ? { multi_select: true } : {}),
      ...(required ? {} : { required: false }),
      options,
      ...(allowOther ? {} : { allow_other: false }),
      ...(placeholder ? { other_placeholder: placeholder } : {}),
    };
  });
  return { ...(title ? { title } : {}), questions };
}

/** 校验并规范化用户的回答提交，生成有序 answers 与便于模型读取的 answer_map。 */
export function normalizeQuestionResponse(req: QuestionRequest, raw: unknown): QuestionResponse {
  const obj = asObj(raw);
  const status = trimStr(obj.status) as QuestionResolutionStatus;
  if (!['answered', 'skipped', 'cancelled', 'expired'].includes(status)) {
    throw new Error('status 只能是 answered、skipped、cancelled 或 expired');
  }
  const note = trimStr(obj.note);
  if (status !== 'answered') {
    return { status, ...(note ? { note } : {}) };
  }
  const byID = new Map<string, { selected: string[]; other: string }>();
  if (Array.isArray(obj.answers)) {
    for (const entry of obj.answers) {
      const a = asObj(entry);
      const qid = trimStr(a.question_id);
      if (!qid) continue;
      const selected = Array.isArray(a.selected) ? a.selected.map((v) => trimStr(v)).filter(Boolean) : [];
      byID.set(qid, { selected, other: trimStr(a.other) });
    }
  } else if (obj.answer_map && typeof obj.answer_map === 'object' && !Array.isArray(obj.answer_map)) {
    for (const [qid, val] of Object.entries(obj.answer_map as Record<string, unknown>)) {
      if (Array.isArray(val)) byID.set(qid, { selected: val.map((v) => trimStr(v)).filter(Boolean), other: '' });
      else if (typeof val === 'string' && val.trim() !== '') byID.set(qid, { selected: [val.trim()], other: '' });
    }
  }
  const answers: QuestionAnswerItem[] = [];
  const answerMap = Object.create(null) as Record<string, string | string[]>;
  for (const q of req.questions) {
    const picked = byID.get(q.id) ?? { selected: [], other: '' };
    const selected = q.multi_select ? [...new Set(picked.selected)] : picked.selected.slice(0, 1);
    const allowed = new Set(q.options.map((opt) => opt.label));
    const invalid = selected.find((val) => !allowed.has(val));
    if (invalid !== undefined) {
      throw new Error(`「${q.header || q.question}」包含无效选项：${invalid}`);
    }
    const other = q.allow_other === false ? '' : picked.other;
    if (q.required !== false && selected.length === 0 && other === '') {
      throw new Error(`请先回答「${q.header || q.question}」`);
    }
    if (!q.multi_select && other !== '' && selected.length > 0) selected.length = 0;
    answers.push({ question_id: q.id, label: q.header || q.question, selected, ...(other ? { other } : {}) });
    if (q.multi_select) {
      const vals = [...selected, ...(other ? [other] : [])];
      if (vals.length > 0) {
        Object.defineProperty(answerMap, q.id, { value: vals, enumerable: true, writable: true, configurable: true });
      }
    } else {
      const val = other || selected[0] || '';
      if (val !== '') {
        Object.defineProperty(answerMap, q.id, { value: val, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return { status: 'answered', answers, answer_map: answerMap, ...(note ? { note } : {}) };
}

/** 把结构化答案格式化成清晰可读的中文摘要，供工具返回或跨轮消息复用。 */
export function formatQuestionAnswers(req: QuestionRequest, resp: QuestionResponse): string {
  if (resp.status === 'skipped') {
    return resp.note ? `用户跳过问题卡片，改用手动说明：${resp.note}` : '用户跳过了问题卡片，将改用手动输入回复。';
  }
  if (resp.status === 'cancelled') return '提问已取消。';
  if (resp.status === 'expired') return '本轮已结束，问题卡片未提交。';
  const list = resp.answers ?? [];
  const answeredCount = list.filter((a) => a.selected.length > 0 || (a.other ?? '') !== '').length;
  const header = req.title
    ? `已完成「${req.title}」（${answeredCount}/${req.questions.length} 题）：`
    : `已完成选择（${answeredCount}/${req.questions.length} 题）：`;
  const lines: string[] = [header];
  req.questions.forEach((q, idx) => {
    const ans = list.find((a) => a.question_id === q.id);
    const title = q.header || q.question;
    const parts: string[] = [];
    if (ans && ans.selected.length > 0) parts.push(ans.selected.join('、'));
    if (ans?.other) parts.push(parts.length > 0 ? `补充：${ans.other}` : `其他：${ans.other}`);
    lines.push(`${idx + 1}. [${title}]：${parts.length > 0 ? parts.join('；') : '（未作答）'}`);
  });
  if (resp.note) lines.push(`补充说明：${resp.note}`);
  return lines.join('\n');
}
