/**
 * viewModel.ts —— 把 store / curriculum / scheduler 的状态组装成 UI 可用的模型
 *
 * UI 层只负责渲染，不做任何业务判断；所有"这一关能不能打、算不算过关"
 * 都在这里算完再交给 Webview。
 */

import type { AttemptRecord, GradeResult, Level, LevelStatus, RunResult } from '../core/types';
import { Curriculum } from '../core/curriculum';
import { ProgressStore } from '../core/store';
import { Scheduler } from '../core/scheduler';
import type { PendingLevel } from '../core/pending';
import { CampConfig, aiReady } from '../core/config';
import { renderMarkdown } from './html';
import { todayKey } from '../util/paths';

export interface LevelChip {
  id: string;
  day: number;
  title: string;
  difficulty: number;
  status: LevelStatus;
  bestScore: number;
  attempts: number;
  minutes: number;
  tags: string[];
  inDaily: boolean;
  dailyDone: boolean;
  /** 文件里已经写了代码，但一次都没提交过批改 */
  pendingSubmit: boolean;
  /** 待提交时：学生自己写的有效代码行数 */
  pendingLines: number;
}

export interface ChapterGroup {
  id: number;
  title: string;
  difficulty: number;
  totalMinutes: number;
  passed: number;
  total: number;
  levels: LevelChip[];
}

export interface SidebarModel {
  student: { name: string; cohort: string };
  today: string;
  streak: { current: number; best: number };
  todayTask: { done: number; total: number; levels: LevelChip[] };
  frontier: LevelChip | null;
  stats: {
    total: number;
    passed: number;
    unlocked: number;
    completionRate: number;
    avgScore: number;
    scoredCount: number;
    remainingMinutes: number;
    totalStudyMs: number;
    todayMs: number;
  };
  recentDays: Array<{ date: string; ms: number }>;
  weakPoints: Array<{ tag: string; count: number }>;
  chapters: ChapterGroup[];
  wrong: LevelChip[];
  /**
   * 写了代码但一次都没提交批改的关卡。
   *
   * 学生最容易在这里产生「我明明做了，进度却没了」的错觉 ——
   * 所以面板要主动把这件事说出来，并提供一键补交。
   */
  pending: Array<{ id: string; day: number; title: string; codeLines: number }>;
  ai: { enabled: boolean; ready: boolean; model: string; baseUrl: string; strict: boolean };
  passScore: number;
  bankInfo: { generatedAt: string; sources: string[] };
}

export interface LevelDetailModel {
  level: Level;
  status: LevelStatus;
  bestScore: number;
  lastScore: number;
  attempts: number;
  passed: boolean;
  history: AttemptRecord[];
  filePath: string;
  fileExists: boolean;
  inDaily: boolean;
  dailyDone: boolean;
  next: { id: string; title: string } | null;
  prev: { id: string; title: string } | null;
  chapterTitle: string;
  ai: { enabled: boolean; ready: boolean; model: string };
  passScore: number;
  grade: GradeResult | null;
  run: RunResult | null;
  lastComment: string;
  /** AI 报错分析结果（**已渲染并转义好的 HTML**，直接注入 webview） */
  diagnosisHtml?: string;
  /** 最近一次运行是否失败 —— 决定要不要显示「分析报错」按钮 */
  runFailed: boolean;
  /** 文件里有学生自己写的代码，但一次都没提交过批改（>0 时页面会提示补交） */
  pendingLines?: number;
  /** 参考答案（**已渲染并转义好的 HTML**）：批改后没过关或有题目没做出来时自动给出 */
  answerHtml?: string;
  /** 参考答案正在生成中 */
  answerPending?: boolean;
  /** 参考答案的补充说明（例如「已保存到 xxx.md」） */
  answerNote?: string;
}

export class ViewModelBuilder {
  constructor(
    private readonly store: ProgressStore,
    private readonly curriculum: Curriculum,
    private readonly scheduler: Scheduler
  ) {}

  private chip(level: Level, cfg: CampConfig, pending?: Map<string, number>): LevelChip {
    const p = this.store.progress;
    const lp = p.levels[level.id];
    const pendingLines = pending?.get(level.id) ?? 0;
    return {
      id: level.id,
      day: level.day,
      title: level.title,
      difficulty: level.difficulty,
      status: this.curriculum.statusOf(level.id, p, cfg.passScore, cfg.allowSkipLevels),
      bestScore: lp?.bestScore ?? 0,
      attempts: lp?.attempts ?? 0,
      minutes: level.estimatedMinutes,
      tags: level.tags,
      inDaily: p.daily.levelIds.includes(level.id),
      dailyDone: p.daily.done.includes(level.id),
      pendingSubmit: pendingLines > 0,
      pendingLines,
    };
  }

