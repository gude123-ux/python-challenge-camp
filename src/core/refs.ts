/**
 * refs.ts —— 找出「这道练习题要用到前面哪一关的代码」，并把那段代码带上
 *
 * 学生的原话：「有很多关卡用的都是之前的关卡的原代码的改写，比如第十关第三题，
 * 但我懒得找第七天那个东西了，你要在题目中把源代码贴过来」。
 *
 * 例子（题库里的真实文本）：
 *   * 第 10 关练习 3：「重构 day07 统计器：把报告生成分成 2–3 个函数…」→ 需要第 7 关的统计器代码
 *   * 第 15 关练习 3：「把 day14 的成绩分析器改造成 ScoreAnalyzer 类…」→ 需要第 14 关的代码
 *
 * 判定分两档（都不依赖 AI，随时可用）：
 *   1. **显式引用**：题目里写了 day07 / 第 7 关 / 第 7 天 / 上一关 / 昨天 → 直接取那一关的示例代码；
 *   2. **代码线索**：题目里出现的标识符（例如 scores、pass_rate、f2_score）在某一关的示例代码里
 *      也出现 → 认为那关的代码就是它的底稿（要求至少 2 个命中，或 1 个「长标识符」命中，
 *      避免把泛泛的词当成引用）。
 */

import type { Level } from './types';

export interface ExerciseRef {
  /** 练习序号，从 1 开始 */
  index: number;
  levelId: string;
  day: number;
  title: string;
  /** 判定依据（给学生看的说明） */
  reason: string;
  /** 被引用的示例代码（原样贴出来） */
  code: string;
}

/** 显式引用：day07 / DAY 7 / 第7关 / 第 7 天 / 上一关 / 前一关 / 昨天 / 上次 */
const DAY_PATTERNS: RegExp[] = [
  /\bday\s*0*(\d{1,3})\b/i,
  /第\s*0*(\d{1,3})\s*[天关课]/,
  /\bD\s*0*(\d{1,3})\b/,
];
const PREV_WORDS = /(上一关|前一关|上个练习|昨天|上次|前面那关|之前的关)/;

/** 从文本里抽标识符（英文/下划线组成的词，长度 >= 3） */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? ''))) {
    const w = m[0];
    // 过滤掉纯通用词
    if (!/^(the|and|for|not|you|can|use|day|print|true|false)$/i.test(w)) {
      out.add(w);
    }
  }
  return out;
}

