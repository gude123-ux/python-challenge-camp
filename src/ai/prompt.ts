/**
 * prompt.ts —— 批改提示词
 *
 * 设计要点：
 *   * 把「示例代码」一并交给模型 —— 本插件的主线是代码复现，
 *     模型需要知道「标准答案长什么样」才能判断学生是否真的复现出来了。
 *   * 把本地运行结果（真实 traceback / stdout）作为客观事实喂进去，
 *     避免模型凭空猜测「这段代码能不能跑」。
 *   * 强制 JSON 输出，字段固定，便于落库与展示。
 *   * **明确约束字符串内部的引号** —— 模型描述「要运行的命令」时习惯写
 *     `python -c "print(1)"`，内层双引号不转义就会让整份 JSON 报废
 *     （真实踩过：整条批改退化成"本地评分"）。提示词里直接给正反例，
 *     并引导它改用反引号 / 中文引号。
 */

import type { Level, RunResult } from '../core/types';

export interface PromptContext {
  level: Level;
  code: string;
  run: RunResult | null;
  strictMode: boolean;
  /** 该学生历史上的薄弱标签，帮助模型给出针对性建议 */
  weakPoints: string[];
  /**
   * 学生在集成终端里执行过的命令与输出（已格式化）。
   *
   * 存在的意义：课程材料里不少练习是「在终端敲一条命令看输出」，
   * 这类证据不可能出现在 .py 文件里。没有它，模型会误判成"练习未完成"而扣分。
   */
  terminal?: string | null;
}

const SYSTEM = `你是「Python 闯关训练营」的批改助教。
学生正在按课程材料逐关学习，主线是"看知识点 → 复现示例代码 → 完成本关练习"。

你的任务：阅读学生的代码与本地运行结果，给出严格、具体、可执行的批改意见。

评分维度（满分 100）：
- 可运行性 runnable：代码能否无报错运行。有语法错误或运行报错即为 false。
- 正确性 correctness：是否真正完成了本关的本关练习，逻辑与结果是否正确。
- 代码质量 quality：可读性、命名、注释、是否用了本关教的方法（例如该用向量化却写 for 循环要扣分）。

总分 score 的构成：正确性 50% + 代码质量 25% + 可运行性 25%。
硬性约束：如果 runnable 为 false，score 不得超过 45 分。
如果学生只是把示例代码原样复制、没有完成本关练习，correctness 不得超过 40 分。

【证据的用法 —— 这一条直接决定分数公不公平，务必遵守】
你会拿到两类证据：
  ① 【本地运行结果】= 插件跑学生这个 .py 文件得到的真实退出码 / stdout / traceback；
  ② 【学生在集成终端里执行过的命令与输出】= 学生自己敲的命令（可能是在终端里跑同一个文件，
     也可能是 \`python -c "..."\` 这种一次性验证命令）。

- 课程材料里有些练习要求「在终端执行一条命令观察结果」。这类练习的完成证据**只可能出现在 ②**。
  只要 ② 里能看到学生确实执行过对应命令、且输出符合预期，就判为**已完成**，
  绝对不要因为 .py 文件里没写这些命令而判未完成或扣分。
- 反过来，如果 ② 里有某条命令的 traceback，那和 ① 里的报错同等有效，要算进可运行性判断。
- **证据不足 ≠ 做错了**：如果两类证据都看不到某道练习的完成情况，不要直接判错、不要因此扣分。
  此时 exerciseChecks 里把该条 done 设为 false，但 comment 必须写"证据不足，无法验证，请自己确认结果"，
  并且把「怎么自己验证」写进 suggestions —— 而不是写进 issues。
- 只有当你有明确反证时（代码逻辑与题目要求不符、结果明显不对、复现缺失、报错），才判该项未完成。
- **以本关讲义为准**：讲义（见下）里教了什么写法、什么命名习惯，就按那个标准判。
  学生用了讲义没教过的东西不算错，但要在 suggestions 里提醒「这是后面的内容，现在先按本关方法写」。

评语要求：
- 用中文，语气像一位认真的助教：直接指出问题，不空泛表扬。
- issues 要指出具体位置或具体语句，不要只说"代码可以更好"。
- suggestions 必须可操作，最好给出改写后的代码片段（用 markdown 代码块）。
- 如果学生用了本关还没教的东西，要提醒他先按本关方法写。

只输出 JSON，不要输出任何解释文字、不要用 markdown 代码块包裹整体。

【JSON 格式硬要求（违反会导致整份结果作废）】
- **字符串值内部不要出现英文双引号 "**。要引用代码、命令、变量名时，
  用反引号 \` 或中文引号「」包起来。
  反例：…体现运行了"python -c "print(1)""来观察…   ← 内层引号没转义，整份 JSON 报废
  正例：…体现运行了\`python -c 'print(1)'\`来观察…
- 如果确实非用英文双引号不可，必须写成 \\" 转义。
- 字符串里不要出现裸换行，需要换行时写成 \\n。
- 数组/对象之间的逗号不要多、也不要少。`;

