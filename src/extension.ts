/**
 * extension.ts —— 插件入口：命令注册与流程编排
 *
 * 数据流：
 *   activate → 载入题库与进度 → 派发今日任务 → 注册侧边栏 / 命令 / 状态栏
 *   提交批改 → 读当前关卡文件 → 本地运行 → AI 判分 → 落库 → 刷新 UI
 *
 * 隐私：只有「提交批改」时才会把当前这一份代码片段发给你配置的模型服务；
 *      插件不会扫描、上传工作区里的其他文件。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';

import { ProgressStore } from './core/store';
import { Curriculum } from './core/curriculum';
import { Scheduler } from './core/scheduler';
import { StudyTimer } from './core/timer';
import { runFile } from './core/runner';
import { gradeCode, promptAiSetup } from './core/grader';
import { readConfig, aiReady } from './core/config';
import type { GradeResult, Level, RunResult, WebviewMessage } from './core/types';

import { SidebarProvider } from './panels/sidebar';
import { LevelPanel } from './panels/levelPanel';
import { ViewModelBuilder } from './panels/viewModel';
import { levelFileUri, reportFilePath, humanDuration, todayKey } from './util/paths';

let store: ProgressStore;
let curriculum: Curriculum;
let scheduler: Scheduler;
let timer: StudyTimer;
let vmb: ViewModelBuilder;
let sidebar: SidebarProvider;
let statusBar: vscode.StatusBarItem;

/** 当前正在操作的关卡 */
let currentLevelId: string | undefined;
/** 最近一次批改结果（用于详情页展示） */
let lastGrade: GradeResult | null = null;
let lastRun: RunResult | null = null;

const LEVEL_FILE_RE = /第(\d+)关/;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  store = new ProgressStore(context);
  curriculum = new Curriculum();
  curriculum.load(context.extensionUri);
  await store.load();

  const cfg = readConfig();
  scheduler = new Scheduler(store, curriculum);
  vmb = new ViewModelBuilder(store, curriculum, scheduler);

  // 每日任务派发
  const assigned = await scheduler.ensureToday({
    dailyTaskCount: cfg.dailyTaskCount,
    passScore: cfg.passScore,
    allowSkipLevels: cfg.allowSkipLevels,
  });

  // 学习时长
  timer = new StudyTimer(store, () => readConfig().trackStudyTime);
  timer.start();

  // 侧边栏
  sidebar = new SidebarProvider(
    context.extensionUri,
    (msg) => handleWebviewMessage(msg, context),
    () => vmb.buildSidebar(readConfig()),
    (visible) => {
      timer.panelVisible = visible;
    }
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 状态栏
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = 'pythonCamp.openPanel';
  context.subscriptions.push(statusBar);
  refreshStatusBar();

  registerCommands(context);

  // 进度变化时刷新所有 UI
  context.subscriptions.push(
    store.onDidChange(() => {
      sidebar.refresh();
      refreshStatusBar();
    })
  );

  // 跨零点自动派发新一天的今日任务（VS Code 长期开着也不会停在昨天的任务上）
  const dayWatch = setInterval(() => {
    void (async () => {
      const c = readConfig();
      const changed = await scheduler.ensureToday({
        dailyTaskCount: c.dailyTaskCount,
        passScore: c.passScore,
        allowSkipLevels: c.allowSkipLevels,
      });
      if (changed) {
        sidebar.refresh();
        void vscode.window.showInformationMessage('新的一天，今日任务已重新派发。');
      }
    })();
  }, 5 * 60 * 1000);
  // unref：这个巡检定时器不该阻止宿主进程退出（也让加载测试能正常结束）
  dayWatch.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(dayWatch) });

  // 打开 Python 文件时，尝试识别属于哪一关
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === 'python') {
        const lv = resolveLevelForDocument(editor.document);
        if (lv) {
          currentLevelId = lv.id;
          void store.update((p) => {
            p.meta.lastLevelId = lv.id;
          });
        }
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      void timer.dispose();
    },
  });

  if (assigned) {
    const t = scheduler.todayProgress();
    void vscode.window
      .showInformationMessage(
        `今日任务已派发：${t.total} 关。`,
        '开始今日任务',
        '打开进度面板'
      )
      .then((pick) => {
        if (pick === '开始今日任务') {
          void vscode.commands.executeCommand('pythonCamp.startToday');
        } else if (pick === '打开进度面板') {
          void vscode.commands.executeCommand('pythonCamp.openPanel');
        }
      });
  }
}