  buildSidebar(cfg: CampConfig, pending: PendingLevel[] = []): SidebarModel {
    const p = this.store.progress;
    const today = todayKey();
    const stats = this.curriculum.stats(p, cfg.passScore, cfg.allowSkipLevels);
    const frontierLevel = this.curriculum.frontier(p, cfg.passScore);
    const pendingMap = new Map(pending.map((x) => [x.levelId, x.codeLines]));

    const chapters: ChapterGroup[] = this.curriculum.chapters.map((ch) => {
      const levels = this.curriculum
        .levelsOfChapter(ch.id)
        .map((l) => this.chip(l, cfg, pendingMap));
      return {
        id: ch.id,
        title: ch.title,
        difficulty: ch.difficulty,
        totalMinutes: ch.totalMinutes,
        passed: levels.filter((l) => l.status === 'passed').length,
        total: levels.length,
        levels,
      };
    });

    const todayLevels = this.scheduler.todayLevels().map((l) => this.chip(l, cfg, pendingMap));

    return {
      student: { ...p.student },
      today,
      streak: { ...p.stats.streak },
      todayTask: {
        done: p.daily.done.length,
        total: p.daily.levelIds.length,
        levels: todayLevels,
      },
      frontier: frontierLevel ? this.chip(frontierLevel, cfg, pendingMap) : null,
      stats: {
        total: stats.total,
        passed: stats.passed,
        unlocked: stats.unlocked,
        completionRate: stats.completionRate,
        avgScore: stats.avgScore,
        scoredCount: stats.scoredCount,
        remainingMinutes: stats.remainingMinutes,
        totalStudyMs: p.stats.totalStudyMs,
        todayMs: p.stats.dailyMs[today] ?? 0,
      },
      recentDays: this.store.recentDays(14),
      weakPoints: this.store.weakRanking(8),
      chapters,
      wrong: this.curriculum
        .wrongLevels(p, cfg.passScore)
        .slice(0, 20)
        .map((l) => this.chip(l, cfg, pendingMap)),
      pending: pending.map((x) => ({
        id: x.levelId,
        day: x.day,
        title: this.curriculum.get(x.levelId)?.title ?? '',
        codeLines: x.codeLines,
      })),
      ai: {
        enabled: cfg.enableAI,
        ready: aiReady(cfg),
        model: cfg.model,
        baseUrl: cfg.apiBaseUrl,
        strict: cfg.strictMode,
      },
      passScore: cfg.passScore,
      bankInfo: {
        generatedAt: this.curriculum.meta.generatedAt,
        sources: this.curriculum.meta.sourceDocs.map((s) => `${s.file}（${s.role}）`),
      },
    };
  }

  buildLevelDetail(
    level: Level,
    cfg: CampConfig,
    fileExists: boolean,
    grade: GradeResult | null = null,
    run: RunResult | null = null,
    diagnosis: string | null = null
  ): LevelDetailModel {
    const p = this.store.progress;
    const lp = p.levels[level.id];
    const nxt = this.curriculum.nextOf(level.id);
    const prv = this.curriculum.previousOf(level.id);
    return {
      level,
      status: this.curriculum.statusOf(level.id, p, cfg.passScore, cfg.allowSkipLevels),
      bestScore: lp?.bestScore ?? 0,
      lastScore: lp?.lastScore ?? 0,
      attempts: lp?.attempts ?? 0,
      passed: this.curriculum.isPassed(level.id, p, cfg.passScore),
      history: (lp?.history ?? []).slice(-8),
      filePath: '',
      fileExists,
      inDaily: p.daily.levelIds.includes(level.id),
      dailyDone: p.daily.done.includes(level.id),
      next: nxt ? { id: nxt.id, title: nxt.title } : null,
      prev: prv ? { id: prv.id, title: prv.title } : null,
      chapterTitle: this.curriculum.chapterOf(level.id)?.title ?? level.chapterTitle,
      ai: { enabled: cfg.enableAI, ready: aiReady(cfg), model: cfg.model },
      passScore: cfg.passScore,
      grade,
      run,
      lastComment: lp?.history?.length ? lp.history[lp.history.length - 1].summary : '',
      diagnosisHtml: diagnosis ? renderMarkdown(diagnosis) : undefined,
      runFailed: !!run && !run.ok,
    };
  }
}
