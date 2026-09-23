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
import { TerminalRecorder } from './core/terminal';
import { scanPendingSubmissions } from './core/pending';
import type { PendingLevel } from './core/pending';
import { gradeCode, promptAiSetup, extractJson } from './core/grader';
import {
  generateLevelAnswer,
  generateErrorDiagnosis,
  generateAlternativeSolutions,
  askAssistant,
} from './ai/tasks';
import { chat, AiError, resolveEndpoint } from './ai/client';
import { readConfig, aiReady } from './core/config';
import type { CampConfig } from './core/config';
import type { GradeResult, Level, RunResult, WebviewMessage } from './core/types';

import { SidebarProvider } from './panels/sidebar';
import { LevelPanel } from './panels/levelPanel';
import { ChatPanel } from './panels/chatPanel';
import type { ChatMessageModel } from './panels/chatPanel';
import { renderMarkdown } from './panels/html';
import { ViewModelBuilder } from './panels/viewModel';
import type { TextTaskOptions } from './ai/tasks';
import {
  levelFileUri,
  reportFilePath,
  humanDuration,
  todayKey,
  answerFilePath,
  answerDir,
  solutionsFilePath,
  stateDir,
  workDir,
} from './util/paths';

let store: ProgressStore;
let curriculum: Curriculum;
let scheduler: Scheduler;
let timer: StudyTimer;
let vmb: ViewModelBuilder;
let sidebar: SidebarProvider;
let statusBar: vscode.StatusBarItem;
/** 扩展上下文（异步扫描等辅助函数要用） */
let extContext: vscode.ExtensionContext;
/** 集成终端记录（把学生自己敲的 python 命令与输出作为批改证据） */
let terminalRecorder: TerminalRecorder;
/** AI 诊断日志（测试连接、调用失败时的详细信息） */
let aiLog: vscode.OutputChannel;

/** 最近一次 AI 报错分析（Markdown），渲染在关卡详情页 */
let lastDiagnosis: { levelId: string; markdown: string } | null = null;

/** 问答面板与对话历史（存在扩展侧，面板关掉再开不丢） */
let chatPanel: ChatPanel | undefined;
let chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
let chatDisplay: ChatMessageModel[] = [];

/** 当前正在操作的关卡 */
let currentLevelId: string | undefined;
/** 最近一次批改结果（用于详情页展示） */
let lastGrade: GradeResult | null = null;
let lastRun: RunResult | null = null;
/**
 * 「写了代码但没提交批改」的关卡（缓存）。
 *
 * 侧边栏的模型构建是同步的，而扫描文件是异步的 —— 所以扫描结果先落到这里，
 * 由 buildSidebar 同步读取。扫描在激活、进度变化、保存文件时触发。
 */
let pendingLevels: PendingLevel[] = [];