export async function deactivate(): Promise<void> {
  await timer?.dispose();
}

// ------------------------------------------------------------------ 命令

function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('pythonCamp.openPanel', async () => {
    await sidebar.reveal();
    sidebar.refresh();
  });

  reg('pythonCamp.startToday', async () => {
    const cfg = readConfig();
    await scheduler.ensureToday(
      {
        dailyTaskCount: cfg.dailyTaskCount,
        passScore: cfg.passScore,
        allowSkipLevels: cfg.allowSkipLevels,
      },
      false
    );
    const levels = scheduler.todayLevels();
    if (!levels.length) {
      void vscode.window.showInformationMessage('全部关卡都已过关，没有新任务了。可以重刷错题巩固。');
      return;
    }
    await sidebar.reveal();
    sidebar.refresh();
    const first = levels.find((l) => !store.progress.daily.done.includes(l.id)) ?? levels[0];
    await openLevel(first, context);
  });

  reg('pythonCamp.pickLevel', async () => {
    const cfg = readConfig();
    const picked = await pickLevelQuick(cfg.passScore, cfg.allowSkipLevels);
    if (picked) {
      await openLevel(picked, context);
    }
  });

  reg('pythonCamp.startLevel', async () => {
    const lv = currentLevelId ? curriculum.get(currentLevelId) : undefined;
    if (lv) {
      await openLevel(lv, context);
    }
  });

  reg('pythonCamp.submitAndGrade', async () => {
    const target = resolveTargetFromEditor();
    if (!target) {
      return;
    }
    await submitLevel(target.level, context, target.document);
  });

  reg('pythonCamp.runCurrentFile', async () => {
    const target = resolveTargetFromEditor();
    if (!target) {
      return;
    }
    await runLevel(target.level, context, target.document);
  });

  reg('pythonCamp.retryWrong', async () => {
    const cfg = readConfig();
    const levels = await scheduler.resetToday({
      dailyTaskCount: cfg.dailyTaskCount,
      passScore: cfg.passScore,
      allowSkipLevels: cfg.allowSkipLevels,
    });
    await sidebar.reveal();
    sidebar.refresh();
    if (levels.length) {
      void vscode.window.showInformationMessage(
        `已按错题重排今日任务：${levels.map((l) => `第${l.day}关`).join('、')}`
      );
    } else {
      void vscode.window.showInformationMessage('还没有错题，今日任务保持不变。');
    }
  });

  reg('pythonCamp.resetToday', async () => {
    const cfg = readConfig();
    await scheduler.ensureToday(
      {
        dailyTaskCount: cfg.dailyTaskCount,
        passScore: cfg.passScore,
        allowSkipLevels: cfg.allowSkipLevels,
      },
      true
    );
    sidebar.refresh();
    void vscode.window.showInformationMessage('今日任务已重置。');
  });

  reg('pythonCamp.exportReport', async () => {
    await exportReport(context);
  });

  reg('pythonCamp.openSettings', async () => {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:zhongou-aviation.python-challenge-camp'
    );
  });

  reg('pythonCamp.resetAll', async () => {
    const pick = await vscode.window.showWarningMessage(
      '确定要清空全部闯关进度吗？此操作不可撤销（会删除 .pythoncamp/progress.json 的内容）。',
      { modal: true },
      '确认清空'
    );
    if (pick !== '确认清空') {
      return;
    }
    await store.resetAll();
    const cfg = readConfig();
    await scheduler.ensureToday(
      {
        dailyTaskCount: cfg.dailyTaskCount,
        passScore: cfg.passScore,
        allowSkipLevels: cfg.allowSkipLevels,
      },
      true
    );
    sidebar.refresh();
    void vscode.window.showInformationMessage('进度已重置。');
  });
}

// ------------------------------------------------------------------ 关卡操作

