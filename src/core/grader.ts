/**
 * grader.ts —— 批改编排
 *
 * 流程：
 *   1.（可选）本地运行学生代码，拿到真实的退出码 / stdout / traceback；
 *   2. 开启 AI 时，把「关卡信息 + 示例代码 + 学生代码 + 运行结果」交给模型，解析 JSON；
 *   3. 关闭 AI 或调用失败时，退回到本地启发式评分，并如实标注来源是 local。
 *
 * 任何一步失败都不会抛出到 UI 层，而是产出一个带 error 字段的结果。
 */

import * as vscode from 'vscode';
import type { GradeResult, Level, RunResult } from './types';
import { chat, AiError } from '../ai/client';
import { buildMessages } from '../ai/prompt';

export interface GradeOptions {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  enableAI: boolean;
  strictMode: boolean;
  weakPoints: string[];
}

const clamp = (n: unknown, min = 0, max = 100): number => {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(v)));
};

const toStrArray = (v: unknown, limit = 6): string[] => {
  if (!Array.isArray(v)) {
    return [];
  }
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim()))
    .filter(Boolean)
    .slice(0, limit);
};

/** 从模型输出里抠出 JSON（容忍 ```json 包裹与前后废话） */
export function extractJson(raw: string): any | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试截取 */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** 把模型输出规整成 GradeResult */
export function normalizeAiResult(raw: string, level: Level): GradeResult | null {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const runnable = obj.runnable === true || obj.runnable === 'true';
  let score = clamp(obj.score);
  if (!runnable && score > 45) {
    score = 45;
  }
  const checks = Array.isArray(obj.exerciseChecks)
    ? obj.exerciseChecks
        .map((c: any, i: number) => ({
          index: Number(c?.index ?? i + 1),
          done: c?.done === true || c?.done === 'true',
          comment: String(c?.comment ?? '').trim(),
        }))
        .slice(0, level.exercises.length || 6)
    : [];

  return {
    score,
    runnable,
    correctness: clamp(obj.correctness),
    quality: clamp(obj.quality),
    summary: String(obj.summary ?? '').trim() || '（模型未给出总评）',
    strengths: toStrArray(obj.strengths, 4),
    issues: toStrArray(obj.issues, 6),
    suggestions: toStrArray(obj.suggestions, 6),
    weakTags: toStrArray(obj.weakTags, 6),
    exerciseChecks: checks,
    source: 'ai',
    raw,
  };
}

/** 本地启发式评分：没有 AI 时的兜底，只做「能跑 + 有内容 + 有注释」的粗判 */
export function localGrade(level: Level, code: string, run: RunResult | null): GradeResult {
  const lines = code.split('\n');
  const codeLines = lines.filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('#');
  });
  const commentLines = lines.filter((l) => l.trim().startsWith('#'));
  const studentComments = commentLines.filter((l) => !/^#\s*(第\s*\d+\s*关|今日目标|示例代码|本关练习|写完后)/.test(l.trim()));

  const runnable = run ? run.ok : false;
  const issues: string[] = [];
  const suggestions: string[] = [];

  let score = 0;
  if (runnable) {
    score += 45;
  } else if (run?.noInterpreter) {
    score += 20;
    issues.push('本机未找到 Python 解释器，无法验证代码是否可运行。');
  } else {
    issues.push(
      run?.errorKind
        ? `代码运行报错（${run.errorKind}），请先修好再提交。`
        : '代码未能成功运行。'
    );
  }
  if (codeLines.length >= 5) {
    score += 15;
  } else {
    issues.push('有效代码行太少，看起来还没有开始写练习。');
  }
  if (/\bprint\s*\(/.test(code)) {
    score += 10;
  } else {
    suggestions.push('用 print() 把关键中间结果打出来，方便你自己检查。');
  }
  if (studentComments.length >= 2) {
    score += 10;
  } else {
    suggestions.push('给关键步骤加注释，说明"这一步在算什么"。');
  }
  if (run?.stdout && run.stdout.trim().length > 0) {
    score += 10;
  }
  score = Math.max(0, Math.min(85, score));

  const label = `第 ${level.day} 关「${level.title}」`;

  return {
    score,
    runnable,
    correctness: runnable ? Math.min(60, score) : 0,
    quality: studentComments.length >= 2 ? 70 : 50,
    summary: runnable
      ? `${label} 本地检查：代码可以运行。（AI 批改未开启，未判断 ${level.exercises.length} 道练习答案的正确性）`
      : `${label} 本地检查：代码未能通过运行，先解决报错。`,
    strengths: runnable ? ['代码能够无报错运行'] : [],
    issues,
    suggestions,
    weakTags: run?.errorKind ? [run.errorKind] : [],
    exerciseChecks: [],
    source: 'local',
  };
}

export interface GradeOutcome {
  result: GradeResult;
  /** AI 失败时的原因，用于提示学生 */
  aiError?: string;
}

/** 主入口：批改一份代码 */
export async function gradeCode(
  level: Level,
  code: string,
  run: RunResult | null,
  opts: GradeOptions
): Promise<GradeOutcome> {
  if (!opts.enableAI) {
    return { result: localGrade(level, code, run) };
  }

  const messages = buildMessages({
    level,
    code,
    run,
    strictMode: opts.strictMode,
    weakPoints: opts.weakPoints,
  });

  try {
    const raw = await chat({
      baseUrl: opts.apiBaseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages,
      temperature: opts.strictMode ? 0.1 : 0.2,
      maxTokens: 2200,
    });
    const parsed = normalizeAiResult(raw, level);
    if (!parsed) {
      const fallback = localGrade(level, code, run);
      return {
        result: { ...fallback, raw },
        aiError: '模型返回的内容无法解析为 JSON，已改用本地检查结果。',
      };
    }
    return { result: parsed };
  } catch (err: any) {
    const msg =
      err instanceof AiError
        ? `${err.message}${err.detail ? `\n${err.detail}` : ''}`
        : String(err?.message ?? err);
    const fallback = localGrade(level, code, run);
    return { result: fallback, aiError: msg };
  }
}

/** 让用户看到 AI 配置问题的统一入口 */
export async function promptAiSetup(message: string): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    message,
    '打开设置',
    '知道了'
  );
  if (pick === '打开设置') {
    await vscode.commands.executeCommand('pythonCamp.openSettings');
  }
}
