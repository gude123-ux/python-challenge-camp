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
import { CampConfig, aiReady } from '../core/config';
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
}

export class ViewModelBuilder {
  constructor(
    private readonly store: ProgressStore,
    private readonly curriculum: Curriculum,
    private readonly scheduler: Scheduler
  ) {}

  private chip(level: Level, cfg: CampConfig): LevelChip {
    const p = this.store.progress;
    const lp = p.levels[level.id];
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
    };
  }

  buildSidebar(cfg: CampConfig): SidebarModel {
    const p = this.store.progress;
    const today = todayKey();
    const stats = this.curriculum.stats(p, cfg.passScore, cfg.allowSkipLevels);
    const frontierLevel = this.curriculum.frontier(p, cfg.passScore);

    const chapters: ChapterGroup[] = this.curriculum.chapters.map((ch) => {
      const levels = this.curriculum.levelsOfChapter(ch.id).map((l) => this.chip(l, cfg));
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

    const todayLevels = this.scheduler.todayLevels().map((l) => this.chip(l, cfg));

    return {
      student: { ...p.student },
      today,
      streak: { ...p.stats.streak },
      todayTask: {
        done: p.daily.done.length,
        total: p.daily.levelIds.length,
        levels: todayLevels,
      },
      frontier: frontierLevel ? this.chip(frontierLevel, cfg) : null,
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
      wrong: this.curriculum.wrongLevels(p, cfg.passScore).slice(0, 20).map((l) => this.chip(l, cfg)),
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
    run: RunResult | null = null
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
    };
  }
}
