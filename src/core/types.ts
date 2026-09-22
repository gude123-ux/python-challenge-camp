/**
 * types.ts —— 全插件共享的数据契约
 *
 * 所有持久化结构都带 schemaVersion，方便后续升级时做迁移。
 */

/** 题库里的一个关卡 */
export interface Level {
  /** 关卡 ID，如 L01 / A07 */
  id: string;
  /** 序号（专项关卡可用扩展编号） */
  day: number;
  /** 所属章节号 */
  chapter: number;
  chapterTitle: string;
  title: string;
  /** 1-5 难度 */
  difficulty: number;
  estimatedMinutes: number;
  /** 今日目标（一句话） */
  goal: string;
  /** 知识点简述 */
  knowledge: string[];
  /** 本关练习题 */
  exercises: string[];
  /** 验收标准 */
  accept: string;
  /** 迁移视角 */
  transfer: string;
  /** 参考示例代码（复现目标，仅供参考） */
  manualExample: string;
  /** 给学生的新建文件模板 */
  starterCode: string;
  tags: string[];
  /** 出处标注 */
  source: string;
}

export interface Chapter {
  id: number;
  title: string;
  levelIds: string[];
  difficulty: number;
  totalMinutes: number;
}

export interface LevelBank {
  schemaVersion: number;
  generatedAt: string;
  generator: string;
  sourceDocs: Array<{ file: string; role: string }>;
  chapters: Chapter[];
  levels: Level[];
}

/** 关卡状态 */
export type LevelStatus = 'locked' | 'unlocked' | 'passed';

export interface AttemptRecord {
  at: string;
  score: number;
  runnable: boolean;
  correctness: number;
  quality: number;
  summary: string;
  source: 'ai' | 'local';
}

export interface LevelProgress {
  levelId: string;
  status: LevelStatus;
  bestScore: number;
  lastScore: number;
  attempts: number;
  passedAt?: string;
  lastSubmitAt?: string;
  /** 最近若干次成绩，用于趋势图 */
  history: AttemptRecord[];
  /** 该关暴露出的薄弱标签 */
  weakTags: string[];
  /** 是否由「手动切换关卡」解锁 */
  manualUnlocked?: boolean;
}

/** 每日任务 */
export interface DayTask {
  /** YYYY-MM-DD（本地时区） */
  date: string;
  levelIds: string[];
  /** 已完成的关卡 ID */
  done: string[];
}

export interface StreakInfo {
  current: number;
  best: number;
  lastDate: string;
}

export interface ProgressFile {
  schemaVersion: number;
  student: { name: string; cohort: string };
  createdAt: string;
  updatedAt: string;
  daily: DayTask;
  levels: Record<string, LevelProgress>;
  stats: {
    totalStudyMs: number;
    /** YYYY-MM-DD -> 毫秒 */
    dailyMs: Record<string, number>;
    /** 有学习记录的日期，升序 */
    activeDays: string[];
    streak: StreakInfo;
  };
  /** 标签 -> 累计扣分次数，用于「薄弱知识点」 */
  weakPoints: Record<string, number>;
  meta: {
    lastLevelId?: string;
    lastOpenedAt?: string;
  };
}

/** 本地运行结果 */
export interface RunResult {
  /** 进程是否以 0 退出 */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  pythonPath: string;
  /** 从 stderr 里粗分类出来的错误类型 */
  errorKind?: string;
  /** 解释器本身没找到 */
  noInterpreter?: boolean;
}

/** AI / 本地批改结果 */
export interface GradeResult {
  /** 0-100 */
  score: number;
  /** 代码能否跑通 */
  runnable: boolean;
  /** 答案正确性 0-100 */
  correctness: number;
  /** 代码质量 0-100 */
  quality: number;
  /** 总评 */
  summary: string;
  /** 做得好的地方 */
  strengths: string[];
  /** 问题清单 */
  issues: string[];
  /** 改进建议 */
  suggestions: string[];
  /** 薄弱知识点标签 */
  weakTags: string[];
  /** 逐条练习的完成情况 */
  exerciseChecks: Array<{ index: number; done: boolean; comment: string }>;
  source: 'ai' | 'local';
  /**
   * 模型返回的 JSON 结构损坏、靠「逐字段抢救」才拿到结果。
   * 此时分数可用，但建议列表可能不完整 —— UI 会给出提示。
   */
  salvaged?: boolean;
  /** 模型返回的原始文本，便于排查 */
  raw?: string;
  /** 出错时的提示（例如 API Key 无效） */
  error?: string;
}

/** 侧边栏 <-> 插件主进程的消息 */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'startToday' }
  | { type: 'openLevel'; levelId: string }
  | { type: 'submitLevel'; levelId: string }
  | { type: 'runLevel'; levelId: string }
  | { type: 'answerLevel'; levelId: string }
  | { type: 'solutionsLevel'; levelId: string }
  | { type: 'askLevel'; levelId: string }
  | { type: 'ask' }
  | { type: 'resetToday' }
  | { type: 'retryWrong' }
  | { type: 'pickLevel' }
  | { type: 'openSettings' }
  | { type: 'exportReport' }
  | { type: 'resetAll' }
  | { type: 'setStudent'; name: string; cohort: string }
  | { type: 'unlockLevel'; levelId: string }
  | { type: 'openDoc' };