const LEVEL_FILE_RE = /第(\d+)关/;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;
  store = new ProgressStore(context);
  curriculum = new Curriculum();
  curriculum.load(context.extensionUri);
  await store.load();

  const cfg = readConfig();

  // 进度自愈：历史数据可能因为「过线分数被外部插件顶高」而留下
  // 「明明过关了、面板却显示未过关」的痕迹，这里按最好成绩重新对齐一次。
  const healed = await store.reconcile(cfg.passScore);
  if (healed) {
    void vscode.window.showInformationMessage(
      '检测到进度档案里有过关记录未同步（可能由其它同名插件改动了过关线），已自动修正。'
    );
  }

  scheduler = new Scheduler(store, curriculum);
  vmb = new ViewModelBuilder(store, curriculum, scheduler);

  // 集成终端记录（VS Code 1.93+；低版本静默降级）
  terminalRecorder = new TerminalRecorder();
  terminalRecorder.setEnabled(cfg.terminalContext);
  terminalRecorder.start();
  context.subscriptions.push({
    dispose: () => terminalRecorder.dispose(),
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pythonCamp.terminalContext')) {
        terminalRecorder.setEnabled(readConfig().terminalContext);
      }
    })
  );

  // 装了同名插件就提醒 —— 两个插件会共用活动栏容器 ID 与配置键，
  // 造成「两个图标长得不一样」「进度各存各的」这类莫名其妙的症状。


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
    () => vmb.buildSidebar(readConfig(), pendingLevels),
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

  aiLog = vscode.window.createOutputChannel('Python闯关训练营');
  context.subscriptions.push(aiLog);

  registerCommands(context);

  // 同名插件冲突检测（放在 aiLog 之后，日志才写得进去）
  void warnOnConflictingExtension();

  // 进度变化时刷新所有 UI
  context.subscriptions.push(
    store.onDidChange(() => {
      sidebar.refresh();
      refreshStatusBar();
      void refreshPending();
    })
  );

  // 保存关卡代码时重扫「写了但没提交」，让面板上的提示实时跟上
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.fsPath.endsWith('.py') && isUnderWorkDir(doc.uri.fsPath)) {
        void refreshPending();
      }
    })
  );

  // 首次扫描（放在侧边栏创建之后，才能把结果推给面板）
  void refreshPending();

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
        const st2 = curriculum.stats(store.progress, c.passScore, c.allowSkipLevels);
        void vscode.window.showInformationMessage(
          `新的一天，今日任务已重新派发（累计已过关 ${st2.passed}/${st2.total} 关，成绩不会清零）。`
        );
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
    const st = curriculum.stats(store.progress, cfg.passScore, cfg.allowSkipLevels);
    // 明确说清「今日任务重派 ≠ 进度清零」—— 这是学生最容易误解的一点
    void vscode.window
      .showInformationMessage(
        `今日任务已派发：${t.total} 关（从第 ${
          scheduler.todayLevels()[0]?.day ?? 1
        } 关开始）。今日完成数每天归零，但累计已过关 ${st.passed}/${st.total} 关的成绩会永久保留。`,
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

/** 本插件的完整标识（用于识别「同名插件」） */
const OUR_EXT_ID = 'gude123-ux.python-challenge-camp';

/**
 * 检测工作区里是否同时装了**另一个同名插件**。
 *
 * 为什么会这样：本机曾出现两个 displayName 都叫「Python闯关训练营」的插件，
 * 它们
 *   * 活动栏容器 ID 都是 pythonCamp → 两个视图被合并到一个图标里，看起来"少了东西"；
 *   * 都声明了 pythonCamp.passScore → 默认值互相覆盖，75 分时而过关时而不算；
 *   * 各自把进度写进不同的目录（.pythoncamp / .python-camp）→ 进度互不可见。
 * 学生看到的现象就是「打开快捷方式弹出两个不一样的窗口」「过了两关另一个没显示」。
 *
 * 这里不静默处理，而是**明确告知并给一个卸载按钮**（卸载动作由 VS Code 自己执行，
 * 用户随时可以取消）。
 */
async function warnOnConflictingExtension(): Promise<void> {
  try {
    // 防御式取值：某些宿主 / 测试替身里没有 extensions API，
    // 这个检查只是"锦上添花"，绝不能因为它让激活失败。
    const all = vscode.extensions?.all ?? [];
    const conflicts = all.filter((ext) => {
      if (ext.id === OUR_EXT_ID) {
        return false;
      }
      const name = ext.packageJSON?.displayName ?? '';
      const pkgName = ext.packageJSON?.name ?? '';
      return name === 'Python闯关训练营' || pkgName === 'python-challenge-camp';
    });
    if (!conflicts.length) {
      return;
    }

    const list = conflicts.map((c) => `${c.id} v${c.packageJSON?.version ?? '?'}`).join('、');
    aiLog.appendLine(`[冲突检测] 发现同名插件：${list}`);

    const pick = await vscode.window.showWarningMessage(
      `检测到另一个同名插件「Python闯关训练营」（${list}）。它和本插件会互相干扰：` +
        '两个图标看起来不一样、进度各存各的、过关分数线还会互相覆盖。建议卸载它。',
      '卸载它',
      '稍后再说'
    );
    if (pick !== '卸载它') {
      return;
    }
    for (const c of conflicts) {
      try {
        await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', c.id);
      } catch {
        void vscode.window.showWarningMessage(
          `自动卸载 ${c.id} 失败，请在「扩展」面板里手动卸载它。`
        );
      }
    }
  } catch (err: any) {
    aiLog.appendLine(`[冲突检测] 检查失败（不影响使用）：${String(err?.message ?? err)}`);
  }
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

  reg('pythonCamp.submitPending', async () => {
    await submitPendingLevels(context);
  });

  reg('pythonCamp.exportReport', async () => {
    await exportReport(context);
  });

  reg('pythonCamp.openConfig', async () => {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:gude123-ux.python-challenge-camp'
    );
  });

  reg('pythonCamp.testConnection', async () => {
    await testConnection();
  });

  reg('pythonCamp.explainLevel', async () => {
    const level = resolveAnyLevel();
    if (!level) {
      void vscode.window.showWarningMessage('先打开一个关卡（或打开带「第N关」的 .py 文件），再让我解答。');
      return;
    }
    await explainLevel(level, context);
  });

  reg('pythonCamp.multipleSolutions', async () => {
    const level = resolveAnyLevel();
    if (!level) {
      void vscode.window.showWarningMessage('先打开一个关卡（或打开带「第N关」的 .py 文件），再让我列解法。');
      return;
    }
    await multipleSolutions(level, context);
  });

  reg('pythonCamp.diagnoseError', async () => {
    const level = resolveAnyLevel();
    if (!level) {
      void vscode.window.showWarningMessage('先打开一个关卡（或打开带「第N关」的 .py 文件），再让我分析报错。');
      return;
    }
    await diagnoseError(level, context);
  });

  reg('pythonCamp.askQuestion', async () => {
    await openChatPanel(context);
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
  lastDiagnosis = null;
  chatPanel?.setContext(chatContextLabel(level));

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
  // 报错分析只对「它所属的那一关」有效，换关就不要再显示上一关的结论
  const diagnosis =
    lastDiagnosis && lastDiagnosis.levelId === level.id ? lastDiagnosis.markdown : null;
  const model = vmb.buildLevelDetail(level, cfg, exists, lastGrade, lastRun, diagnosis);
  model.filePath = uri.fsPath;
  const pending = pendingLevels.find((x) => x.levelId === level.id);
  if (pending) {
    model.pendingLines = pending.codeLines;
  }
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
    case 'answer':
      await explainLevel(level, context);
      break;
    case 'solutions':
      await multipleSolutions(level, context);
      break;
    case 'diagnose':
      await diagnoseError(level, context);
      break;
    case 'ask':
      currentLevelId = level.id;
      await openChatPanel(context, level);
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
        // 自动分析报错：直接复用刚才这次运行结果，不重复跑一遍
        if (cfg.autoDiagnoseOnError && aiReady(cfg)) {
          await diagnoseError(level, context, { run: result, quiet: true });
        }
      }
    }
  );
}

