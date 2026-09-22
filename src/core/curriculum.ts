/**
 * curriculum.ts —— 题库加载、章节树、解锁判定
 *
 * 解锁规则（可在设置里放宽）：
 *   1. 第 1 关永远可打；
 *   2. 第 N 关在前一关「已过关」（bestScore >= passScore）后解锁；
 *   3. 开启 allowSkipLevels 后，所有关卡都可直接进入（用于复习/跳学）。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Chapter, Level, LevelBank, LevelStatus, ProgressFile } from './types';

export interface LevelStats {
  total: number;
  passed: number;
  unlocked: number;
  completionRate: number;
  avgScore: number;
  scoredCount: number;
  totalMinutes: number;
  remainingMinutes: number;
}

export class Curriculum {
  private bank!: LevelBank;
  private byId = new Map<string, Level>();
  private order: string[] = [];

  load(extensionUri: vscode.Uri): void {
    const file = path.join(extensionUri.fsPath, 'data', 'levels.json');
    const raw = fs.readFileSync(file, 'utf8');
    this.bank = JSON.parse(raw) as LevelBank;
    this.order = this.bank.levels.map((l) => l.id);
    this.byId = new Map(this.bank.levels.map((l) => [l.id, l]));
  }

  get all(): Level[] {
    return this.bank.levels;
  }

  get chapters(): Chapter[] {
    return this.bank.chapters;
  }

  get meta(): Pick<LevelBank, 'generatedAt' | 'sourceDocs' | 'generator'> {
    return {
      generatedAt: this.bank.generatedAt,
      sourceDocs: this.bank.sourceDocs,
      generator: this.bank.generator,
    };
  }

  get(id: string): Level | undefined {
    return this.byId.get(id);
  }

  /** 关卡在题库中的序号（从 0 开始），用于解锁判定 */
  indexOf(id: string): number {
    return this.order.indexOf(id);
  }

  /** 前一关 */
  previousOf(id: string): Level | undefined {
    const i = this.indexOf(id);
    return i > 0 ? this.byId.get(this.order[i - 1]) : undefined;
  }

  /** 下一关 */
  nextOf(id: string): Level | undefined {
    const i = this.indexOf(id);
    return i >= 0 && i < this.order.length - 1 ? this.byId.get(this.order[i + 1]) : undefined;
  }

  chapterOf(id: string): Chapter | undefined {
    const lv = this.get(id);
    return lv ? this.bank.chapters.find((c) => c.id === lv.chapter) : undefined;
  }

  levelsOfChapter(chapterId: number): Level[] {
    const ch = this.bank.chapters.find((c) => c.id === chapterId);
    if (!ch) {
      return [];
    }
    return ch.levelIds.map((id) => this.byId.get(id)!).filter(Boolean);
  }

  /** 按 id 前缀/标题模糊搜索 */
  search(keyword: string): Level[] {
    const k = keyword.trim().toLowerCase();
    if (!k) {
      return [];
    }
    return this.all.filter(
      (l) =>
        l.id.toLowerCase().includes(k) ||
        l.title.toLowerCase().includes(k) ||
        l.tags.some((t) => t.toLowerCase().includes(k)) ||
        String(l.day) === k
    );
  }

  // ---------------------------------------------------------------- 解锁

  isPassed(levelId: string, progress: ProgressFile, passScore: number): boolean {
    const lp = progress.levels[levelId];
    return !!lp && lp.bestScore >= passScore;
  }

  /**
   * 关卡状态。
   *
   * 解锁通道有两条：
   *   1. 顺序推进 —— 前一关过关后解锁下一关；
   *   2. 今日任务 —— 被派发进今日任务的关卡直接视为已解锁。
   *      这一条很关键：否则严格顺序解锁下，每天只能派发 1 关，
   *      「每日 3 关任务」就没有意义了。
   */
  statusOf(levelId: string, progress: ProgressFile, passScore: number, allowSkip: boolean): LevelStatus {
    if (this.isPassed(levelId, progress, passScore)) {
      return 'passed';
    }
    if (allowSkip) {
      return 'unlocked';
    }
    const idx = this.indexOf(levelId);
    if (idx <= 0) {
      return 'unlocked';
    }
    if (progress.levels[levelId]?.manualUnlocked) {
      return 'unlocked';
    }
    if (progress.daily.levelIds.includes(levelId)) {
      return 'unlocked';
    }
    const prev = this.order[idx - 1];
    return this.isPassed(prev, progress, passScore) ? 'unlocked' : 'locked';
  }

  /** 第一关未过关的位置 = 学习前线 */
  frontier(progress: ProgressFile, passScore: number): Level | undefined {
    for (const id of this.order) {
      if (!this.isPassed(id, progress, passScore)) {
        return this.byId.get(id);
      }
    }
    return undefined;
  }

  /** 统计概览 */
  stats(progress: ProgressFile, passScore: number, allowSkip: boolean): LevelStats {
    let passed = 0;
    let unlocked = 0;
    let scoreSum = 0;
    let scoredCount = 0;
    let totalMinutes = 0;
    let remainingMinutes = 0;

    for (const lv of this.all) {
      const st = this.statusOf(lv.id, progress, passScore, allowSkip);
      if (st === 'passed') {
        passed += 1;
      } else {
        remainingMinutes += lv.estimatedMinutes;
      }
      if (st !== 'locked') {
        unlocked += 1;
      }
      totalMinutes += lv.estimatedMinutes;
      const lp = progress.levels[lv.id];
      if (lp && lp.attempts > 0) {
        scoreSum += lp.bestScore;
        scoredCount += 1;
      }
    }

    return {
      total: this.all.length,
      passed,
      unlocked,
      completionRate: this.all.length ? passed / this.all.length : 0,
      avgScore: scoredCount ? scoreSum / scoredCount : 0,
      scoredCount,
      totalMinutes,
      remainingMinutes,
    };
  }

  /** 错题关卡：做过但没到分数线，按最好成绩升序 */
  wrongLevels(progress: ProgressFile, passScore: number): Level[] {
    return this.all
      .filter((lv) => {
        const lp = progress.levels[lv.id];
        return lp && lp.attempts > 0 && lp.bestScore < passScore;
      })
      .sort((a, b) => {
        const sa = progress.levels[a.id]?.bestScore ?? 0;
        const sb = progress.levels[b.id]?.bestScore ?? 0;
        return sa - sb;
      });
  }
}