function runSection(run: RunResult | null): string {
  if (!run) {
    return '【本地运行结果】\n（未运行。请先看下面的终端记录有没有学生自己跑过的证据；都没有时，不要因此扣分，只在 issues 里提醒他先自己运行一次。）';
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
  const lesson = lessonText(level, 1800);
  if (lesson) {
    lines.push('', lesson);
  }
  if (level.manualExample) {
    lines.push(
      '',
      '【示例代码（本关要求学生复现的目标，可能因 PDF 排版有折行）】',
      '```python',
      level.manualExample,
      '```'
    );
  }
  lines.push('', '【本关练习（学生必须完成的题目）】');
  level.exercises.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
  if (level.accept) {
    lines.push('', `【验收标准】${level.accept}`);
  }
  return lines.join('\n');
}

/**
 * 把「本关讲义」拼成提示词里的一节。
 *
 * 为什么要给模型看讲义：判「练习有没有按要求完成」必须知道**本关教了什么方法**。
 * 只给题目，模型容易用后面章节的写法判学生（例如零基础关用 numpy 判对错），
 * 或者把「没讲过的东西」当成必做项。
 */
function lessonText(level: Level, maxChars: number): string {
  const blocks = level.lesson ?? [];
  if (!blocks.length) {
    return '';
  }
  const parts: string[] = ['【本关讲义（学生手上的教材内容，批改/解答要以它为准）】'];
  for (const b of blocks) {
    if (b.heading) {
      parts.push(`■ ${b.heading}`);
    }
    if (b.text) {
      parts.push(b.text);
    }
    if (b.code) {
      parts.push('```python', b.code, '```');
    }
  }
  let body = parts.join('\n');
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n…（讲义过长，已截断）`;
  }
  return body;
}

export function buildMessages(ctx: PromptContext): Array<{ role: 'system' | 'user'; content: string }> {
  const { level, code, run, strictMode, weakPoints, terminal } = ctx;

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
    (terminal ?? '').trim() ||
      '【学生在集成终端里执行过的命令与输出】\n（没有采集到相关记录。可能是学生没在终端里跑过，也可能是 VS Code 版本过低不支持采集 —— 所以「看不到」不等于「没做」，不要据此扣分。）',
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

// ------------------------------------------------------------------ 参考答案

/**
 * 「让 AI 讲解本关并给出参考答案」的提示词。
 *
 * 与批改不同：这里没有任何学生代码，目标是产出学生能自己对照学习的材料。
 * 输出是 Markdown 而不是 JSON —— 它要直接给学生看，不需要结构化。
 */
const ANSWER_SYSTEM = `你是一位耐心但不说废话的 Python 助教，正在为一位零基础学生写「本关参考答案与讲解」。

输出要求（严格遵守）：
- 全中文，Markdown 格式。
- 按下面的固定结构输出，不要增删大标题。
- 每道练习都要给出：**这道题在考什么** → **解题思路（分步骤）** → **参考代码**。
- 参考代码必须是完整、可直接运行的 Python 代码，放在 \`\`\`python 代码块里，并带必要的中文注释。
- **只能使用本关及之前已经教过的语法**。学生还没学的东西不要用；如果某个更简洁的写法超出当前范围，可以放在「进阶写法」里并注明"以后会学到"。
- 如果下面给了【本关讲义】，**讲解必须与讲义的说法一致**（术语、方法、命名习惯都对齐），
  并且要假设学生只读过这份讲义 —— 讲义里没提的概念，先在正文里补一句解释再用。
- 讲思路时要说清"为什么这么做"，而不只是"抄这段代码"。
- 最后必须给出【易错点】和【怎么自己验证做对了】两节 —— 让学生有能力自查，而不是只会对答案。
- 不要寒暄，不要说"希望对你有帮助"，直接开始。`;

function answerLevelSection(level: Level): string {
  const lines = [
    `【关卡】第 ${level.day} 关 · ${level.title}`,
    `【所属章节】第 ${level.chapter} 章 ${level.chapterTitle}`,
    `【难度】${level.difficulty}/5（星级越高，可用语法范围越宽）`,
    `【今日目标】${level.goal || '（见知识点）'}`,
    '',
    '【知识点简述】',
    ...level.knowledge.map((k, i) => `${i + 1}. ${k}`),
  ];
  const lesson = lessonText(level, 4000);
  if (lesson) {
    lines.push('', lesson);
  }
  if (level.manualExample) {
    lines.push('', '【示例代码（本关已经给过的参考示例）】', '```python', level.manualExample, '```');
  }
  lines.push('', '【本关练习（需要你逐题给出参考答案）】');
  level.exercises.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
  if (level.accept) {
    lines.push('', `【验收标准】${level.accept}`);
  }
  if (level.transfer) {
    lines.push('', `【迁移视角】${level.transfer}`);
  }
  return lines.join('\n');
}

const ANSWER_TEMPLATE = `请按下面这个结构输出：

# 第 N 关参考答案：<关卡标题>

## 一、这一关在练什么
（三五句话说清本关的核心，以及学完应该能做什么）

## 二、逐题思路与参考答案
### 练习 1：<题目简述>
**这道题在考什么**：……
**思路**：
1. ……
2. ……
**参考代码**：
\`\`\`python
# 你的参考实现
\`\`\`

（练习 2、练习 3 同样格式，逐题写完）

## 三、完整可运行版本
（把本关所有练习合并成一个可直接运行的脚本，放在一个代码块里）

## 四、易错点
- ……

## 五、怎么自己验证做对了
- ……`;

export function buildAnswerMessages(
  level: Level
): Array<{ role: 'system' | 'user'; content: string }> {
  const user = [answerLevelSection(level), '', ANSWER_TEMPLATE].join('\n');
  return [
    { role: 'system', content: ANSWER_SYSTEM },
    { role: 'user', content: user },
  ];
}

// ------------------------------------------------------------------ 报错分析

/**
 * 「报错分析」的提示词。
 *
 * 和批改的区别：批改是「打分 + 提建议」，这里是「把一个具体错误讲透」。
 * 所以刻意要求：指出具体行号、给最小改动、教排查方法，
 * 并且**明确禁止重写整份代码** —— 学生需要理解，不是抄。
 */
const ERROR_SYSTEM = `你是一位 Python 助教。学生刚写完的代码运行失败了，正在向你求助。

请帮他**理解**这个错误，而不是替他重写代码。

输出要求（严格遵守）：
- 全中文，Markdown，按下面的固定结构输出，不要增删大标题。
- 第二节必须给出**具体行号和那一行的代码**，不要泛泛而谈。
- 第四节给出**最小改动方案**（只改必要的地方），放在 \`\`\`python 代码块里。
- 第五节最重要：教他"下次自己怎么找到这类错误"，要给出可操作的排查动作。
- **不要把整份代码重写一遍**，也不要顺手点评代码风格 —— 只讲这一个错误。
- 语气直接、具体，不空泛安慰。`;

function errorContext(
  level: Level,
  code: string,
  run: RunResult | null,
  terminal?: string | null
): string {
  const lines = [
    `【关卡】第 ${level.day} 关 · ${level.title}`,
    `【今日目标】${level.goal || '（见知识点）'}`,
    '',
    '【本关知识点】',
    ...level.knowledge.map((k, i) => `${i + 1}. ${k}`),
    '',
    '【学生的完整代码】',
    '```python',
    code,
    '```',
    '',
    '【本地运行结果】',
    `- 退出码：${run?.exitCode ?? '未启动'}`,
    `- 是否超时：${run?.timedOut ? '是' : '否'}`,
    `- 识别到的错误类型：${run?.errorKind ?? '（未识别出类型）'}`,
    '',
    'stdout：',
    '```',
    (run?.stdout ?? '').trim() || '（无输出）',
    '```',
    'stderr（真实 traceback）：',
    '```',
    (run?.stderr ?? '').trim() || '（无错误输出）',
    '```',
  ];
  const term = (terminal ?? '').trim();
  if (term) {
    lines.push(
      '',
      term,
      '（如果学生在终端里跑出来的 traceback 与上面不同，以终端里那条为准 —— 那是他自己真实看到的报错。）'
    );
  }
  return lines.join('\n');
}

const ERROR_TEMPLATE = `请按下面这个结构输出：

# 报错分析：<错误类型>

## 一、这个报错在说什么
（把错误类型和错误信息翻译成大白话，一两句说清）

## 二、错在哪一行
（给出具体行号 + 那一行代码，用 \`\`\`python 代码块引用）

## 三、为什么会这样
（讲清机制：Python 执行到这一步时做了什么、为什么失败。不要只给结论）

## 四、怎么改（最小改动）
\`\`\`python
# 只列出需要改动的那几行
\`\`\`
（说明为什么这样改就好了）

## 五、下次怎么自己找到这类错误
（给出可操作的排查动作，例如"先看 traceback 最后一行""在报错行的上一行 print 出那个变量看看它到底是什么"）

## 六、改完怎么确认
（给出具体的自测方法）`;

export function buildErrorMessages(ctx: {
  level: Level;
  code: string;
  run: RunResult | null;
  terminal?: string | null;
}): Array<{ role: 'system' | 'user'; content: string }> {
  const user = [
    errorContext(ctx.level, ctx.code, ctx.run, ctx.terminal),
    '',
    ERROR_TEMPLATE,
  ].join('\n');
  return [
    { role: 'system', content: ERROR_SYSTEM },
    { role: 'user', content: user },
  ];
}

// ------------------------------------------------------------------ 多种解法

/**
 * 「一题多解」的提示词。
 *
 * 目标是让学生看到「同一个问题可以怎么写」，所以要求解法**思路真的不同**
 * （不是换个变量名），并且每种都要说清优缺点与适用场景，
 * 最后给一句可操作的决策建议（拒绝"各有优劣、视情况而定"这种废话）。
 */
const SOLUTIONS_SYSTEM = `你是一位 Python 助教，正在为同一道练习题整理**多种解法**，帮学生建立"一题多解"的视野。

输出要求（严格遵守）：
- 全中文，Markdown，按下面的固定结构输出，不要增删大标题。
- **至少 3 种解法**，思路必须真的不同（不是换个变量名或换个循环写法）。
- 每种解法都要有：思路、可运行的代码、优点、缺点、什么时候用它。
- **只使用本关及之前教过的语法**。若某种解法用到后面的知识，必须标注
  「（这是后面的内容，先了解即可）」。
- 解法按「从直观到精炼」或「从易到难」排序。
- 最后一节要给出**可操作的决策建议**，不要写"各有优劣、视情况而定"这类废话。
- 不要寒暄，直接开始。`;

const SOLUTIONS_TEMPLATE = `请按下面这个结构输出：

# 第 N 关 多种解法

## 一、题目回顾
（一两句说清要解决什么问题）

## 二、解法总览
| # | 思路一句话 | 用到的语法 | 难度 | 适合什么时候用 |
| --- | --- | --- | --- | --- |
| 1 | … | … | ★ | … |
| 2 | … | … | ★★ | … |
| 3 | … | … | ★★★ | … |

## 三、解法一：<名字>
**思路**：……
**代码**：
\`\`\`python
…
\`\`\`
**优点**：……
**缺点**：……
**什么时候用它**：……

（解法二、解法三按同样格式写，至少写到三种）

## 四、怎么选
（给一句可操作的决策建议：初学者 / 追求可读性 / 追求效率 分别选哪个）

## 五、看起来聪明、其实是坏习惯的写法
- ……`;

export function buildAlternativeSolutionsMessages(
  level: Level
): Array<{ role: 'system' | 'user'; content: string }> {
  const user = [answerLevelSection(level), '', SOLUTIONS_TEMPLATE].join('\n');
  return [
    { role: 'system', content: SOLUTIONS_SYSTEM },
    { role: 'user', content: user },
  ];
}

// ------------------------------------------------------------------ 问答

/**
 * 「随时提问」的提示词。
 *
 * 上下文（当前关卡 + 学生代码）拼进 system，对话历史保持干净，
 * 这样多轮问答里模型始终知道「他现在在做哪一关、手上是什么代码」。
 */
const ASK_SYSTEM = `你是一位 Python 助教，正在回答学生的提问。

回答要求：
- 全中文，Markdown，**简洁**。学生问什么就答什么，不要展开成一篇教程。
- 优先结合他当前这一关的知识点和他写的代码来回答 —— 下面有。
- 代码示例要能直接跑通，放在 \`\`\`python 代码块里。
- 如果问题超出当前关卡范围，先简单回答，再提醒「这是后面会学的，现在知道有这么回事就行」。
- 如果他的问题本身有误解，先纠正误解再回答。
- 不确定的就说「我不确定」，不要编。
- 不要复述他的问题，直接给答案。`;

function askContext(level: Level, code: string, terminal?: string | null): string {
  const lines = [
    `【学生当前所在关卡】第 ${level.day} 关 · ${level.title}`,
    `【今日目标】${level.goal || '（见知识点）'}`,
    `【本关知识点】${level.knowledge.join('；')}`,
  ];
  const trimmed = (code ?? '').trim();
  if (trimmed) {
    lines.push('', '【他目前写的代码】', '```python', trimmed.slice(0, 4000), '```');
  } else {
    lines.push('', '【他目前写的代码】（还没开始写）');
  }
  const term = (terminal ?? '').trim();
  if (term) {
    lines.push(
      '',
      term,
      '（他可能在问终端里出现的现象 —— 回答时结合这些真实命令与输出，不要凭空猜。）'
    );
  }
  return lines.join('\n');
}

export function buildAskMessages(ctx: {
  level: Level | undefined;
  code: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  question: string;
  terminal?: string | null;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const system = ctx.level
    ? `${ASK_SYSTEM}\n\n${askContext(ctx.level, ctx.code, ctx.terminal)}`
    : ASK_SYSTEM;
  return [
    { role: 'system', content: system },
    ...ctx.history,
    { role: 'user', content: ctx.question },
  ];
}