// ---------------------------------------------------------- 「写了但没提交」的检测

/** 某个路径是否落在学习工作区的代码目录里 */
function isUnderWorkDir(file: string): boolean {
  if (!extContext) {
    return false;
  }
  return file.startsWith(workDir(extContext));
}

/**
 * 重新扫描「写了代码但没提交批改」的关卡。
 *
 * 为什么要有这个：学生常常写完了代码却忘了点「提交并批改」，
 * 面板上看到的还是「可挑战 / 未过关」，于是觉得「我明明做了，进度却没了」。
 * 扫描结果变了就刷新面板。
 */
async function refreshPending(): Promise<void> {
  if (!extContext || !curriculum || !store) {
    return;
  }
  try {
    const next = await scanPendingSubmissions(curriculum.all, workDir(extContext), store.progress);
    const before = pendingLevels.map((x) => `${x.levelId}:${x.codeLines}`).join(',');
    const after = next.map((x) => `${x.levelId}:${x.codeLines}`).join(',');
    pendingLevels = next;
    if (before !== after) {
      sidebar?.refresh();
    }
  } catch {
    // 扫描失败不该影响主流程（面板少一条提示而已）
  }
}

/** 把「写了代码但没提交」的关卡依次补交批改 */
async function submitPendingLevels(context: vscode.ExtensionContext): Promise<void> {
  const targets = pendingLevels
    .map((x) => curriculum.get(x.levelId))
    .filter((l): l is Level => !!l);
  if (!targets.length) {
    void vscode.window.showInformationMessage('没有「写了代码但还没提交」的关卡。');
    return;
  }
  const list = targets.map((l) => `第 ${l.day} 关`).join('、');
  const pick = await vscode.window.showWarningMessage(
    `这 ${targets.length} 关的文件里有你写的代码，但一次都没提交过批改：${list}。现在依次提交吗？`,
    { modal: true },
    '开始补交'
  );
  if (pick !== '开始补交') {
    return;
  }
  for (const level of targets) {
    currentLevelId = level.id;
    // quiet：批量模式下不弹「进入下一关」那种需要点确认的对话框，否则会卡住
    await submitLevel(level, context, undefined, true);
  }
  await refreshPending();
  sidebar.refresh();
}