/** 某一关「能贴出来给学生看的代码」：优先示例代码，退而求其次用模板里的示例段 */
export function sourceCodeOf(level: Level): string {
  if (level.manualExample && level.manualExample.trim()) {
    return level.manualExample.trim();
  }
  // ★ 逐行扫描，不要用 `[\s\S]*?` 这种惰性量词正则：
  //   在 1~3KB 的模板文本上它会**灾难性回溯**，直接把扩展宿主卡死（实测被 SIGTERM）。
  const lines = (level.starterCode ?? '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (start < 0) {
      if (t.includes('示例代码')) {
        start = i + 1;
      }
      continue;
    }
    // 遇到分隔线或「本关练习」就结束
    if (t.includes('本关练习') || /^#\s*=+$/.test(t)) {
      const block = lines
        .slice(start, i)
        .map((l) => l.replace(/^#\s?/, '').trimEnd())
        .filter((l) => l.trim().length > 0);
      return block.join('\n').trim();
    }
  }
  return '';
}

/**
 * 找出每一道练习引用到的前面关卡（按练习序号分组）。
 *
 * @returns Map<练习序号(1-based), ExerciseRef[]>
 */
export function findExerciseRefs(level: Level, all: Level[]): Map<number, ExerciseRef[]> {
  const out = new Map<number, ExerciseRef[]>();
  const earlier = all.filter((l) => l.day < level.day);
  const byDay = new Map(earlier.map((l) => [l.day, l]));

  (level.exercises ?? []).forEach((text, i) => {
    const index = i + 1;
    const found = new Map<string, ExerciseRef>();

    // ---- 1) 显式写了 dayNN / 第 N 关 ----
    for (const base of DAY_PATTERNS) {
      // ★ 必须用这个「带 g 的新正则」去 exec。
      //   踩过的坑：建了 g 却继续调用原来的非全局正则 —— 非全局正则的 lastIndex
      //   永不前进，同一个匹配会无限返回，直接死循环把扩展宿主卡死（实测被 SIGTERM）。
      const re = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text ?? ''))) {
        if (m.index === re.lastIndex) {
          re.lastIndex += 1; // 零长度匹配的兜底，永远不要在这里打转
        }
        const day = Number(m[1]);
        const lv = byDay.get(day);
        if (!lv) {
          continue;
        }
        const code = sourceCodeOf(lv);
        if (!code) {
          continue;
        }
        found.set(lv.id, {
          index,
          levelId: lv.id,
          day: lv.day,
          title: lv.title,
          reason: `题目里写明了要用第 ${lv.day} 关（${m[0].trim()}）的代码`,
          code,
        });
      }
    }

    // ---- 2) 「上一关 / 昨天」这类相对说法 → 取紧邻的前一关 ----
    if (!found.size && PREV_WORDS.test(text ?? '')) {
      const lv = earlier.filter((l) => l.day === level.day - 1)[0];
      if (lv) {
        const code = sourceCodeOf(lv);
        if (code) {
          found.set(lv.id, {
            index,
            levelId: lv.id,
            day: lv.day,
            title: lv.title,
            reason: '题目里提到「上一关 / 昨天」，指的是紧邻的前一关',
            code,
          });
        }
      }
    }

    // ---- 3) 代码线索：题目里的标识符在某一关的示例代码里也出现 ----
    if (!found.size) {
      const mine = identifiers(text ?? '');
      if (mine.size) {
        const scored: Array<{ lv: Level; hits: string[]; score: number }> = [];
        for (const lv of earlier) {
          const code = sourceCodeOf(lv);
          if (!code) {
            continue;
          }
          const hits: string[] = [];
          for (const w of mine) {
            if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code)) {
              hits.push(w);
            }
          }
          // 长标识符（含下划线或 >= 6 字符）命中 1 个就算；普通词要 2 个以上
          const strong = hits.some((w) => w.includes('_') || w.length >= 6);
          const score = strong ? hits.length + 1 : hits.length;
          if (hits.length >= 2 || strong) {
            scored.push({ lv, hits, score });
          }
        }
        scored.sort((a, b) => b.score - a.score || b.lv.day - a.lv.day);
        const best = scored[0];
        if (best) {
          found.set(best.lv.id, {
            index,
            levelId: best.lv.id,
            day: best.lv.day,
            title: best.lv.title,
            reason: `题目里的 ${best.hits.slice(0, 3).map((h) => '`' + h + '`').join('、')} 出现在第 ${best.lv.day} 关的示例代码里`,
            code: sourceCodeOf(best.lv),
          });
        }
      }
    }

    if (found.size) {
      out.set(index, Array.from(found.values()).sort((a, b) => b.day - a.day).slice(0, 2));
    }
  });

  return out;
}

/** 把引用到的代码渲染成可以追加到学生文件里的注释块 */
export function refsCommentBlock(refs: Map<number, ExerciseRef[]>): string {
  const lines: string[] = [];
  refs.forEach((items, index) => {
    for (const r of items) {
      lines.push('');
      lines.push('# ' + '='.repeat(58));
      lines.push(`# 第 ${index} 题要用到的代码 —— 来自第 ${r.day} 关「${r.title}」`);
      lines.push(`# （${r.reason}）`);
      lines.push('# ' + '='.repeat(58));
      for (const l of r.code.split('\n')) {
        lines.push('# ' + l);
      }
    }
  });
  return lines.join('\n');
}

/**
 * 把「每道练习引用的前关代码」渲染成给 AI 看的文本。
 *
 * 这样生成精讲时，模型能直接看到「第 3 题要用第 7 关那段统计器」，
 * 逐题提示就能贴着真实代码写，而不是泛泛而谈。
 */
export function exerciseRefsToText(level: Level, all: Level[]): string {
  const refs = findExerciseRefs(level, all);
  if (!refs.size) {
    return '';
  }
  const parts: string[] = ['【本关练习要用到的前面关卡的代码（原样给出）】'];
  refs.forEach((items, index) => {
    for (const r of items) {
      parts.push(`■ 第 ${index} 题 需要第 ${r.day} 关「${r.title}」的代码（${r.reason}）：`);
      parts.push('```python', r.code, '```');
    }
  });
  return parts.join('\n');
}