/** 确保关卡代码文件存在，返回其 Uri */
async function ensureLevelFile(context: vscode.ExtensionContext, level: Level): Promise<vscode.Uri> {
  const uri = levelFileUri(context, level);
  try {
    await fs.access(uri.fsPath);
  } catch {
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.writeFile(uri.fsPath, level.starterCode, 'utf8');
  }
  return uri;
}

/** 打开某一关：建文件 → 打开编辑器 → 打开详情页 */
async function openLevel(level: Level, context: vscode.ExtensionContext): Promise<void> {
  currentLevelId = level.id;
  lastGrade = null;
  lastRun = null;

  const uri = await ensureLevelFile(context, level);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });

  await store.update((p) => {
    p.meta.lastLevelId = level.id;
    p.meta.lastOpenedAt = new Date().toISOString();
  });

  showLevelPanel(level, context, true);
  sidebar.refresh();
}

/** 刷新关卡详情页 */
function showLevelPanel(level: Level, context: vscode.ExtensionContext, reveal = false): void {
  const cfg = readConfig();
  const uri = levelFileUri(context, level);
  const panel = LevelPanel.show(context.extensionUri, (type) => {
    void handlePanelAction(type, level, context);
  });
  const exists = existsSync(uri.fsPath);
  const model = vmb.buildLevelDetail(level, cfg, exists, lastGrade, lastRun);
  model.filePath = uri.fsPath;
  panel.setModel(model);
  if (reveal) {
    panel.reveal();
  }
}

async function handlePanelAction(
  type: string,
  level: Level,
  context: vscode.ExtensionContext
): Promise<void> {
  switch (type) {
    case 'openFile': {
      const uri = await ensureLevelFile(context, level);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      showLevelPanel(level, context);
      break;
    }
    case 'run':
      await runLevel(level, context);
      break;
    case 'submit':
      await submitLevel(level, context);
      break;
    case 'prev': {
      const p = curriculum.previousOf(level.id);
      if (p) {
        await openLevel(p, context);
      }
      break;
    }
    case 'next': {
      const n = curriculum.nextOf(level.id);
      if (n) {
        await openLevel(n, context);
      }
      break;
    }
    default:
      break;
  }
}