/** 提交并批改某一关的代码 */
async function submitLevel(
  level: Level,
  context: vscode.ExtensionContext,
  document?: vscode.TextDocument,
  /** 批量补交时为 true：不弹需要用户点确认的对话框 */
  quiet = false
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

      // 终端证据：学生可能自己在集成终端里跑过（课程材料里有些练习就是这么做的）
      const terminal = cfg.terminalContext ? terminalRecorder.context() : '';

      progress.report({ message: cfg.enableAI && aiReady(cfg) ? 'AI 判分中…' : '本地评分中…' });
      const outcome = await gradeCode(level, code, run, {
        apiKey: cfg.apiKey,
        apiBaseUrl: cfg.apiBaseUrl,
        model: cfg.model,
        enableAI: aiReady(cfg),
        strictMode: cfg.strictMode,
        weakPoints: store.weakRanking(5).map((w) => w.tag),
        maxTokens: cfg.maxTokens,
        timeoutSec: cfg.aiTimeoutSec,
        retryOnBadJson: cfg.retryOnBadJson,
        terminal,
      });

      const result = outcome.result;

      // ★ AI 批改没跑成时（限流 / 网络 / 超时 / 返回被截断…），不要把它当成一次成绩。
      //   否则一次 429 就会给出一份封顶 85 的本地参考分，学生看到"未过关"，
      //   实际上根本没被真正批改过 —— 用户实测就吃过这个亏（AI 打分偏低）。
      const aiFailed = !!outcome.aiError && aiReady(cfg);
      if (aiFailed) {
        const reason = (outcome.aiError ?? '').split('\n')[0];
        lastGrade = {
          ...result,
          issues: [
            `⚠️ 本次 AI 批改未完成，下面的分数只是本地检查的参考分，**不计入过关判定**。原因：${reason}`,
            ...result.issues,
          ],
        };
        showLevelPanel(level, context);
        if (quiet) {
          void vscode.window.showWarningMessage(
            `第 ${level.day} 关：AI 批改未完成（${reason}）。本次不记成绩。`
          );
          return;
        }
        const pick = await vscode.window.showWarningMessage(
          `第 ${level.day} 关：AI 批改未完成（${reason}）。本次不记成绩。`,
          '重试 AI 批改',
          '查看日志',
          '先不批改'
        );
        if (pick === '重试 AI 批改') {
          await submitLevel(level, context, document);
        } else if (pick === '查看日志') {
          aiLog.show(true);
        }
        return;
      }

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
        } else if (lp.status !== 'passed' && lp.bestScore < cfg.passScore) {
          // 只在「从来没到过线」时才退回未过关。
          // 早期版本这里无条件写 unlocked —— 一旦过线分数被外部因素调高
          // （例如另一个同名插件覆盖了 pythonCamp.passScore 的默认值），
          // 已经过关的关卡会莫名其妙地"退回未过关"，学生看到的就是"进度倒退了"。
          lp.status = 'unlocked';
        }
        p.levels[level.id] = lp;
        p.meta.lastLevelId = level.id;
      });

      if (result.weakTags.length) {
        await store.addWeakPoints(result.weakTags);
      }

      // 本次到线、或历史上已经到过线，都算「今日这一关完成」——
      // 否则重刷一次拿低分就会把今日进度抹掉。
      const passed =
        result.score >= cfg.passScore || store.progress.levels[level.id]?.bestScore >= cfg.passScore;
      if (passed) {
        await scheduler.markDoneIfToday(level.id);
      }

      showLevelPanel(level, context);
      sidebar.refresh();
      refreshStatusBar();

      const msg = `第 ${level.day} 关：${result.score} 分${passed ? '，已过关！' : `（过关线 ${cfg.passScore} 分）`}`;
      if (quiet) {
        // 批量补交：不弹需要点确认的对话框，否则会卡在第一个关卡上
        void vscode.window.showInformationMessage(msg);
      } else if (passed) {
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

// ------------------------------------------------------------------ AI 诊断与解答

/** 把 AiError 的错误类型翻译成「下一步该干什么」 */
function aiErrorAdvice(err: unknown): string {
  if (!(err instanceof AiError)) {
    return String((err as any)?.message ?? err);
  }
  const base = `${err.message}${err.detail ? `\n${err.detail}` : ''}`;
  const hint: Record<string, string> = {
    'no-key': '→ 到设置里填 pythonCamp.apiKey。',
    auth: '→ Key 可能填错、已失效或没额度，换一个再试。',
    'not-found': '→ 检查 pythonCamp.apiBaseUrl 是否要带 /v1，以及 pythonCamp.model 名字对不对。',
    'rate-limit': '→ 等一会儿再试，或换 Key / 换模型。',
    server: '→ 是模型服务端的问题，稍后重试；持续失败就换个服务地址。',
    network: '→ 网络不通或地址写错。先用浏览器/curl 确认这个地址能访问。',
    timeout: '→ 推理模型很慢，把 pythonCamp.aiTimeoutSec 调大（比如 300）。',
    truncated: '→ 把 pythonCamp.maxTokens 调大（比如 8000）。',
    'bad-response': '→ 服务返回的格式不是标准 OpenAI 格式，换一个兼容端点试试。',
  };
  return `${base}\n${hint[err.kind] ?? ''}`.trim();
}

/**
 * 「测试连接」：把配置、端点、网络、以及**能否解析出 JSON** 逐项验一遍。
 *
 * 最后一项是刻意加的 —— 这次踩过的坑就是「HTTP 通了、模型也正常返回了，
 * 但解析器把 JSON 弄坏了」，只测 HTTP 是发现不了的。
 */
async function testConnection(): Promise<void> {
  const cfg = readConfig();
  aiLog.show(true);
  aiLog.appendLine('');
  aiLog.appendLine(`===== 测试连接 · ${new Date().toLocaleString()} =====`);

  let endpoint = '';
  let endpointError = '';
  try {
    endpoint = resolveEndpoint(cfg.apiBaseUrl);
  } catch (e) {
    endpointError = String((e as any)?.message ?? e);
  }

  aiLog.appendLine(`服务地址  : ${cfg.apiBaseUrl || '(空)'}`);
  aiLog.appendLine(`解析端点  : ${endpoint || `(无法解析：${endpointError})`}`);
  aiLog.appendLine(`模型      : ${cfg.model || '(空)'}`);
  aiLog.appendLine(
    `API Key   : ${cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…（共 ${cfg.apiKey.length} 字符）` : '(空)'}`
  );
  aiLog.appendLine(`maxTokens : ${cfg.maxTokens}    超时 : ${cfg.aiTimeoutSec}s`);

  const problems: string[] = [];
  if (!cfg.enableAI) {
    problems.push('pythonCamp.enableAI = false（AI 批改总开关关着）');
  }
  if (!cfg.apiKey) {
    problems.push('pythonCamp.apiKey 为空');
  }
  if (!cfg.apiBaseUrl) {
    problems.push('pythonCamp.apiBaseUrl 为空');
  }
  if (!cfg.model) {
    problems.push('pythonCamp.model 为空');
  }
  if (endpointError) {
    problems.push(`服务地址无法解析：${endpointError}`);
  }

  if (problems.length) {
    aiLog.appendLine('');
    aiLog.appendLine('配置不完整：');
    for (const p of problems) {
      aiLog.appendLine(`  ✗ ${p}`);
    }
    const pick = await vscode.window.showWarningMessage(
      `AI 配置不完整：${problems[0]}`,
      '打开设置',
      '知道了'
    );
    if (pick === '打开设置') {
      await vscode.commands.executeCommand('pythonCamp.openConfig');
    }
    return;
  }

  aiLog.appendLine('');
  aiLog.appendLine('发出一次最小请求（要求模型回 JSON）…');

  const started = Date.now();
  try {
    const reply = await chat({
      baseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages: [
        { role: 'system', content: '你是测试助手。只输出 JSON，不要输出任何解释文字。' },
        { role: 'user', content: '请原样输出这个 JSON：{"ok": true, "msg": "连接正常"}' },
      ],
      temperature: 0,
      maxTokens: 512,
      timeoutMs: Math.max(20, cfg.aiTimeoutSec) * 1000,
    });
    const ms = Date.now() - started;

    aiLog.appendLine(`  ✓ HTTP 请求成功（${ms} ms）`);
    aiLog.appendLine(`  ✓ 实际模型 : ${reply.model ?? '(服务未返回)'}`);
    aiLog.appendLine(`  ✓ 结束原因 : ${reply.finishReason ?? '(未返回)'}`);
    if (reply.usage) {
      aiLog.appendLine(
        `  ✓ token    : 输入 ${reply.usage.promptTokens ?? '?'} / 输出 ${reply.usage.completionTokens ?? '?'}`
      );
    }

    // 关键一步：模型回了内容 ≠ 我们能用。这里顺便验证解析链路。
    const parsed = extractJson(reply.content);
    if (parsed) {
      aiLog.appendLine('  ✓ 返回内容能解析为 JSON');
      aiLog.appendLine(`  原始返回：${reply.content.trim().slice(0, 200)}`);
      aiLog.appendLine('结论：一切正常，AI 批改应该可以工作。');
      void vscode.window.showInformationMessage(
        `AI 连接正常（${ms} ms，模型 ${cfg.model}）。批改与求解答都可以用了。`
      );
    } else {
      aiLog.appendLine('  ✗ 返回内容无法解析为 JSON');
      aiLog.appendLine('  原始返回（前 600 字符）：');
      aiLog.appendLine(reply.content.slice(0, 600));
      aiLog.appendLine('结论：HTTP 通了，但解析链路有问题 —— 请把上面的原始返回发给我。');
      void vscode.window.showWarningMessage(
        '连接成功，但返回内容解析不出 JSON。详情见「输出」面板的「Python闯关训练营」通道。'
      );
    }
  } catch (err) {
    const ms = Date.now() - started;
    const advice = aiErrorAdvice(err);
    aiLog.appendLine(`  ✗ 失败（${ms} ms）`);
    aiLog.appendLine(advice);
    aiLog.appendLine('结论：连接不通过，AI 批改会退回到本地评分。');
    const pick = await vscode.window.showErrorMessage(
      `AI 连接失败：${advice.split('\n')[0]}`,
      '打开设置',
      '查看日志'
    );
    if (pick === '打开设置') {
      await vscode.commands.executeCommand('pythonCamp.openConfig');
    } else if (pick === '查看日志') {
      aiLog.show(true);
    }
  }
}

/** 尽量推断「现在该解答哪一关」：当前编辑器 → 上次打开的关卡 → 今日任务第一关 */
function resolveAnyLevel(): Level | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === 'python') {
    const lv = resolveLevelForDocument(editor.document);
    if (lv) {
      currentLevelId = lv.id;
      return lv;
    }
  }
  if (currentLevelId) {
    const lv = curriculum.get(currentLevelId);
    if (lv) {
      return lv;
    }
  }
  return scheduler.todayLevels()[0];
}

/** 用系统默认的 Markdown 预览打开参考答案；预览不可用时退回源码视图 */
async function openAnswerPreview(file: string): Promise<void> {
  const uri = vscode.Uri.file(file);
  try {
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
  } catch {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }
}

/**
 * 让 AI 讲解某一关并给出参考答案。
 *
 * 生成结果落盘成 Markdown（`python-camp/参考答案/第NN关_参考答案.md`），
 * 而不是只弹一次 —— 这样学生能反复看、能离线看、也能自己批注。
 * 已经生成过就直接打开，避免重复烧 token。
 */
async function explainLevel(
  level: Level,
  context: vscode.ExtensionContext,
  force = false
): Promise<void> {
  const cfg = readConfig();
  const file = answerFilePath(context, level);

  if (!force && existsSync(file)) {
    await openAnswerPreview(file);
    const pick = await vscode.window.showInformationMessage(
      `第 ${level.day} 关的参考答案已经生成过了，已为你打开。`,
      '重新生成'
    );
    if (pick === '重新生成') {
      await explainLevel(level, context, true);
    }
    return;
  }

  if (!aiReady(cfg)) {
    await promptAiSetup('生成参考答案需要配置 API Key。要不要现在配置？');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AI 正在解答第 ${level.day} 关…（推理模型可能要几十秒）`,
      cancellable: false,
    },
    async () => {
      try {
        const md = await generateLevelAnswer(level, {
          apiKey: cfg.apiKey,
          apiBaseUrl: cfg.apiBaseUrl,
          model: cfg.model,
          maxTokens: cfg.maxTokens,
          timeoutSec: cfg.aiTimeoutSec,
        });

        const header = [
          `> 本文件由 AI 生成于 ${new Date().toLocaleString()}，仅供对照学习，不保证唯一解。`,
          '> 建议先自己写完再打开看，效果差别很大。',
          '',
          `**关卡**：第 ${level.day} 关 · ${level.title}　　**模型**：${cfg.model}`,
          '',
          '---',
          '',
        ].join('\n');

        await fs.mkdir(answerDir(context), { recursive: true });
        await fs.writeFile(file, `${header}${md}\n`, 'utf8');
        await openAnswerPreview(file);
        aiLog.appendLine(`[参考答案] 第 ${level.day} 关已生成：${file}`);
        void vscode.window.showInformationMessage(`第 ${level.day} 关参考答案已生成。`);
      } catch (err) {
        await reportAiTaskError('生成参考答案', err);
      }
    }
  );
}

