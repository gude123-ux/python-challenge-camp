/**
 * smoke.ts —— 核心逻辑冒烟测试（不依赖 VS Code 运行）
 *
 * 覆盖：
 *   1. 题库完整性（schema 不变量：ID 唯一、day 递增、每关有知识点与练习、章节全覆盖）
 *   2. 解锁规则（第一关可打，未过关时下一关锁定，过关后解锁）
 *   3. 每日任务派发与完成标记
 *   4. AI 返回解析（含 markdown 包裹、分数钳制、不可运行封顶 45）
 *   5. 本地启发式评分
 *   6. 真实调用本机 Python 跑通/报错两条路径
 *
 * 构建与运行：
 *   node scripts/smoke.build.js && node out-smoke/smoke.js
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Curriculum } from '../src/core/curriculum';
import { ProgressStore } from '../src/core/store';
import { Scheduler } from '../src/core/scheduler';
import { normalizeAiResult, localGrade, extractJson } from '../src/core/grader';
import {
  buildMessages,
  buildErrorMessages,
  buildAlternativeSolutionsMessages,
  buildAskMessages,
} from '../src/ai/prompt';
import { renderMarkdown } from '../src/panels/html';
import { solutionsFilePath } from '../src/util/paths';
import {
  TerminalRecorder,
  formatTerminalContext,
  analyzeTerminalForLevel,
  isPythonRelated,
} from '../src/core/terminal';
import type { TerminalEntry } from '../src/core/terminal';
import { countStudentCodeLines, scanPendingSubmissions } from '../src/core/pending';
import { runFile, runSnippet, checkSyntax } from '../src/core/runner';
import { todayKey } from '../src/util/paths';
import type { GradeResult, Level, RunResult } from '../src/core/types';

const vscodeStub = require('./vscode-stub.js');
const Uri = vscodeStub.Uri;

let pass = 0;
let fail = 0;

function ok(cond: unknown, label: string, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    fail++;
    console.log(`  \u2717 ${label}${extra ? `  ${extra}` : ''}`);
  }
}

function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pycamp-smoke-'));
  vscodeStub.__state.workspaceFolders = [{ uri: Uri.file(workRoot), name: 'smoke', index: 0 }];

  const fakeContext: any = {
    extensionUri: Uri.file(root),
    globalStorageUri: Uri.file(path.join(workRoot, '.global')),
    subscriptions: [],
  };

  // ---------------------------------------------------------- 1. 题库
  section('1. 题库完整性');
  const curriculum = new Curriculum();
  curriculum.load(fakeContext.extensionUri);
  const all = curriculum.all;
  // 只校验「结构不变量」，不写死关卡数量 —— 换掉 data/levels.json 后测试仍应全绿
  ok(all.length >= 5, '关卡数 >= 5（够跑下面的每日任务用例）', `实际 ${all.length}`);
  ok(curriculum.chapters.length >= 1, '章节数 >= 1', `实际 ${curriculum.chapters.length}`);
  ok(new Set(all.map((l) => l.id)).size === all.length, '关卡 ID 唯一');
  ok(all.every((l, i) => i === 0 || l.day > all[i - 1].day), 'day 严格递增');
  const idsInChapters = curriculum.chapters.flatMap((c) => c.levelIds);
  ok(
    idsInChapters.length === all.length && new Set(idsInChapters).size === all.length,
    '章节恰好收录全部关卡且不重复'
  );
  ok(all.every((l) => l.knowledge.length >= 1), '每关都有知识点简述');
  ok(all.every((l) => l.exercises.length >= 1), '每关都有练习题');
  ok(all.every((l) => l.starterCode.includes('本关练习')), '每关的模板都带练习说明');
  const withExample = all.filter((l) => l.manualExample).length;
  ok(withExample >= Math.ceil(all.length / 2), '至少一半关卡带示例代码', `实际 ${withExample}/${all.length}`);
  ok(
    all.every((l) => l.starterCode.length > 60),
    '模板内容非空'
  );
  const chSizes = curriculum.chapters.map((c) => c.levelIds.length);
  ok(chSizes.every((n) => n >= 1), '每章至少 1 关', chSizes.join(','));

  // ---------------------------------------------------------- 2. 解锁规则
  section('2. 解锁规则');
  const store = new ProgressStore(fakeContext);
  await store.load();
  const PASS = 60;
  ok(curriculum.statusOf('L01', store.progress, PASS, false) === 'unlocked', '第 1 关初始可挑战');
  ok(curriculum.statusOf('L02', store.progress, PASS, false) === 'locked', '第 2 关初始锁定');
  ok(curriculum.statusOf('L02', store.progress, PASS, true) === 'unlocked', '开启跳关后第 2 关解锁');
  ok(curriculum.frontier(store.progress, PASS)?.id === 'L01', '学习前线指向第 1 关');

  await store.update((p) => {
    p.levels['L01'] = {
      levelId: 'L01',
      status: 'passed',
      bestScore: 88,
      lastScore: 88,
      attempts: 1,
      history: [],
      weakTags: [],
    };
  });
  ok(curriculum.statusOf('L01', store.progress, PASS, false) === 'passed', 'L01 过关后状态为 passed');
  ok(curriculum.statusOf('L02', store.progress, PASS, false) === 'unlocked', 'L01 过关后 L02 解锁');
  ok(curriculum.statusOf('L03', store.progress, PASS, false) === 'locked', 'L03 仍然锁定');
  ok(curriculum.frontier(store.progress, PASS)?.id === 'L02', '学习前线推进到第 2 关');

  // ---------------------------------------------------------- 3. 每日任务
  section('3. 每日任务派发');
  const scheduler = new Scheduler(store, curriculum);
  const opts = { dailyTaskCount: 3, passScore: PASS, allowSkipLevels: false };
  const assigned = await scheduler.ensureToday(opts, true);
  ok(assigned, '首次派发返回 true');
  const todayLevels = scheduler.todayLevels();
  ok(todayLevels.length === 3, '派发 3 个任务', `实际 ${todayLevels.length}`);
  ok(!todayLevels.some((l) => l.id === 'L01'), '已过关的关卡不再派发');
  ok(todayLevels[0]?.id === 'L02', '第一个任务是学习前线（L02）', todayLevels[0]?.id);
  ok(
    todayLevels.map((l) => l.id).join(',') === 'L02,L03,L04',
    '任务是连续推进的 L02/L03/L04',
    todayLevels.map((l) => l.id).join(',')
  );
  // 今日任务 = 解锁通道
  ok(curriculum.statusOf('L03', store.progress, PASS, false) === 'unlocked', '今日任务里的 L03 视为已解锁');
  ok(curriculum.statusOf('L04', store.progress, PASS, false) === 'unlocked', '今日任务里的 L04 视为已解锁');
  ok(curriculum.statusOf('L05', store.progress, PASS, false) === 'locked', '不在今日任务里的 L05 仍锁定');
  const again = await scheduler.ensureToday(opts, false);
  ok(!again, '同一天重复调用不再重新派发');

  await scheduler.markDoneIfToday('L02');
  ok(scheduler.todayProgress().done === 1, '标记完成后今日进度 = 1');
  await scheduler.markDoneIfToday('L99');
  ok(scheduler.todayProgress().done === 1, '非今日任务不会被标记');

  const reset = await scheduler.resetToday(opts);
  ok(reset.length === 3 && scheduler.todayProgress().done === 0, '重置后任务重新派发且完成数归零');

  // 「派发了但今天没有任务」（例如全部过关）时不应反复重新派发
  await store.update((p) => {
    p.daily = { date: todayKey(), levelIds: [], done: [] };
  });
  const again2 = await scheduler.ensureToday(opts, false);
  ok(!again2, '当天已派发过（即使任务列表为空）不会重复派发');
  ok(scheduler.todayLevels().length === 0, '空任务列表不会凭空生成关卡');

  // 统计
  const stats = curriculum.stats(store.progress, PASS, false);
  ok(stats.total === all.length && stats.passed === 1, '统计：总关卡数与题库一致，已过 1 关', `${stats.total}/${stats.passed}`);
  ok(Math.abs(stats.completionRate - 1 / all.length) < 1e-9, '完成率计算正确');

  // 学习时长
  await store.addStudyTime(90_000);
  await store.addStudyTime(30_000);
  ok(store.progress.stats.totalStudyMs === 120_000, '学习时长累加正确');
  ok(store.recentDays(14).length === 14, '近 14 天序列长度为 14');
  ok(store.progress.stats.streak.current === 1, '连续打卡从 1 开始');

  // ---------------------------------------------------------- 4. AI 结果解析
  section('4. AI 批改结果解析');
  const level: Level = curriculum.get('L02')!;

  const fenced = '```json\n{"score": 77, "runnable": true, "correctness": 80, "quality": 70, "summary": "还行", "strengths": ["a"], "issues": ["b"], "suggestions": ["c"], "weakTags": ["type"], "exerciseChecks": [{"index": 1, "done": true, "comment": "ok"}]}\n```';
  const r1 = normalizeAiResult(fenced, level);
  ok(!!r1 && r1.score === 77, '能解析 ```json 包裹的返回');
  ok(r1?.source === 'ai', '来源标记为 ai');
  ok(r1?.exerciseChecks[0]?.done === true, 'exerciseChecks 解析正确');

  const noisy = '好的，这是评分：\n{"score": 95, "runnable": false, "correctness": 90, "quality": 90, "summary": "s"}\n希望有帮助';
  const r2 = normalizeAiResult(noisy, level);
  ok(!!r2, '能从带前后废话的文本里抠出 JSON');
  ok(r2?.score === 45, '不可运行时总分被钳到 45', `实际 ${r2?.score}`);

  const bad = normalizeAiResult('这不是 JSON', level);
  ok(bad === null, '非法返回返回 null（由调用方回退本地评分）');

  const over = normalizeAiResult('{"score": 130, "runnable": true, "correctness": -5, "quality": 999, "summary": "x"}', level);
  ok(over?.score === 100 && over?.correctness === 0 && over?.quality === 100, '分数越界被钳制到 0-100');
  ok(extractJson('no json here') === null, 'extractJson 对无 JSON 文本返回 null');

  // ---- 回归：提示词要求 suggestions 里给出 markdown 代码块，
  //      于是**合法 JSON 的字符串内部会包含 ```**。
  //      早期解析器用非贪婪正则 /```(?:json)?\s*([\s\S]*?)```/ 剥围栏，
  //      会从第一个 ``` 一路匹配到内层代码块的 ```，只抠出几十字符碎片，
  //      把一份本来完全正确的 JSON 判成「无法解析」。
  const nestedFence = JSON.stringify({
    score: 82,
    runnable: true,
    correctness: 85,
    quality: 78,
    summary: '整体不错',
    strengths: ['结构清晰'],
    issues: ['变量名可以更具体'],
    suggestions: ['可以改成这样：\n```python\nfor i in range(3):\n    print(i)\n```'],
    weakTags: ['range'],
    exerciseChecks: [{ index: 1, done: true, comment: '完成' }],
  });
  const rn = normalizeAiResult(nestedFence, level);
  ok(!!rn && rn.score === 82, 'JSON 字符串内含 markdown 代码块时仍能解析（回归）', String(rn?.score));
  ok(rn?.suggestions.length === 1, '嵌套代码块的建议被完整保留', String(rn?.suggestions.length));

  const wrapped = '```json\n' + nestedFence + '\n```';
  const rw = normalizeAiResult(wrapped, level);
  ok(!!rw && rw.score === 82, '带 ```json 外层围栏 + 内层代码块也能解析（回归）', String(rw?.score));

  const braceInString =
    '{"score": 70, "runnable": true, "correctness": 70, "quality": 70, "summary": "用 f-string 写 {name} 会更好"}';
  const rb = normalizeAiResult(braceInString, level);
  ok(!!rb && rb.score === 70, '字符串内含花括号不会被误判为对象结束');

  const truncated =
    '{"score": 60, "runnable": true, "correctness": 60, "quality": 60, "summary": "被截';
  ok(extractJson(truncated) === null, '被截断的 JSON 返回 null 而不是抛异常');
  ok(
    extractJson('```json\n{"score": 1, "note": "含 ``` 的字符串"}\n```') !== null,
    '围栏内含反引号也能解析'
  );

  // ---- 回归：第二种损坏 —— 模型生成到一半**重新开始一份新草稿**，
  //      两份 JSON 被上游中转拼接在一起。
  //      注意 score 75→70、correctness 60→50，是两份不同的生成。
  //      整体 parse 必须失败（不该硬修），但损坏点之前的字段是完整可用的，
  //      所以要能「逐字段抢救」，避免整个批改退化成本地评分。
  const spliced =
    `{"score":75,"runnable":true,"correctness":60,"quality":80,"summary":"代码成功运行且结构清晰，完成了一部分练习要求。不过练习 1 中将提示文字原样输出，未填入真实的个人信息与日期，请注意替换。","strengths":["代码完全可运行，语法正确，无报错","正确添加了被注释掉的 print 语句以验证注释机制","按格式要求完成了{ "score": 70, "runnable": true, "correctness": 50, "quality": 80, "summary": "代码成功运行且没有报错，并按照要求添加了注释验证。但练习 1 中未能将占位文本替换为具体的个人姓名、实际日期和鼓励话语，显得较为糊弄。", "strengths": [ "代码结构清晰，完全可以无报错运行"`;

  ok(extractJson(spliced) === null, '被拼接的 JSON 整体解析确实失败（该失败就得失败）');

  const rs = normalizeAiResult(spliced, level);
  ok(!!rs, '拼接损坏的返回能被逐字段抢救出来');
  ok(rs?.score === 75, '抢救出第一份草稿的分数 75（不是第二份的 70）', String(rs?.score));
  ok(rs?.runnable === true, '抢救出 runnable');
  ok(rs?.correctness === 60, '抢救出 correctness 60（不是第二份的 50）', String(rs?.correctness));
  ok(rs?.quality === 80, '抢救出 quality');
  ok((rs?.summary ?? '').includes('完成了一部分练习要求'), '抢救出 summary 全文');
  ok(rs?.salvaged === true, '标记 salvaged，UI 会提示可能不完整');
  ok((rs?.issues?.[0] ?? '').includes('结构损坏'), 'issues 里带上了损坏提示');

  // 抢救必须保守：救不出来就老实返回 null，绝不能凭空编一个分数
  ok(extractJson('这不是 JSON，也没有花括号') === null, '没有对象可抢救时返回 null');
  ok(normalizeAiResult('随便一段话', level) === null, '毫无结构的文本不会被抢救成结果');
  ok(extractJson('{"score":') === null, '只有一个残破 key 时不抢救');
  ok(normalizeAiResult('{"score": 50, "runnable": true}', level)?.salvaged === undefined, '正常返回不会被标记为 salvaged');

  // ---- 回归：第三种损坏 —— 模型**忘了转义字符串内部的双引号**。
  //      它想引用一条命令，写成了 …运行了`python -c "print(...)"`来观察…
  //      内层引号没转义 → 字符串提前结束 → 整份 JSON 报废 → 整条批改退化成"本地评分"。
  const unescaped = `{
  "score": 85,
  "runnable": true,
  "correctness": 90,
  "quality": 75,
  "summary": "代码能无报错运行，成功完成了第1关的核心目标。",
  "strengths": ["代码完全可运行，无语法错误", "通过\`# print(...)\`验证了练习2"],
  "issues": [
    "练习3未完成：学生未在代码或提交记录中体现运行了\`python -c "print(2026 - 2000, 10 / 4, 10 // 4)"\`来观察 \`/\` 和 \`//\` 的区别",
    "练习2只是简单注释，没有体现'取消注释后重新运行'的验证动作"
  ],
  "suggestions": ["建议在终端执行 \`python -c 'print(2026 - 2000)'\` 并把结果贴进注释"],
  "weakTags": ["注释", "整除"],
  "exerciseChecks": [
    { "index": 1, "done": true, "comment": "完成" },
    { "index": 3, "done": false, "comment": "未完成" }
  ]
}`;

  ok(extractJson(unescaped) !== null, '未转义双引号的返回能被修复（回归）');
  const ru = normalizeAiResult(unescaped, level);
  ok(ru?.score === 85, '修复后拿到完整分数 85', String(ru?.score));
  ok(ru?.issues.length === 2, 'issues 两条都保住（不是只剩一条警告）', String(ru?.issues.length));
  ok(
    (ru?.issues[0] ?? '').includes('print(2026 - 2000, 10 / 4, 10 // 4)'),
    '被引号切断的那条 issue 内容被原样重建'
  );
  ok(
    ru?.suggestions.length === 1 && ru?.exerciseChecks.length === 2,
    'suggestions / exerciseChecks 完整保留',
    `${ru?.suggestions.length}/${ru?.exerciseChecks.length}`
  );
  ok(ru?.salvaged === undefined, '完整修复后不标记 salvaged（这是正常解析，不该给用户报警）');

  // ---- 引号修复必须是**恒等变换**：合法 JSON 一个字符都不能改。
  //      这是这次改动最大的风险点，必须逐条钉死。
  ok(extractJson('{"a":"b","c":["d","e"]}')?.a === 'b', '合法 JSON 不受影响');
  ok(extractJson('{"a":"say \\"hi\\""}')?.a === 'say "hi"', '已正确转义的引号保持原样');
  ok(extractJson('{"a":"x:y"}')?.a === 'x:y', '字符串内的冒号不被误判为 key 分隔');
  ok(extractJson('{"a":"b, c"}')?.a === 'b, c', '字符串内的逗号不被误判为分隔符');
  ok(extractJson('{"a":"尾部","b":1}')?.b === 1, '字符串紧跟逗号时正确结束');
  ok(extractJson('{"a":"尾]","b":1}')?.b === 1, '字符串内含右方括号不受影响');
  ok(extractJson('{"a":{"b":["c"]}}')?.a?.b?.[0] === 'c', '嵌套结构不受影响');
  ok(extractJson('{"a":"","b":""}')?.b === '', '空字符串不受影响');
  ok(extractJson('{"a":"结尾"}')?.a === '结尾', '字符串紧跟右花括号时正确结束');
  ok(
    extractJson('{"a":"多行\\n换行","b":2}')?.b === 2,
    '含转义换行的字符串不受影响'
  );

  // ---- 提示词加固：确认转义规则真的进了 SYSTEM。
  //      这段是在模板字符串里写的，反引号和反斜杠极易写错 —— 必须实测渲染结果，
  //      否则"加了规则"只是自我安慰（模型看到的可能是被吃掉转义的残句）。
  const probeMsgs = buildMessages({
    level,
    code: 'print(1)',
    run: null,
    strictMode: false,
    weakPoints: [],
  });
  const sys = probeMsgs[0].content;
  ok(sys.includes('字符串值内部不要出现英文双引号'), '提示词含 JSON 转义硬要求');
  ok(sys.includes('反引号'), '提示词引导模型改用反引号引用命令');
  ok(sys.includes('\\n'), '提示词里的换行示例渲染为字面 \\n（不是真换行）');
  ok(sys.includes('\\"'), '提示词里的转义示例渲染为字面 \\"');
  ok(!sys.includes('${'), '提示词里没有未展开的模板占位符');

  // ---------------------------------------------------------- 5. 本地评分
  section('5. 本地启发式评分');
  const goodRun: RunResult = {
    ok: true, exitCode: 0, stdout: 'hello\n', stderr: '',
    timedOut: false, durationMs: 12, pythonPath: 'python',
  };
  const g1 = localGrade(level, 'a = 1\nb = 2\nprint(a + b)\n# 注释一\n# 注释二\nprint("done")\n', goodRun);
  ok(g1.score > 60, '写得像样的代码本地分 > 60', `实际 ${g1.score}`);
  ok(g1.source === 'local', '来源标记为 local');
  ok(g1.runnable === true, '可运行标记正确');

  const badRun: RunResult = {
    ok: false, exitCode: 1, stdout: '', stderr: 'NameError: name x is not defined',
    timedOut: false, durationMs: 30, pythonPath: 'python', errorKind: 'NameError',
  };
  const g2 = localGrade(level, 'print(x)\n', badRun);
  ok(g2.score < 60, '报错代码本地分 < 60', `实际 ${g2.score}`);
  ok(g2.weakTags.includes('NameError'), '薄弱标签记录了错误类型');
  ok(g2.issues.length > 0, '给出了问题清单');

  const emptyRun: RunResult = {
    ok: false, exitCode: 1, stdout: '', stderr: 'SyntaxError: invalid syntax',
    timedOut: false, durationMs: 5, pythonPath: 'python', errorKind: 'SyntaxError',
  };
  const g3 = localGrade(level, '# 只有注释\n', emptyRun);
  ok(g3.score <= 20, '空代码分数极低', `实际 ${g3.score}`);

  // ---------------------------------------------------------- 6. 真实运行 Python
  section('6. 本地 Python 运行（真实调用）');
  const pythonPath = process.env.PYCAMP_PYTHON || 'python';
  const workDir = path.join(workRoot, 'python-camp');
  fs.mkdirSync(workDir, { recursive: true });

  const goodFile = path.join(workDir, 'ok.py');
  fs.writeFileSync(goodFile, 'import sys\nprint("中文输出正常")\nprint(1 + 1)\n', 'utf8');
  const run1 = await runFile(goodFile, { pythonPath, timeoutSec: 20 });
  if (run1.noInterpreter) {
    console.log(`  ! 未找到 Python（${pythonPath}），跳过运行测试。可用 PYCAMP_PYTHON 指定解释器。`);
  } else {
    ok(run1.ok, '正常脚本运行成功', run1.stderr.slice(0, 120));
    ok(run1.stdout.includes('中文输出正常'), 'stdout 中文编码正确', JSON.stringify(run1.stdout.slice(0, 60)));
    ok(run1.stdout.includes('2'), '计算结果出现在 stdout');

    const badFile = path.join(workDir, 'bad.py');
    fs.writeFileSync(badFile, 'print(undefined_var)\n', 'utf8');
    const run2 = await runFile(badFile, { pythonPath, timeoutSec: 20 });
    ok(!run2.ok, '报错脚本运行失败');
    ok(run2.errorKind === 'NameError', '错误类型识别为 NameError', String(run2.errorKind));
    ok(run2.exitCode === 1, '退出码为 1');

    const synFile = path.join(workDir, 'syn.py');
    fs.writeFileSync(synFile, 'def f(:\n    pass\n', 'utf8');
    const run3 = await runFile(synFile, { pythonPath, timeoutSec: 20 });
    ok(run3.errorKind === 'SyntaxError', '语法错误识别为 SyntaxError', String(run3.errorKind));

    const loopFile = path.join(workDir, 'loop.py');
    fs.writeFileSync(loopFile, 'while True:\n    pass\n', 'utf8');
    const run4 = await runFile(loopFile, { pythonPath, timeoutSec: 3 });
    ok(run4.timedOut, '死循环被超时中断');
    ok(!run4.ok, '超时的运行不算成功');

    const chk = await checkSyntax('x = 1\nprint(x)\n', fakeContext, { pythonPath, timeoutSec: 20 });
    ok(chk.ok, '语法检查：正确代码通过');
    const chk2 = await checkSyntax('x = \n', fakeContext, { pythonPath, timeoutSec: 20 });
    ok(!chk2.ok, '语法检查：错误代码被拦下');

    const snip = await runSnippet('print("snippet ok")', fakeContext, { pythonPath, timeoutSec: 20 });
    ok(snip.ok && snip.stdout.includes('snippet ok'), '代码片段运行正常');
    const tmpLeft = fs.existsSync(path.join(workRoot, '.pythoncamp', 'tmp'));
    const leftovers = tmpLeft
      ? fs.readdirSync(path.join(workRoot, '.pythoncamp', 'tmp')).filter((f) => f.endsWith('.py'))
      : [];
    ok(leftovers.length === 0, '临时文件已清理', leftovers.join(','));
  }

  // ---------------------------------------------------------- 7. 持久化
  section('7. 进度持久化');
  const progressFile = path.join(workRoot, '.pythoncamp', 'progress.json');
  ok(fs.existsSync(progressFile), 'progress.json 已写入工作区');
  const saved = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  ok(saved.schemaVersion === 1, 'schemaVersion = 1');
  ok(saved.levels.L01.bestScore === 88, '关卡成绩已持久化');
  ok(saved.stats.totalStudyMs === 120_000, '学习时长已持久化');

  const store2 = new ProgressStore(fakeContext);
  await store2.load();
  ok(store2.progress.levels.L01.bestScore === 88, '重新载入后数据仍在');
  ok(store2.progress.stats.totalStudyMs === 120_000, '重新载入后时长仍在');

  // ★ 进度自愈：过线分数被外部因素调高后，历史过关记录不该「倒退」
  //   （用户实测：过了关，面板却显示未过关 —— 另一个同名插件把
  //    pythonCamp.passScore 的默认值从 60 顶成了 80）
  await store2.update((p) => {
    p.levels.L01.status = 'unlocked';
    delete p.levels.L01.passedAt;
    p.daily = { date: todayKey(), levelIds: ['L01', 'L02'], done: [] };
  });
  const healed = await store2.reconcile(60);
  ok(healed === true, 'reconcile 检测到需要修正的进度');
  ok(store2.progress.levels.L01.status === 'passed', '★ 88 分（过线 60）被修正回「已过关」');
  ok(store2.progress.levels.L01.passedAt !== undefined, 'passedAt 被补回');
  ok(store2.progress.daily.done.includes('L01'), '今日任务的完成标记被补回');
  ok((await store2.reconcile(60)) === false, '没有需要修正的内容时返回 false（可反复调用）');
  ok(store2.progress.daily.done.length === 1, '只补回真正过关的那一关');

  // 损坏文件恢复
  fs.writeFileSync(progressFile, '{ 这不是合法 JSON', 'utf8');
  const store3 = new ProgressStore(fakeContext);
  await store3.load();
  ok(store3.progress.levels.L01 === undefined, '损坏文件被重建为空进度');
  const baks = fs.readdirSync(path.dirname(progressFile)).filter((f) => f.includes('corrupt'));
  ok(baks.length === 1, '损坏文件已备份', baks.join(','));

  // ---------------------------------------------------------- 8. 讲解类任务
  section('8. 讲解类任务（报错分析 / 多种解法 / 问答）');

  const errRun: RunResult = {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: "NameError: name 'x' is not defined",
    timedOut: false,
    durationMs: 20,
    pythonPath: 'python',
    errorKind: 'NameError',
  };
  const errMsgs = buildErrorMessages({ level, code: 'print(x)\n', run: errRun });
  ok(errMsgs.length === 2 && errMsgs[0].role === 'system', '报错分析：system + user 两条消息');
  ok(errMsgs[1].content.includes('NameError'), '报错分析：真实 traceback 进了提示词');
  ok(errMsgs[1].content.includes('print(x)'), '报错分析：学生代码进了提示词');
  ok(errMsgs[1].content.includes('错在哪一行'), '报错分析：要求指出具体行号');
  ok(errMsgs[1].content.includes('最小改动'), '报错分析：要求给最小改动方案');
  ok(errMsgs[0].content.includes('不要把整份代码重写'), '报错分析：禁止重写整份代码');

  const solMsgs = buildAlternativeSolutionsMessages(level);
  ok(solMsgs[0].content.includes('至少 3 种解法'), '多种解法：要求至少 3 种');
  ok(solMsgs[1].content.includes('什么时候用它'), '多种解法：要求说明适用场景');
  ok(solMsgs[1].content.includes('题目回顾'), '多种解法：带题目回顾');
  ok(solMsgs[0].content.includes('思路必须真的不同'), '多种解法：要求思路真的不同');

  const askMsgs = buildAskMessages({
    level,
    code: 'print(1)',
    history: [
      { role: 'user', content: '上一问' },
      { role: 'assistant', content: '上一答' },
    ],
    question: '这行为什么报错？',
  });
  ok(askMsgs.length === 4, '问答：system + 历史 2 条 + 当前问题', String(askMsgs.length));
  ok(askMsgs[0].content.includes(`第 ${level.day} 关`), '问答：上下文带上了当前关卡');
  ok(askMsgs[0].content.includes('print(1)'), '问答：上下文带上了学生代码');
  ok(askMsgs[3].content === '这行为什么报错？', '问答：当前问题放在最后一条');
  ok(!askMsgs[0].content.includes('上一答'), '问答：历史不进 system（保持干净）');

  const askNoLevel = buildAskMessages({ level: undefined, code: '', history: [], question: 'x' });
  ok(askNoLevel.length === 2, '问答：没有关卡时也能构造（不崩）');

  const solPath = solutionsFilePath(fakeContext, level);
  ok(
    solPath.includes('参考答案') && solPath.endsWith('多种解法.md'),
    '多种解法文件路径约定正确',
    solPath
  );

  // ---------------------------------------------------------- 9. Markdown 渲染
  section('9. Markdown 渲染（要注入 webview，必须转义）');

  const md1 = renderMarkdown('# 标题\n\n正文 **粗体** 和 `代码`\n\n- 一\n- 二\n\n1. 甲\n2. 乙');
  ok(md1.includes('<h3>标题</h3>'), '标题渲染（降两级，避免与面板标题打架）');
  ok(md1.includes('<b>粗体</b>'), '粗体渲染');
  ok(md1.includes('<code>代码</code>'), '行内代码渲染');
  ok(md1.includes('<ul>') && md1.includes('<li>一</li>'), '无序列表渲染');
  ok(md1.includes('<ol>') && md1.includes('<li>甲</li>'), '有序列表渲染');

  const md2 = renderMarkdown('```python\nprint("hi")\n```');
  ok(md2.includes('<pre class="code"'), '围栏代码块渲染');
  ok(md2.includes('print(&quot;hi&quot;)'), '代码块内容被转义');

  // ★ 安全：模型输出里的 HTML 必须被转义，绝不能进 webview 执行
  const evil = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">');
  ok(!evil.includes('<script>') && !evil.includes('<img'), '★ 模型输出里的 HTML 标签被转义');
  ok(evil.includes('&lt;script&gt;'), '★ 转义结果可读（&lt;script&gt;）');

  const evilCode = renderMarkdown('```\n</script><script>alert(3)</script>\n```');
  ok(!evilCode.includes('<script>'), '★ 代码块里的 </script> 被转义（防止提前闭合 script 标签）');

  // 未闭合的围栏不能让内容凭空消失
  const unclosed = renderMarkdown('```python\nprint(1)');
  ok(unclosed.includes('print(1)'), '未闭合的代码围栏也能渲染出内容');

  // ---------------------------------------------------------- 10. 终端证据
  // 背景（用户实测反馈）：课程材料里有些练习要求「在终端敲一条命令看输出」，
  // 这类证据不在 .py 文件里。早期版本只看文件与本地运行结果，
  // 于是 AI 判「练习未完成」并扣分 —— 学生明明做过了。
  section('10. 集成终端证据');
  const termEntries: TerminalEntry[] = [
    { terminal: 'pwsh', command: 'python 第02关_变量与数据类型.py', output: '姓名: 张三\n年龄: 20\n', at: 1 },
    { terminal: 'pwsh', command: 'python -c "print(2026 - 2000, 10 / 4, 10 // 4)"', output: '26 2.5 2\n', at: 2 },
    { terminal: 'pwsh', command: 'git push origin master', output: 'Everything up-to-date\n', at: 3 },
  ];
  ok(isPythonRelated(termEntries[0]) && isPythonRelated(termEntries[1]), '识别出 python 相关命令');
  ok(!isPythonRelated(termEntries[2]), '非 python 命令（git push）不进入证据');

  const termCtx = formatTerminalContext(termEntries);
  ok(termCtx.includes('python 第02关'), '终端上下文含关卡文件的运行命令');
  ok(termCtx.includes('26 2.5 2'), '终端上下文含命令输出');
  ok(!termCtx.includes('git push'), '★ 终端上下文不含无关命令（隐私）');

  const ev = analyzeTerminalForLevel(termEntries, level);
  ok(ev.ran && ev.clean && !ev.failed, '识别出本关在终端里跑通过');
  const evOther = analyzeTerminalForLevel(termEntries, curriculum.get('L05')!);
  ok(!evOther.ran, '其它关卡不会被误判成"跑过"');
  const evBad = analyzeTerminalForLevel(
    [{ terminal: 't', command: 'python 第02关_x.py', output: 'Traceback (most recent call last):\nNameError: x', at: 4 }],
    level
  );
  ok(evBad.ran && evBad.failed && !evBad.clean, '终端里的 traceback 被当作失败证据');

  // 本地评分必须用上终端证据（否则「插件跑不了但学生自己跑通了」会被判不可运行）
  const termCode = 'a = 1\nprint(a)\n# 注释一\n# 注释二\n';
  const gTerm = localGrade(level, termCode, null, termCtx);
  ok(gTerm.runnable === true, '本地没跑过、但终端跑过 → 判为可运行', String(gTerm.runnable));
  ok(gTerm.terminalUsed === true, '结果标记了「参考了终端记录」');
  const gNoTerm = localGrade(level, termCode, null);
  ok(
    gNoTerm.runnable === false && gNoTerm.score < gTerm.score,
    '没有终端证据时不给这个分',
    `${gNoTerm.score} < ${gTerm.score}`
  );

  // 提示词：终端记录要真的进去，且口径要写清「证据不足 ≠ 做错」
  const termMsgs = buildMessages({
    level,
    code: 'print(1)',
    run: null,
    strictMode: false,
    weakPoints: [],
    terminal: termCtx,
  });
  ok(termMsgs[1].content.includes('python -c'), '批改提示词带上了终端里的命令');
  ok(termMsgs[0].content.includes('证据不足 ≠ 做错了'), '批改提示词含「证据不足不等于做错」口径');
  ok(termMsgs[0].content.includes('终端'), '批改提示词要求结合终端证据');
  const noTermMsgs = buildMessages({ level, code: 'print(1)', run: null, strictMode: false, weakPoints: [] });
  ok(
    noTermMsgs[1].content.includes('不等于「没做」'),
    '没有终端记录时明确说明「看不到不等于没做」'
  );
  const errTerm = buildErrorMessages({ level, code: 'print(x)', run: errRun, terminal: termCtx });
  ok(errTerm[1].content.includes('python 第02关'), '报错分析带上了终端记录');
  const askTerm = buildAskMessages({
    level,
    code: 'print(1)',
    history: [],
    question: 'q',
    terminal: termCtx,
  });
  ok(askTerm[0].content.includes('python -c'), '问答上下文带上了终端记录');

  // 低版本 VS Code 没有 Shell Integration API 时必须静默降级，不能抛异常
  const rec = new TerminalRecorder();
  let recThrew = false;
  try {
    rec.start();
  } catch {
    recThrew = true;
  }
  ok(!recThrew, '没有 Shell Integration API 时 start() 不抛异常（优雅降级）');
  ok(rec.context() === '', '降级状态下终端上下文为空串');
  ok(rec.evidenceFor(level).ran === false, '降级状态下不会伪造运行证据');
  rec.dispose();

  // ---------------------------------------------------------- 11. 写了但没提交
  // 背景（用户实测）：学生写了代码但忘了点「提交并批改」，
  // 面板上还是「可挑战」，他就觉得「我明明做了，进度却没了」。
  section('11. 「写了代码但没提交」的检测');

  ok(countStudentCodeLines('# 全是注释\n\n# 模板说明\n') === 0, '模板（全是注释）算 0 行有效代码');
  ok(countStudentCodeLines('a = 1\n\nprint(a)\n# 注释\n') === 2, '剥掉注释与空行后计数正确');
  ok(countStudentCodeLines('') === 0, '空内容算 0 行');

  const fakeIo = (files: Record<string, string>) => ({
    readdir: async () => Object.keys(files),
    stat: async () => ({ mtimeMs: Date.now() }),
    readFile: async (p: string) => {
      const name = path.basename(p);
      if (!(name in files)) {
        throw new Error('ENOENT');
      }
      return files[name];
    },
  });

  const probeProgress = {
    schemaVersion: 1,
    student: { name: '', cohort: '' },
    createdAt: '',
    updatedAt: '',
    daily: { date: '', levelIds: [], done: [] },
    levels: {
      L01: {
        levelId: 'L01',
        status: 'passed',
        bestScore: 88,
        lastScore: 88,
        attempts: 1,
        history: [],
        weakTags: [],
      },
    },
    stats: { totalStudyMs: 0, dailyMs: {}, activeDays: [], streak: { current: 0, best: 0, lastDate: '' } },
    weakPoints: {},
    meta: {},
  } as any;

  const probeFiles = {
    '第01关_x.py': 'b = 2\nprint(b)\n', // 已提交过 → 不该再提示
    '第02关_x.py': 'a = 1\nprint(a)\n', // 写了没提交 → 应被挑出
    '第03关_x.py': '# 只有模板注释\n#\n', // 还没动手 → 不算
    '第99关_不存在.py': 'x = 1\ny = 2\n', // 题库里没有第 99 关
    'notes.txt': 'whatever',
  };
  const pend = await scanPendingSubmissions(curriculum.all, '/tmp/whatever', probeProgress, fakeIo(probeFiles));
  ok(
    pend.length === 1 && pend[0].levelId === 'L02',
    '只挑出「写了代码且从未提交」的关卡',
    JSON.stringify(pend.map((p) => p.levelId))
  );
  ok(pend[0]?.codeLines === 2, '带上有效代码行数（面板要显示「已写 N 行」）', String(pend[0]?.codeLines));
  ok(!!pend[0]?.mtime, '带上文件修改时间');

  const pendEmpty = await scanPendingSubmissions(curriculum.all, '/tmp/does-not-exist', probeProgress, {
    readdir: async () => {
      throw new Error('ENOENT');
    },
    stat: async () => ({ mtimeMs: 0 }),
    readFile: async () => '',
  });
  ok(pendEmpty.length === 0, '目录不存在时返回空数组（不抛异常）');

  const pendUnreadable = await scanPendingSubmissions(
    curriculum.all,
    '/tmp/x',
    probeProgress,
    {
      readdir: async () => ['第02关_x.py', '第04关_y.py'],
      stat: async () => ({ mtimeMs: 0 }),
      readFile: async (p: string) => {
        if (p.includes('第02关')) {
          throw new Error('EACCES');
        }
        return 'c = 3\nprint(c)\n';
      },
    }
  );
  ok(
    pendUnreadable.length === 1 && pendUnreadable[0].levelId === 'L04',
    '单个文件读不到时跳过它，不影响其它关卡',
    JSON.stringify(pendUnreadable.map((p) => p.levelId))
  );

  // ---------------------------------------------------------- 收尾
  // 清理临时工作区，别在 TEMP 里堆垃圾
  try {
    fs.rmSync(workRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(46));
  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('\n冒烟测试异常：', e);
  process.exitCode = 1;
});