/** 本地运行某一关的代码 */
async function runLevel(
  level: Level,
  context: vscode.ExtensionContext,
  document?: vscode.TextDocument
): Promise<void> {
  const cfg = readConfig();
  const uri = document?.uri ?? levelFileUri(context, level);

  // 编辑器里有未保存改动时先保存，保证跑的是学生看到的那份代码
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (openDoc?.isDirty) {
    await openDoc.save();
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在运行第 ${level.day} 关代码…`, cancellable: false },
    async () => {
      const result = await runFile(uri.fsPath, {
        pythonPath: cfg.pythonPath,
        timeoutSec: cfg.runTimeoutSec,
      });
      lastRun = result;
      showLevelPanel(level, context);

      if (result.noInterpreter) {
        void promptAiSetup(
          `找不到 Python 解释器（${cfg.pythonPath}）。请在设置 pythonCamp.pythonPath 里填写完整路径。`
        );
        return;
      }
      if (result.ok) {
        void vscode.window.showInformationMessage(
          `第 ${level.day} 关运行成功（${result.durationMs} ms）。`
        );
      } else {
        const kind = result.errorKind ? `【${result.errorKind}】` : '';
        void vscode.window.showWarningMessage(
          `第 ${level.day} 关运行失败 ${kind}${result.timedOut ? '（超时）' : ''}。详情见关卡页。`
        );
      }
    }
  );
}

/** 提交并批改某一关的代码 */
async function submitLevel(
  level: Level,
  context: vscode.ExtensionContext,
  document?: vscode.TextDocument
): Promise<void> {
  const cfg = readConfig();
  const uri = document?.uri ?? levelFileUri(context, level);

  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (openDoc?.isDirty) {
    await openDoc.save();
  }

  let code = '';
  try {
    code = await fs.readFile(uri.fsPath, 'utf8');
  } catch {
    void vscode.window.showErrorMessage('还没找到代码文件，请先点「创建代码文件并开始」。');
    return;
  }

  if (code.replace(/^\s*#.*$/gm, '').trim().length < 10) {
    void vscode.window.showWarningMessage('代码还基本是空的，先写点东西再提交吧。');
    return;
  }

  if (cfg.enableAI && !aiReady(cfg)) {
    await promptAiSetup('还没配置 API Key，本次只做本地检查。要不要现在配置？');
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在批改第 ${level.day} 关…`,
      cancellable: false,
    },
    async (progress) => {
      let run: RunResult | null = null;
      if (cfg.autoRunBeforeGrade) {
        progress.report({ message: '本地运行检查…' });
        run = await runFile(uri.fsPath, {
          pythonPath: cfg.pythonPath,
          timeoutSec: cfg.runTimeoutSec,
        });
      }
      lastRun = run;

      progress.report({ message: cfg.enableAI && aiReady(cfg) ? 'AI 判分中…' : '本地评分中…' });
      const outcome = await gradeCode(level, code, run, {
        apiKey: cfg.apiKey,
        apiBaseUrl: cfg.apiBaseUrl,
        model: cfg.model,
        enableAI: aiReady(cfg),
        strictMode: cfg.strictMode,
        weakPoints: store.weakRanking(5).map((w) => w.tag),
      });

      const result = outcome.result;
      lastGrade = result;

      // 落库
      await store.update((p) => {
        const lp = p.levels[level.id] ?? {
          levelId: level.id,
          status: 'unlocked' as const,
          bestScore: 0,
          lastScore: 0,
          attempts: 0,
          history: [],
          weakTags: [],
        };
        lp.attempts += 1;
        lp.lastScore = result.score;
        lp.bestScore = Math.max(lp.bestScore, result.score);
        lp.lastSubmitAt = new Date().toISOString();
        lp.history.push({
          at: lp.lastSubmitAt,
          score: result.score,
          runnable: result.runnable,
          correctness: result.correctness,
          quality: result.quality,
          summary: result.summary,
          source: result.source,
        });
        if (lp.history.length > 30) {
          lp.history = lp.history.slice(-30);
        }
        lp.weakTags = Array.from(new Set([...(lp.weakTags ?? []), ...result.weakTags])).slice(-10);
        if (result.score >= cfg.passScore) {
          lp.status = 'passed';
          lp.passedAt = lp.passedAt ?? new Date().toISOString();
        } else {
          lp.status = 'unlocked';
        }
        p.levels[level.id] = lp;
        p.meta.lastLevelId = level.id;
      });

      if (result.weakTags.length) {
        await store.addWeakPoints(result.weakTags);
      }
      if (result.score >= cfg.passScore) {
        await scheduler.markDoneIfToday(level.id);
      }

      showLevelPanel(level, context);
      sidebar.refresh();
      refreshStatusBar();

      if (outcome.aiError) {
        void vscode.window.showWarningMessage(`AI 批改未成功：${outcome.aiError}`);
      }

      const passed = result.score >= cfg.passScore;
      const msg = `第 ${level.day} 关：${result.score} 分${passed ? '，已过关！' : `（过关线 ${cfg.passScore} 分）`}`;
      if (passed) {
        const next = curriculum.nextOf(level.id);
        const pick = await vscode.window.showInformationMessage(
          msg,
          next ? `进入第 ${next.day} 关` : '查看详情'
        );
        if (pick && next) {
          await openLevel(next, context);
        }
      } else {
        void vscode.window.showWarningMessage(msg);
      }
    }
  );
}

// ------------------------------------------------------------------ 辅助

/** 从当前编辑器推断要操作哪一关 */
function resolveTargetFromEditor(): { level: Level; document?: vscode.TextDocument } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python') {
    void vscode.window.showWarningMessage('请先打开一个 Python 文件（.py）再执行这个操作。');
    return undefined;
  }
  const lv = resolveLevelForDocument(editor.document);
  if (!lv) {
    void vscode.window.showWarningMessage(
      '认不出这个文件属于哪一关。文件名里带「第N关」就能自动识别，或者从面板里选关卡。'
    );
    return undefined;
  }
  currentLevelId = lv.id;
  return { level: lv, document: editor.document };
}