// -------------------------------------------------- 多种解法 / 报错分析 / 问答

/** 读取某一关的代码文件内容（不存在或读不到就返回空串） */
async function readLevelCode(context: vscode.ExtensionContext, level: Level): Promise<string> {
  try {
    return await fs.readFile(levelFileUri(context, level).fsPath, 'utf8');
  } catch {
    return '';
  }
}

/** 长文本 AI 任务的调用参数（从设置里取） */
function aiTaskOptions(cfg: CampConfig): TextTaskOptions {
  return {
    apiKey: cfg.apiKey,
    apiBaseUrl: cfg.apiBaseUrl,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    timeoutSec: cfg.aiTimeoutSec,
  };
}

/** 统一的「AI 任务失败」处理：写日志 + 给可操作的下一步 */
async function reportAiTaskError(what: string, err: unknown): Promise<void> {
  const advice = aiErrorAdvice(err);
  aiLog.appendLine(`[${what}失败] ${advice}`);
  const pick = await vscode.window.showErrorMessage(
    `${what}失败：${advice.split('\n')[0]}`,
    '测试连接',
    '查看日志'
  );
  if (pick === '测试连接') {
    await testConnection();
  } else if (pick === '查看日志') {
    aiLog.show(true);
  }
}

/**
 * AI 列出同一道题的多种解法，落盘成 Markdown 并打开预览。
 * 和参考答案同目录、同样「已存在就直接打开」，避免重复烧 token。
 */
