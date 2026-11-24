import type { Usage } from './project';

/** 试镜的一位选手（/api/auditions）。评判之前后端只给 slot、status、outcome、output，看不出是谁。 */
export interface AuditionContestant {
  slot: string;
  status: 'pending' | 'running' | 'done';
  outcome: string;
  /** 产物，相对项目根；没有产物为空。 */
  output: string;
  renderer?: string;
  model?: string;
  /** 两段式：先写设计稿的那一位（空是没有）。 */
  designer?: string;
  designer_model?: string;
  /** 人评考试里的角色：参照（老师，公开）、带经验、不带经验（后两者评判后才给）。 */
  role?: 'control' | 'trial' | 'reference' | '';
  actual_model?: string;
  seconds?: number;
  usage?: Usage | null;
  problems?: string[] | null;
  checks?: string[] | null;
  error?: string;
}

/** 盲评期间后端只给固定动作标签；评判后才附上日志正文。 */
export interface AuditionActivity {
  hint?: string;
  slot: string;
  state: 'pending' | 'starting' | 'running' | 'waiting' | 'done' | 'failed' | 'interrupted' | 'unavailable';
  current: string;
  phase?: 'design' | 'render';
  step_count: number;
  steps: { label: string; state: string; detail?: string }[];
}

export interface AuditionVerdict {
  kind: 'winner' | 'tie' | 'none';
  winner: string;
  note: string;
  at: string;
}

/** 一场试镜：同一镜头、同一份冻结输入，几位选手各渲染一遍。 */
export interface Audition {
  id: string;
  created_at: string;
  scene_id: string;
  scene_dir: string;
  features: string[];
  with_memory: boolean;
  /** 还没评判：选手是谁、花了多少都不给。 */
  blind: boolean;
  contestants: AuditionContestant[];
  verdict: AuditionVerdict | null;
  adopted: { slot: string; at: string } | null;
  /** 人评考试：学生、老师与要考的经验；applied 是结论（评判之后）。 */
  exam?: {
    relation: string;
    student: string;
    teacher: string;
    lessons: string[];
    applied: '' | 'promoted' | 'rejected' | 'undecided';
  } | null;
  exam_outcome?: { applied: string; summary: string };
  warning?: string;
}

/** 按以往的评判，这类镜头谁赢得最多（/api/auditions/recommend）。 */
export interface AuditionRecommendation {
  key: string;
  appearances: number;
  wins: number;
  rate: number;
}

/** 学习关系的一条提议（/api/learning 的 proposals）。 */
export interface LearningProposal {
  student: string;
  teacher: string;
  features: string[];
  matches: number;
  teacher_wins: number;
  student_wins: number;
  ties: number;
  rate: number;
  enough: boolean;
  auditions: string[];
}

export interface LearningRelation {
  id: string;
  student: string;
  teacher: string;
  features: string[];
  created_at: string;
  note: string;
  progress: {
    points: { at: string; audition: string; result: 'win' | 'loss' | 'tie'; rate: number }[];
    exams: { at: string; audition: string; result: 'trial' | 'control' | 'tie' }[];
  };
  lessons: { name: string; description: string; status: string; verified_by: string[]; body: string }[];
  /** 还没学过、两边画面都在的对照场数。 */
  learnable: number;
  /** 老师在范例库里有几份。 */
  exemplars: number;
}

export interface LearningState {
  relations: LearningRelation[];
  proposals: LearningProposal[] | null;
  verdicts: number;
  exemplars: number;
  thresholds: { matches: number; rate: number };
}
