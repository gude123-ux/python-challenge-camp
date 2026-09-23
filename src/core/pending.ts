/**
 * pending.ts —— 「写了代码但还没提交批改」的检测
 *
 * 为什么需要这一层：
 *   学生很可能在文件里写了代码、甚至跑通了，但**忘了点「提交并批改」**。
 *   这时插件里没有任何记录，面板上显示的还是「可挑战 / 未过关」——
 *   学生的感受就是「我明明做了，进度却没了」。
 *
 * 另一层误解也在这里一起解决：每日任务**跨天会重新派发**（今日完成数归零），
 *   学生容易把「今日 0/3」读成「进度清零」。所以要把两件事分开说清楚：
 *   * 今日任务 = 每天 0 点重派的**当日清单**；
 *   * 累计成绩 = 存在 progress.json 里、**永久保留**的关卡成绩。
 *
 * 本模块只做「扫描 + 判定」，不碰 UI；IO 通过参数注入，方便测试。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Level, ProgressFile } from './types';

/** 关卡文件名里的天数（第02关_变量与数据类型.py） */
const LEVEL_FILE_RE = /第(\d{1,3})关/;

/** 判定阈值：有效代码行数达到这个数才算「动手写了」 */
export const PENDING_MIN_LINES = 2;

/**
 * 数「学生自己写的有效代码行」。
 *
 * 关卡文件模板里的说明**全是注释**，所以剥掉注释行与空行之后，
 * 剩下的基本就是学生写的东西（这里不看语法，只看有没有动手）。
 */
export function countStudentCodeLines(code: string): number {
  return (code ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('#');
    }).length;
}

export interface PendingLevel {
  levelId: string;
  day: number;
  /** 学生自己写的有效代码行数 */
  codeLines: number;
  /** 文件最后修改时间（ISO） */
  mtime: string;
}

/** 注入式 IO（默认用真实 fs，测试里可以传假实现） */
export interface ScanIo {
  readdir: (dir: string) => Promise<string[]>;
  stat: (file: string) => Promise<{ mtimeMs: number }>;
  readFile: (file: string, encoding: 'utf8') => Promise<string>;
}

const realIo: ScanIo = {
  readdir: (dir) => fs.readdir(dir),
  stat: (file) => fs.stat(file),
  readFile: (file, encoding) => fs.readFile(file, encoding),
};

/**
 * 扫描「写了代码但一次都没提交过批改」的关卡。
 *
 * 判定条件（三个都满足才算）：
 *   1. 工作区里存在这一关的 .py 文件；
 *   2. 文件里有 >= PENDING_MIN_LINES 行非注释代码；
 *   3. progress 里这一关的 attempts 为 0（提交过就不再提示，哪怕没过关 —— 那是错题本的事）。
 */
export async function scanPendingSubmissions(
  levels: Level[],
  workDirPath: string,
  progress: ProgressFile,
  io: ScanIo = realIo
): Promise<PendingLevel[]> {
  let files: string[];
  try {
    files = await io.readdir(workDirPath);
  } catch {
    return []; // 目录还不存在 = 学生还没开始写
  }

  const byDay = new Map<number, Level>();
  for (const lv of levels) {
    byDay.set(lv.day, lv);
  }

  const out: PendingLevel[] = [];
  for (const name of files) {
    if (!name.endsWith('.py')) {
      continue;
    }
    const m = LEVEL_FILE_RE.exec(name);
    if (!m) {
      continue;
    }
    const level = byDay.get(Number(m[1]));
    if (!level) {
      continue;
    }
    const lp = progress.levels[level.id];
    if (lp && lp.attempts > 0) {
      continue; // 已经提交过了
    }

    const full = path.join(workDirPath, name);
    let code: string;
    let mtime: string;
    try {
      code = await io.readFile(full, 'utf8');
      const st = await io.stat(full);
      mtime = new Date(st.mtimeMs).toISOString();
    } catch {
      continue; // 读不到就跳过，不影响别的关卡
    }

    const codeLines = countStudentCodeLines(code);
    if (codeLines < PENDING_MIN_LINES) {
      continue; // 还是模板原文
    }
    out.push({ levelId: level.id, day: level.day, codeLines, mtime });
  }

  return out.sort((a, b) => a.day - b.day);
}