/** 根据文件名（第N关）或上次打开的关卡，判断文档属于哪一关 */
function resolveLevelForDocument(doc: vscode.TextDocument): Level | undefined {
  const base = path.basename(doc.uri.fsPath);
  const m = LEVEL_FILE_RE.exec(base);
  if (m) {
    const day = Number(m[1]);
    const byDay = curriculum.all.find((l) => l.day === day);
    if (byDay) {
      return byDay;
    }
  }
  const idMatch = /\b(L\d{2})\b/i.exec(base);
  if (idMatch) {
    const lv = curriculum.get(idMatch[1].toUpperCase());
    if (lv) {
      return lv;
    }
  }
  if (currentLevelId) {
    return curriculum.get(currentLevelId);
  }
  const last = store.progress.meta.lastLevelId;
  return last ? curriculum.get(last) : undefined;
}

/** 关卡快速选择器（按章节分组） */
async function pickLevelQuick(passScore: number, allowSkip: boolean): Promise<Level | undefined> {
  const p = store.progress;
  const items: Array<vscode.QuickPickItem & { level?: Level }> = [];
  for (const ch of curriculum.chapters) {
    items.push({ label: `第 ${ch.id} 章 ${ch.title}`, kind: vscode.QuickPickItemKind.Separator });
    for (const lv of curriculum.levelsOfChapter(ch.id)) {
      const st = curriculum.statusOf(lv.id, p, passScore, allowSkip);
      const lp = p.levels[lv.id];
      const icon = st === 'passed' ? '$(pass-filled)' : st === 'locked' ? '$(lock)' : '$(circle-outline)';
      const detail =
        st === 'passed'
          ? `已过关 · 最好 ${lp?.bestScore ?? 0} 分`
          : st === 'locked'
            ? '未解锁（先过前一关）'
            : lp && lp.attempts > 0
              ? `未过关 · 最好 ${lp.bestScore} 分 · ${lp.attempts} 次`
              : '可挑战';
      items.push({
        label: `${icon} 第 ${lv.day} 关 · ${lv.title}`,
        description: `${lv.id} · 难度 ${lv.difficulty}/5 · 约 ${lv.estimatedMinutes} 分钟`,
        detail,
        level: lv,
      });
    }
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: '选择关卡',
    placeHolder: '输入关键词可过滤（例如 numpy、第 22 关）',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.level;
}

function refreshStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const cfg = readConfig();
  const t = scheduler.todayProgress();
  const st = curriculum.stats(store.progress, cfg.passScore, cfg.allowSkipLevels);
  statusBar.text = `$(trophy) 今日 ${t.done}/${t.total} · 总 ${st.passed}/${st.total}`;
  statusBar.tooltip = `Python闯关训练营\n今日任务 ${t.done}/${t.total}\n已过关 ${st.passed}/${st.total}（${Math.round(
    st.completionRate * 100
  )}%）\n今日学习 ${humanDuration(store.progress.stats.dailyMs[todayKey()] ?? 0)}\n点击打开进度面板`;
  statusBar.show();
}

/** 处理来自侧边栏的消息 */
async function handleWebviewMessage(
  msg: WebviewMessage,
  context: vscode.ExtensionContext
): Promise<void> {
  switch (msg.type) {
    case 'refresh':
      sidebar.refresh();
      break;
    case 'startToday':
      await vscode.commands.executeCommand('pythonCamp.startToday');
      break;
    case 'openLevel': {
      const lv = curriculum.get(msg.levelId);
      if (lv) {
        await openLevel(lv, context);
      }
      break;
    }
    case 'submitLevel': {
      const lv = curriculum.get(msg.levelId);
      if (lv) {
        currentLevelId = lv.id;
        await submitLevel(lv, context);
      }
      break;
    }
    case 'runLevel': {
      const lv = curriculum.get(msg.levelId);
      if (lv) {
        currentLevelId = lv.id;
        await runLevel(lv, context);
      }
      break;
    }
    case 'resetToday':
      await vscode.commands.executeCommand('pythonCamp.resetToday');
      break;
    case 'retryWrong':
      await vscode.commands.executeCommand('pythonCamp.retryWrong');
      break;
    case 'pickLevel':
      await vscode.commands.executeCommand('pythonCamp.pickLevel');
      break;
    case 'openSettings':
      await vscode.commands.executeCommand('pythonCamp.openSettings');
      break;
    case 'exportReport':
      await exportReport(context);
      break;
    case 'resetAll':
      await vscode.commands.executeCommand('pythonCamp.resetAll');
      break;
    case 'unlockLevel':
      await store.update((p) => {
        const lp = p.levels[msg.levelId] ?? {
          levelId: msg.levelId,
          status: 'unlocked' as const,
          bestScore: 0,
          lastScore: 0,
          attempts: 0,
          history: [],
          weakTags: [],
        };
        lp.manualUnlocked = true;
        p.levels[msg.levelId] = lp;
      });
      sidebar.refresh();
      break;
    default:
      break;
  }
}

