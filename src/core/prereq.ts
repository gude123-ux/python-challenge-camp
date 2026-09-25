/**
 * prereq.ts —— 找出「这一关需要先会的前置知识」，并把原文贴出来
 *
 * 用户的诉求（原话）：「有的关需要用到之前的关卡的内容或知识点，你帮我贴出来」。
 *
 * 设计取舍：
 *   * **本地算，不调 AI** —— 前置知识必须「一定有、立刻有」，不能因为网关抽风就看不到；
 *     而且贴出来的必须是题库里的**原文**，不能是模型回忆出来的二手内容。
 *   * 判据三档（分数累加）：
 *       1. 同章且在前面的关卡（越近越重要）—— 课程材料是按章递进的，同章前一关几乎必然是基础；
 *       2. 标签重合（题库里每关都带 chapterTags）—— 跨章复用同一批语法的关卡；
 *       3. 正文 4-gram 重合 —— 中文没有分词也能用：真正相关的两关会共享若干 4 字片段。
 *   * 只返回得分最高的前 N 关，并给出「为什么认为它是前置」的理由，方便学生判断。
 */

import type { Level } from './types';

export interface PrereqItem {
  levelId: string;
  day: number;
  title: string;
  /** 为什么认为它是前置（给学生看的理由） */
  reason: string;
  /** 直接从题库贴出来的知识点原文 */
  points: string[];
  /** 该关最容易复用的一小段示例代码（可为空） */
  snippet: string;
  /** 相关度分数，仅用于排序 */
  score: number;
}

/** 取字符串的 n-gram 集合（去掉空白后滑窗） */
export function ngrams(text: string, n = 4): Set<string> {
  const clean = (text ?? '').replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i + n <= clean.length; i++) {
    out.add(clean.slice(i, i + n));
  }
  return out;
}

/** 两个集合的交集大小 */
export function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) {
    if (b.has(x)) {
      n += 1;
    }
  }
  return n;
}

/** 把该关的内容压成一段用于比对文本 */
function levelText(l: Level): string {
  return [l.title, l.goal, ...(l.knowledge ?? []), ...(l.lesson ?? []).map((b) => b.text)].join('\n');
}

/** 从示例代码里取前几行（太长的不贴，避免页面被代码淹没） */
function shortSnippet(code: string, maxLines = 6): string {
  const lines = (code ?? '').split('\n').filter((l) => l.trim());
  return lines.slice(0, maxLines).join('\n');
}

/**
 * 找出一关的前置关卡（按相关度排序，最多 max 个）。
 *
 * @param level 当前关卡
 * @param all   整个题库
 * @param max   最多返回几个（默认 3）
 */
export function findPrerequisites(level: Level, all: Level[], max = 3): PrereqItem[] {
  const mine = ngrams(levelText(level));
  const myTags = new Set(level.tags ?? []);

  const scored = all
    .filter((l) => l.id !== level.id && l.day < level.day)
    .map((l) => {
      let score = 0;
      const reasons: string[] = [];

      // 1) 同章、在前的关卡
      if (l.chapter === level.chapter) {
        score += 3;
        const gap = level.day - l.day;
        if (gap <= 2) {
          score += 2;
          reasons.push(`同属第 ${level.chapter} 章、就在前一关`);
        } else {
          reasons.push(`同属第 ${level.chapter} 章，是这一章的基础`);
        }
      }

      // 2) 标签重合
      const shared = (l.tags ?? []).filter((t) => myTags.has(t));
      if (shared.length) {
        score += 2 * shared.length;
        reasons.push(`共用知识点标签：${shared.join('、')}`);
      }

      // 3) 正文 4-gram 重合（中文也能用）
      const overlap = overlapCount(mine, ngrams(levelText(l)));
      if (overlap >= 6) {
        score += Math.min(4, Math.floor(overlap / 6));
        reasons.push('讲解里反复出现同一批术语');
      }

      return { l, score, reasons };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.l.day - a.l.day)
    .slice(0, max);

  return scored.map((x) => ({
    levelId: x.l.id,
    day: x.l.day,
    title: x.l.title,
    reason: x.reasons.join('；') || '内容相关',
    // 最多贴 4 条，避免页面过长
    points: (x.l.knowledge ?? []).slice(0, 4),
    snippet: shortSnippet(x.l.manualExample),
    score: x.score,
  }));
}

/**
 * 把前置知识渲染成给 AI 看的纯文本（用于生成精讲时引用）。
 */
export function prerequisitesToText(items: PrereqItem[]): string {
  if (!items.length) {
    return '（这是本课程的开头几关，没有前置关卡）';
  }
  return items
    .map((x) => {
      const lines = [`■ 第 ${x.day} 关 ${x.title}（${x.reason}）`];
      x.points.forEach((p) => lines.push(`  - ${p}`));
      if (x.snippet) {
        lines.push('  示例代码：');
        lines.push(
          x.snippet
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')
        );
      }
      return lines.join('\n');
    })
    .join('\n');
}