async function multipleSolutions(
  level: Level,
  context: vscode.ExtensionContext,
  force = false
): Promise<void> {
  const cfg = readConfig();
  const file = solutionsFilePath(context, level);

  if (!force && existsSync(file)) {
    await openAnswerPreview(file);
    const pick = await vscode.window.showInformationMessage(
      `第 ${level.day} 关的多种解法已经生成过了，已为你打开。`,
      '重新生成'
    );
    if (pick === '重新生成') {
      await multipleSolutions(level, context, true);
    }
    return;
  }

  if (!aiReady(cfg)) {
    await promptAiSetup('列出多种解法需要配置 API Key。要不要现在配置？');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AI 正在整理第 ${level.day} 关的多种解法…（推理模型可能要几十秒）`,
      cancellable: false,
    },
    async () => {
      try {
        const md = await generateAlternativeSolutions(level, aiTaskOptions(cfg));
        const header = [
          `> 本文件由 AI 生成于 ${new Date().toLocaleString()}，解法仅供参考，不保证覆盖全部写法。`,
          '> 建议先自己写完一种，再来看其他思路。',
          '',
          `**关卡**：第 ${level.day} 关 · ${level.title}　　**模型**：${cfg.model}`,
          '',
          '---',
          '',
        ].join('\n');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${header}${md}\n`, 'utf8');
        await openAnswerPreview(file);
        aiLog.appendLine(`[多种解法] 第 ${level.day} 关已生成：${file}`);
        void vscode.window.showInformationMessage(`第 ${level.day} 关的多种解法已生成。`);
      } catch (err) {
        await reportAiTaskError('生成多种解法', err);
      }
    }
  );
}