/** 导出 Markdown 学习报告 */
async function exportReport(context: vscode.ExtensionContext): Promise<void> {
  const cfg = readConfig();
  const p = store.progress;
  const st = curriculum.stats(p, cfg.passScore, cfg.allowSkipLevels);
  const lines: string[] = [];

  lines.push('# Python闯关训练营 · 学习报告', '');
  lines.push(`- 学生：${p.student.name || '（未填写）'}${p.student.cohort ? ` · ${p.student.cohort}` : ''}`);
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 题库来源：${curriculum.meta.sourceDocs.map((s) => s.file).join('、')}`);
  lines.push('');
  lines.push('## 总览', '');
  lines.push('| 指标 | 数值 |', '| --- | --- |');
  lines.push(`| 已过关 | ${st.passed} / ${st.total} |`);
  lines.push(`| 完成率 | ${Math.round(st.completionRate * 100)}% |`);
  lines.push(`| 平均分 | ${st.scoredCount ? st.avgScore.toFixed(1) : '—'} |`);
  lines.push(`| 累计学习时长 | ${humanDuration(p.stats.totalStudyMs)} |`);
  lines.push(`| 连续打卡 | ${p.stats.streak.current} 天（最长 ${p.stats.streak.best} 天） |`);
  lines.push(`| 有效学习天数 | ${p.stats.activeDays.length} 天 |`);
  lines.push('');

  lines.push('## 各章进度', '');
  lines.push('| 章节 | 已过关 | 关卡数 | 难度 |', '| --- | --- | --- | --- |');
  for (const ch of curriculum.chapters) {
    const levels = curriculum.levelsOfChapter(ch.id);
    const done = levels.filter((l) => curriculum.isPassed(l.id, p, cfg.passScore)).length;
    lines.push(`| ${ch.id}. ${ch.title} | ${done} | ${levels.length} | ${'★'.repeat(ch.difficulty)} |`);
  }
  lines.push('');

  const scored = curriculum.all
    .map((l) => ({ l, lp: p.levels[l.id] }))
    .filter((x) => x.lp && x.lp.attempts > 0);
  if (scored.length) {
    lines.push('## 关卡成绩明细', '');
    lines.push('| 关卡 | 标题 | 最好分 | 最近分 | 次数 | 状态 |', '| --- | --- | --- | --- | --- | --- |');
    for (const { l, lp } of scored) {
      const status = curriculum.isPassed(l.id, p, cfg.passScore) ? '已过关' : '未过关';
      lines.push(
        `| ${l.id} | ${l.title} | ${lp!.bestScore} | ${lp!.lastScore} | ${lp!.attempts} | ${status} |`
      );
    }
    lines.push('');
  }

  const weak = store.weakRanking(15);
  if (weak.length) {
    lines.push('## 薄弱知识点', '');
    lines.push('| 知识点 | 累计扣分次数 |', '| --- | --- |');
    for (const w of weak) {
      lines.push(`| ${w.tag} | ${w.count} |`);
    }
    lines.push('');
  }

  const wrong = curriculum.wrongLevels(p, cfg.passScore);
  if (wrong.length) {
    lines.push('## 建议重刷的关卡', '');
    for (const l of wrong.slice(0, 20)) {
      lines.push(`- 第 ${l.day} 关 ${l.title}（最好 ${p.levels[l.id]?.bestScore ?? 0} 分）`);
    }
    lines.push('');
  }

  lines.push('## 每日学习时长', '');
  lines.push('| 日期 | 时长 |', '| --- | --- |');
  for (const d of store.recentDays(30)) {
    lines.push(`| ${d.date} | ${humanDuration(d.ms)} |`);
  }
  lines.push('');

  const file = reportFilePath(context);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showInformationMessage(`学习报告已导出：${file}`);
}
