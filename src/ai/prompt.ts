/**
 * prompt.ts —— 批改提示词
 *
 * 设计要点：
 *   * 把「示例代码」一并交给模型 —— 本插件的主线是代码复现，
 *     模型需要知道「标准答案长什么样」才能判断学生是否真的复现出来了。
 *   * 把本地运行结果（真实 traceback / stdout）作为客观事实喂进去，
 *     避免模型凭空猜测「这段代码能不能跑」。
 *   * 强制 JSON 输出，字段固定，便于落库与展示。
 */

import type { Level, RunResult } from '../core/types';

export interface PromptContext {
  level: Level;
  code: string;
  run: RunResult | null;
  strictMode: boolean;
  /** 该学生历史上的薄弱标签，帮助模型给出针对性建议 */
  weakPoints: string[];
}

const SYSTEM = `你是「Python 闯关训练营」的批改助教。
学生正在按课程材料逐关学习，主线是"看知识点 → 复现示例代码 → 完成本关练习"。

你的任务：阅读学生的代码与本地运行结果，给出严格、具体、可执行的批改意见。

评分维度（满分 100）：
- 可运行性 runnable：代码能否无报错运行。有语法错误或运行报错即为 false。
- 正确性 correctness：是否真正完成了本关的练习，逻辑与结果是否正确。
- 代码质量 quality：可读性、命名、注释、是否用了本关教的方法（例如该用向量化却写 for 循环要扣分）。

总分 score 的构成：正确性 50% + 代码质量 25% + 可运行性 25%。
硬性约束：如果 runnable 为 false，score 不得超过 45 分。
如果学生只是把示例代码原样复制、没有完成本关练习，correctness 不得超过 40 分。

评语要求：
- 用中文，语气像一位认真的助教：直接指出问题，不空泛表扬。
- issues 要指出具体位置或具体语句，不要只说"代码可以更好"。
- suggestions 必须可操作，最好给出改写后的代码片段（用 markdown 代码块）。
- 如果学生用了本关还没教的东西，要提醒他先按本关方法写。

只输出 JSON，不要输出任何解释文字、不要用 markdown 代码块包裹整体。`;

function runSection(run: RunResult | null): string {
  if (!run) {
    return '【本地运行结果】\n（未运行。请仅根据代码本身判断可运行性，并在 issues 里提醒学生先自己运行一次。）';
  }
  if (run.noInterpreter) {
    return '【本地运行结果】\n未找到 Python 解释器，无法运行。请不要因此扣分，只根据代码本身判断。';
  }
  const lines = [
    '【本地运行结果】',
    `- 退出码：${run.exitCode === null ? '未启动' : run.exitCode}`,
    `- 是否超时：${run.timedOut ? '是' : '否'}`,
    `- 耗时：${run.durationMs} ms`,
    run.errorKind ? `- 检测到的错误类型：${run.errorKind}` : '- 未检测到异常类型',
    '',
    'stdout:',
    '```',
    run.stdout.trim() || '（无输出）',
    '```',
    'stderr:',
    '```',
    run.stderr.trim() || '（无错误输出）',
    '```',
  ];
  return lines.join('\n');
}

function levelSection(level: Level): string {
  const lines = [
    `【关卡】第 ${level.day} 关 · ${level.title}`,
    `【所属章节】第 ${level.chapter} 章 ${level.chapterTitle}`,
    `【难度】${level.difficulty}/5`,
    `【今日目标】${level.goal || '（见知识点）'}`,
    '',
    '【知识点简述】',
    ...level.knowledge.map((k, i) => `${i + 1}. ${k}`),
  ];
  if (level.manualExample) {
    lines.push(
      '',
      '【示例代码（本关要求学生复现的目标）】',
      '```python',
      level.manualExample,
      '```'
    );
  }
  lines.push('', '【今日练习（学生必须完成的题目）】');
  level.exercises.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
  if (level.accept) {
    lines.push('', `【验收标准】${level.accept}`);
  }
  return lines.join('\n');
}

export function buildMessages(ctx: PromptContext): Array<{ role: 'system' | 'user'; content: string }> {
  const { level, code, run, strictMode, weakPoints } = ctx;

  const strict = strictMode
    ? '\n【严格模式已开启】代码质量权重要更重：命名不规范、缺注释、可读性差要明显扣分。'
    : '';

  const weak = weakPoints.length
    ? `\n【该学生历史薄弱知识点】${weakPoints.join('、')}\n如果本次代码又踩到这些点，请在 issues 里明确点出来。`
    : '';

  const schema = `【输出 JSON 结构（严格遵守字段名）】
{
  "score": 0-100 的整数,
  "runnable": true/false,
  "correctness": 0-100 的整数,
  "quality": 0-100 的整数,
  "summary": "两三句话的总评",
  "strengths": ["做得好的地方，最多 3 条"],
  "issues": ["具体问题，按严重程度排序，最多 5 条"],
  "suggestions": ["改进建议，尽量带代码片段，最多 5 条"],
  "weakTags": ["暴露出的薄弱知识点，用简短中文词，如 axis、函数默认值、f-string 格式"],
  "exerciseChecks": [
    { "index": 1, "done": true/false, "comment": "这道练习的完成情况" }
  ]
}`;

  const user = [
    levelSection(level),
    '',
    runSection(run),
    '',
    '【学生提交的代码】',
    '```python',
    code,
    '```',
    strict,
    weak,
    '',
    schema,
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
