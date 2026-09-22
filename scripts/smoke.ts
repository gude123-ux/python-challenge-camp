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
  // 注意：这里只校验「结构不变量」，不写死关卡数量 ——
  // 换掉 data/levels.json 里的内容后，测试仍然应该全绿。
  section('1. 题库完整性');
  const curriculum = new Curriculum();
  curriculum.load(fakeContext.extensionUri);
  const all = curriculum.all;
  ok(all.length >= 5, '关卡数 >= 5（够跑下面的每日任务用例）', `实际 ${all.length}`);
  ok(curriculum.chapters.length >= 1, '章节数 >= 1', `实际 ${curriculum.chapters.length}`);
  ok(all.every((l) => l.knowledge.length >= 1), '每关都有知识点简述');
  ok(all.every((l) => l.exercises.length >= 1), '每关都有练习题');
  ok(all.every((l) => l.starterCode.includes('本关练习')), '每关的模板都带练习说明');
  const withExample = all.filter((l) => l.manualExample).length;
  ok(withExample >= Math.ceil(all.length / 2), '至少一半关卡带示例代码', `实际 ${withExample}/${all.length}`);
  ok(
    all.every((l) => l.starterCode.length > 60),
    '模板内容非空'
  );
  ok(new Set(all.map((l) => l.id)).size === all.length, '关卡 ID 唯一');
  ok(
    all.every((l, i) => i === 0 || l.day > all[i - 1].day),
    '关卡按 day 严格递增'
  );
  ok(
    all.every((l) => l.title.length > 0 && l.chapterTitle.length > 0),
    '每关都有标题与章节名'
  );
  const idsInChapters = curriculum.chapters.flatMap((c) => c.levelIds);
  ok(
    idsInChapters.length === all.length && new Set(idsInChapters).size === all.length,
    '章节恰好收录全部关卡且不重复',
    `章节收录 ${idsInChapters.length} / 题库 ${all.length}`
  );
  ok(
    curriculum.chapters.every((c) => c.levelIds.length >= 1),
    '每章至少 1 关'
  );
  ok(
    all.every((l) => curriculum.levelsOfChapter(l.chapter).some((x) => x.id === l.id)),
    '每关都能在它所属章节里找到'
  );

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
  ok(stats.total === all.length && stats.passed === 1, `统计：总 ${all.length} 关，已过 1 关`, `${stats.total}/${stats.passed}`);
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

  // 损坏文件恢复
  fs.writeFileSync(progressFile, '{ 这不是合法 JSON', 'utf8');
  const store3 = new ProgressStore(fakeContext);
  await store3.load();
  ok(store3.progress.levels.L01 === undefined, '损坏文件被重建为空进度');
  const baks = fs.readdirSync(path.dirname(progressFile)).filter((f) => f.includes('corrupt'));
  ok(baks.length === 1, '损坏文件已备份', baks.join(','));

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
