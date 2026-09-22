/**
 * scheduler.ts —— 每日任务派发与重置
 *
 * 规则：
 *   * 每天（本地日期变化）自动派发 N 个任务，N = pythonCamp.dailyTaskCount；
 *   * 任务从「学习前线」开始取未过关的关卡，保证难度是递进的；
 *   * 过关后自动标记今日任务完成；跨天则整批重置；
 *   * 支持手动重置今日任务（换一批）。
 */

import type { Level, ProgressFile } from './types';
import { Curriculum } from './curriculum';
import { ProgressStore } from './store';
import { todayKey } from '../util/paths';

export interface SchedulerOptions {
  dailyTaskCount: number;
  passScore: number;
  /** 允许跳关时，未解锁的关卡也会进入候选池 */
  allowSkipLevels: boolean;
}

export class Scheduler {
  constructor(
    private readonly store: ProgressStore,
    private readonly curriculum: Curriculum
  ) {}

  /** 需要时派发今日任务；返回是否发生了派发 */
  async ensureToday(opts: SchedulerOptions, force = false): Promise<boolean> {
    const progress = this.store.progress;
    const today = todayKey();
    // 日期相同就不动 —— 这样「全部过关、今日无任务」时也不会反复重新派发
    if (!force && progress.daily.date === today) {
      return false;
    }
    const picked = this.pickTasks(progress, opts);
    await this.store.update((p) => {
      p.daily = { date: today, levelIds: picked.map((l) => l.id), done: [] };
    });
    return true;
  }

  /** 重置今日任务（换一批，优先未过关的错题） */
  async resetToday(opts: SchedulerOptions): Promise<Level[]> {
    const progress = this.store.progress;
    const wrong = this.curriculum.wrongLevels(progress, opts.passScore);
    const picked = this.pickTasks(progress, opts, wrong.map((l) => l.id));
    await this.store.update((p) => {
      p.daily = { date: todayKey(), levelIds: picked.map((l) => l.id), done: [] };
    });
    return picked;
  }

  /** 取今天任务的关卡对象 */
  todayLevels(): Level[] {
    const progress = this.store.progress;
    return progress.daily.levelIds
      .map((id) => this.curriculum.get(id))
      .filter((l): l is Level => !!l);
  }

  /**
   * 选任务：先补错题（最多占一半），再按顺序取未过关的关卡补齐。
   *
   * 注意这里不按「当前是否已解锁」过滤 —— 今日任务本身就是解锁通道
   * （见 Curriculum.statusOf）。否则严格顺序解锁下每天只能派 1 关。
   */
  private pickTasks(progress: ProgressFile, opts: SchedulerOptions, wrongIds: string[] = []): Level[] {
    const n = Math.max(1, Math.min(10, opts.dailyTaskCount));
    const picked: Level[] = [];
    const taken = new Set<string>();

    const wrongPool = wrongIds.length
      ? wrongIds
      : this.curriculum.wrongLevels(progress, opts.passScore).map((l) => l.id);

    const wrongQuota = Math.min(Math.floor(n / 2), wrongPool.length);
    for (let i = 0; i < wrongQuota; i++) {
      const lv = this.curriculum.get(wrongPool[i]);
      if (lv && !taken.has(lv.id)) {
        picked.push(lv);
        taken.add(lv.id);
      }
    }

    for (const lv of this.curriculum.all) {
      if (picked.length >= n) {
        break;
      }
      if (taken.has(lv.id)) {
        continue;
      }
      if (this.curriculum.isPassed(lv.id, progress, opts.passScore)) {
        continue;
      }
      picked.push(lv);
      taken.add(lv.id);
    }

    return picked.slice(0, n);
  }

  /** 某关过关后，同步今日任务的完成状态 */
  async markDoneIfToday(levelId: string): Promise<void> {
    const progress = this.store.progress;
    if (!progress.daily.levelIds.includes(levelId)) {
      return;
    }
    if (progress.daily.done.includes(levelId)) {
      return;
    }
    await this.store.update((p) => {
      if (!p.daily.done.includes(levelId)) {
        p.daily.done.push(levelId);
      }
    });
  }

  /** 今日任务进度：done / total */
  todayProgress(): { done: number; total: number } {
    const d = this.store.progress.daily;
    return { done: d.done.length, total: d.levelIds.length };
  }
}
