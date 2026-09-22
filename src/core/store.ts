/**
 * store.ts —— 闯关进度的本地持久化
 *
 * 所有数据都写在工作区内的 `.pythoncamp/progress.json`：
 *   * 不上传任何东西；只有「提交批改」时才会把当前文件的代码片段发给模型。
 *   * 写入采用「内存缓存 + 原子落盘」，避免频繁 IO 与半截文件。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { LevelProgress, ProgressFile, StreakInfo } from './types';
import { progressFilePath, todayKey, dateKeyShift } from '../util/paths';

const SCHEMA_VERSION = 1;

function emptyProgress(): ProgressFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    student: { name: '', cohort: '' },
    createdAt: now,
    updatedAt: now,
    // date 为空串表示「从未派发过」，以此区分「还没派发」和「派发了但没任务」
    daily: { date: '', levelIds: [], done: [] },
    levels: {},
    stats: {
      totalStudyMs: 0,
      dailyMs: {},
      activeDays: [],
      streak: { current: 0, best: 0, lastDate: '' },
    },
    weakPoints: {},
    meta: {},
  };
}

function emptyLevelProgress(levelId: string): LevelProgress {
  return {
    levelId,
    status: 'locked',
    bestScore: 0,
    lastScore: 0,
    attempts: 0,
    history: [],
    weakTags: [],
  };
}

export class ProgressStore {
  private data: ProgressFile;
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly file: string;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** 进度变化事件，UI 订阅它刷新 */
  readonly onDidChange = this._onDidChange.event;

  constructor(context: vscode.ExtensionContext) {
    this.file = progressFilePath(context);
    this.data = emptyProgress();
  }

  get progress(): ProgressFile {
    return this.data;
  }

  get filePath(): string {
    return this.file;
  }

  /** 首次读取（或文件损坏时重建） */
  async load(): Promise<ProgressFile> {
    if (this.loaded) {
      return this.data;
    }
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as ProgressFile;
      this.data = this.migrate(parsed);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        // 文件存在但坏了：备份一份再重建，别直接吞掉用户数据
        try {
          const bak = `${this.file}.corrupt-${Date.now()}`;
          await fs.rename(this.file, bak);
          void vscode.window.showWarningMessage(
            `进度文件解析失败，已备份到 ${path.basename(bak)} 并重新开始。`
          );
        } catch {
          /* 备份失败也不阻塞 */
        }
      }
      this.data = emptyProgress();
    }
    this.loaded = true;
    return this.data;
  }

  /** 补齐缺失字段，保证旧文件也能用 */
  private migrate(p: Partial<ProgressFile>): ProgressFile {
    const base = emptyProgress();
    const merged: ProgressFile = {
      ...base,
      ...p,
      schemaVersion: SCHEMA_VERSION,
      student: { ...base.student, ...(p.student ?? {}) },
      daily: { ...base.daily, ...(p.daily ?? {}) },
      stats: {
        ...base.stats,
        ...(p.stats ?? {}),
        streak: { ...base.stats.streak, ...(p.stats?.streak ?? {}) },
        dailyMs: { ...(p.stats?.dailyMs ?? {}) },
        activeDays: [...(p.stats?.activeDays ?? [])],
      },
      levels: { ...(p.levels ?? {}) },
      weakPoints: { ...(p.weakPoints ?? {}) },
      meta: { ...base.meta, ...(p.meta ?? {}) },
    };
    for (const [id, lp] of Object.entries(merged.levels)) {
      merged.levels[id] = {
        ...emptyLevelProgress(id),
        ...lp,
        history: [...(lp?.history ?? [])],
        weakTags: [...(lp?.weakTags ?? [])],
      };
    }
    return merged;
  }

  /** 取某一关的进度（不存在则创建） */
  level(levelId: string): LevelProgress {
    let lp = this.data.levels[levelId];
    if (!lp) {
      lp = emptyLevelProgress(levelId);
      this.data.levels[levelId] = lp;
    }
    return lp;
  }

  /** 排队写盘，避免并发写坏文件 */
  async save(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(this.data, null, 1);
    const file = this.file;
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, file);
    });
    await this.writeChain;
    this._onDidChange.fire();
  }

  /** 改动 + 落盘 + 通知 UI 的便捷入口 */
  async update(mutator: (p: ProgressFile) => void): Promise<void> {
    mutator(this.data);
    await this.save();
  }

  // ---------------------------------------------------------------- 统计

  /** 累计学习时长（毫秒），写进今天的桶里 */
  async addStudyTime(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    const today = todayKey();
    const s = this.data.stats;
    s.totalStudyMs += ms;
    s.dailyMs[today] = (s.dailyMs[today] ?? 0) + ms;
    if (!s.activeDays.includes(today)) {
      s.activeDays.push(today);
      s.activeDays.sort();
    }
    this.updateStreak();
    await this.save();
  }

  /** 连续打卡天数：昨天或今天有活动则累加，否则从 1 重新开始 */
  private updateStreak(): void {
    const s = this.data.stats;
    const today = todayKey();
    const streak: StreakInfo = s.streak;
    if (streak.lastDate === today) {
      return;
    }
    if (streak.lastDate === dateKeyShift(today, -1)) {
      streak.current += 1;
    } else if (streak.lastDate === '') {
      streak.current = 1;
    } else {
      streak.current = 1;
    }
    streak.best = Math.max(streak.best, streak.current);
    streak.lastDate = today;
  }

  /** 标记今天为「有活动」 */
  async touchActiveDay(): Promise<void> {
    const today = todayKey();
    const s = this.data.stats;
    if (!s.activeDays.includes(today)) {
      s.activeDays.push(today);
      s.activeDays.sort();
    }
    this.updateStreak();
    await this.save();
  }

  /** 累计薄弱标签权重 */
  async addWeakPoints(tags: string[]): Promise<void> {
    if (tags.length === 0) {
      return;
    }
    for (const t of tags) {
      const key = t.trim();
      if (!key) {
        continue;
      }
      this.data.weakPoints[key] = (this.data.weakPoints[key] ?? 0) + 1;
    }
    await this.save();
  }

  /** 薄弱知识点排行（降序） */
  weakRanking(limit = 8): Array<{ tag: string; count: number }> {
    return Object.entries(this.data.weakPoints)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /** 最近 n 天的学习时长（含 0），用于趋势图 */
  recentDays(n = 14): Array<{ date: string; ms: number }> {
    const out: Array<{ date: string; ms: number }> = [];
    const today = todayKey();
    for (let i = n - 1; i >= 0; i--) {
      const d = dateKeyShift(today, -i);
      out.push({ date: d, ms: this.data.stats.dailyMs[d] ?? 0 });
    }
    return out;
  }

  async resetAll(): Promise<void> {
    const student = this.data.student;
    this.data = emptyProgress();
    this.data.student = student;
    await this.save();
  }
}