interface DiagnoseOptions {
  /** 已经跑过的运行结果。传了就复用，不再本地重跑一遍 */
  run?: RunResult | null;
  /** 自动触发时为 true：不弹成功提示，避免打扰 */
  quiet?: boolean;
}

/**
 * AI 分析报错原因。
 *
 * 会**先本地真跑一次**拿到真实 traceback —— 报错分析的价值就在这条 traceback 上，
 * 让模型凭空猜"可能哪里错了"没有意义。
 * 代码能跑通时不做分析（没报错可分析），会直接告诉用户。
 */
async function diagnoseError(
  level: Level,
  context: vscode.ExtensionContext,
  options: DiagnoseOptions = {}
): Promise<void> {
  const cfg = readConfig();
  const uri = levelFileUri(context, level);
  const quiet = options.quiet === true;

  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (openDoc?.isDirty) {
    await openDoc.save();
  }

  const code = await readLevelCode(context, level);
  if (!code.trim()) {
    if (!quiet) {
      void vscode.window.showWarningMessage('这一关还没有代码文件，先写点东西再分析。');
    }
    return;
  }

  if (!aiReady(cfg)) {
    if (!quiet) {
      await promptAiSetup('分析报错需要配置 API Key。要不要现在配置？');
    }
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在分析第 ${level.day} 关的报错…`,
      cancellable: false,
    },
    async (progress) => {
      let run: RunResult | null = options.run ?? null;
      if (!run) {
        progress.report({ message: '本地运行，抓取真实报错…' });
        run = await runFile(uri.fsPath, {
          pythonPath: cfg.pythonPath,
          timeoutSec: cfg.runTimeoutSec,
        });
        lastRun = run;
      }

      if (run.noInterpreter) {
        if (!quiet) {
          await promptAiSetup(
            `找不到 Python 解释器（${cfg.pythonPath}），拿不到真实报错。请在设置 pythonCamp.pythonPath 里填完整路径。`
          );
        }
        return;
      }

      if (run.ok) {
        lastDiagnosis = null;
        showLevelPanel(level, context);
        if (!quiet) {
          void vscode.window.showInformationMessage(
            `第 ${level.day} 关代码运行正常，没有报错可分析。想看不同写法可以用「多种解法」。`
          );
        }
        return;
      }

      progress.report({ message: 'AI 正在定位原因…' });
      try {
        const terminal = cfg.terminalContext ? terminalRecorder.context() : '';
        const md = await generateErrorDiagnosis(level, code, run, aiTaskOptions(cfg), terminal);
        lastDiagnosis = { levelId: level.id, markdown: md };
        showLevelPanel(level, context);
        aiLog.appendLine(`[报错分析] 第 ${level.day} 关：${run.errorKind ?? '未识别类型'}`);
        void vscode.window.showInformationMessage(
          quiet
            ? `第 ${level.day} 关运行报错，AI 分析已生成（见「关卡详情」页）。`
            : `第 ${level.day} 关报错分析已生成，见右侧「关卡详情」页。`
        );
      } catch (err) {
        if (!quiet) {
          await reportAiTaskError('分析报错', err);
        } else {
          aiLog.appendLine(`[报错分析失败] ${aiErrorAdvice(err)}`);
        }
      }
    }
  );
}

// ------------------------------------------------------------------ 问答

function chatContextLabel(level: Level | undefined): string {
  return level ? `第 ${level.day} 关 · ${level.title}` : '（未识别当前关卡）';
}

/** 追加一条消息到面板（同时更新扩展侧的历史） */
function pushChat(role: 'user' | 'assistant' | 'error', content: string): void {
  chatDisplay.push({
    role,
    text: content,
    html: renderMarkdown(content),
    at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  });
  chatPanel?.setMessages(chatDisplay);
}

async function openChatPanel(context: vscode.ExtensionContext, level?: Level): Promise<void> {
  const lv = level ?? resolveAnyLevel();
  if (!chatPanel) {
    chatPanel = ChatPanel.show(context.extensionUri, {
      onAsk: (text) => askQuestion(text, context),
      onClear: () => {
        chatHistory = [];
        chatDisplay = [];
        chatPanel?.setMessages([]);
        void vscode.window.showInformationMessage('对话已清空。');
      },
      onExport: () => exportChat(context),
    });
  }
  chatPanel.setContext(chatContextLabel(lv));
  chatPanel.setMessages(chatDisplay);
  chatPanel.reveal();
}

async function askQuestion(text: string, context: vscode.ExtensionContext): Promise<void> {
  const cfg = readConfig();
  const question = text.trim();
  if (!question) {
    return;
  }

  pushChat('user', question);

  if (!aiReady(cfg)) {
    pushChat('error', '还没配置 API Key。先执行「配置 API Key 与模型」，我才能回答。');
    return;
  }

  const level = resolveAnyLevel();
  const code = level ? await readLevelCode(context, level) : '';

  chatPanel?.setBusy(true, 'AI 正在思考…');
  try {
    const terminal = cfg.terminalContext ? terminalRecorder.context(2000) : '';
    const answer = await askAssistant(
      level,
      code,
      chatHistory,
      question,
      aiTaskOptions(cfg),
      terminal
    );
    chatHistory.push({ role: 'user', content: question });
    chatHistory.push({ role: 'assistant', content: answer });
    // 历史别无限增长：只留最近 10 轮，控制 token 开销
    if (chatHistory.length > 20) {
      chatHistory = chatHistory.slice(-20);
    }
    pushChat('assistant', answer);
  } catch (err) {
    const advice = aiErrorAdvice(err);
    aiLog.appendLine(`[问答失败] ${advice}`);
    pushChat('error', `这次没答上来：${advice}`);
  } finally {
    chatPanel?.setBusy(false);
  }
}

async function exportChat(context: vscode.ExtensionContext): Promise<void> {
  if (!chatDisplay.length) {
    void vscode.window.showInformationMessage('还没有对话可以导出。');
    return;
  }
  const who = (r: string): string => (r === 'user' ? '我' : r === 'error' ? '（出错）' : 'AI 助教');
  const body = [
    `# AI 助教对话记录`,
    '',
    `导出时间：${new Date().toLocaleString()}　　**模型**：${readConfig().model}`,
    '',
    '---',
    '',
    ...chatDisplay.map((m) => `## ${who(m.role)} · ${m.at}\n\n${m.text}\n`),
  ].join('\n');

  const file = path.join(stateDir(context), 'ai-chat.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showInformationMessage('对话已导出到 .pythoncamp/ai-chat.md');
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
    case 'submitPending':
      await submitPendingLevels(context);
      break;
    case 'runLevel': {
      const lv = curriculum.get(msg.levelId);
      if (lv) {
        currentLevelId = lv.id;
        await runLevel(lv, context);
      }
      break;
    }
    case 'answerLevel': {
      const lv = curriculum.get(msg.levelId);
      if (lv) {
        currentLevelId = lv.id;
        await explainLevel(lv, context);
      }
      break;
    }
    case 'solutionsLevel': {
      const lv = curriculum.get(msg.levelId);
      if (lv) {
        currentLevelId = lv.id;
        await multipleSolutions(lv, context);
      }
      break;
    }
    case 'askLevel': {
      const lv = curriculum.get(msg.levelId);
      if (lv) {
        currentLevelId = lv.id;
      }
      await openChatPanel(context, lv);
      break;
    }
    case 'ask':
      await openChatPanel(context);
      break;
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
      await vscode.commands.executeCommand('pythonCamp.openConfig');
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
