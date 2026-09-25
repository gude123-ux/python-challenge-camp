/**
 * paths.ts —— 工作区路径约定
 *
 * 目录约定（全部落在当前工作区内，不上传任何东西）：
 *   <workspace>/python-camp/         学生写代码的地方（每关一个 .py）
 *   <workspace>/.pythoncamp/         插件状态（进度、报告、临时运行文件）
 *       progress.json                闯关进度档案
 *       report.md                    导出的学习报告
 *       tmp/                         本地运行代码用的临时文件
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Level } from '../core/types';

export const WORK_DIR_NAME = 'python-camp';
export const STATE_DIR_NAME = '.pythoncamp';
export const PROGRESS_FILE = 'progress.json';

/** 当前工作区根目录；未打开文件夹时返回 undefined */
export function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

/** 状态目录；无工作区时退回到扩展的 globalStorage */
export function stateDir(context: vscode.ExtensionContext): string {
  const root = workspaceRoot();
  if (root) {
    return path.join(root, STATE_DIR_NAME);
  }
  return context.globalStorageUri.fsPath;
}

/** 学生代码目录 */
export function workDir(context: vscode.ExtensionContext): string {
  const root = workspaceRoot();
  if (root) {
    return path.join(root, WORK_DIR_NAME);
  }
  return path.join(context.globalStorageUri.fsPath, WORK_DIR_NAME);
}

export function progressFilePath(context: vscode.ExtensionContext): string {
  return path.join(stateDir(context), PROGRESS_FILE);
}

export function tmpDir(context: vscode.ExtensionContext): string {
  return path.join(stateDir(context), 'tmp');
}

export function reportFilePath(context: vscode.ExtensionContext): string {
  return path.join(stateDir(context), 'report.md');
}

/** 把关卡标题变成安全的文件名片段 */
export function slugify(text: string, maxLen = 24): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\s]+/g, '_')
    .replace(/[^\p{Script=Han}\w\-_]/gu, '');
  return cleaned.slice(0, maxLen) || 'level';
}

/** 某一关对应的学生代码文件路径 */
export function levelFilePath(context: vscode.ExtensionContext, level: Level): string {
  const name = `第${String(level.day).padStart(2, '0')}关_${slugify(level.title)}.py`;
  return path.join(workDir(context), name);
}

/** 关卡文件在工作区内的相对路径（用于打开文档） */
export function levelFileUri(context: vscode.ExtensionContext, level: Level): vscode.Uri {
  return vscode.Uri.file(levelFilePath(context, level));
}

/** AI 生成的参考答案目录（放在学生代码目录旁边，方便对照） */
export function answerDir(context: vscode.ExtensionContext): string {
  return path.join(workDir(context), '参考答案');
}

/** 某一关的参考答案文件路径（Markdown） */
export function answerFilePath(context: vscode.ExtensionContext, level: Level): string {
  const name = `第${String(level.day).padStart(2, '0')}关_参考答案.md`;
  return path.join(answerDir(context), name);
}

/** 「本关精讲」目录（和参考答案放一起，学生找得到） */
export function tutorialDir(context: vscode.ExtensionContext): string {
  return path.join(workDir(context), '精讲');
}

/** 某一关的「本关精讲」文件路径（Markdown，生成一次永久缓存） */
export function tutorialFilePath(context: vscode.ExtensionContext, level: Level): string {
  const name = `第${String(level.day).padStart(2, '0')}关_精讲.md`;
  return path.join(tutorialDir(context), name);
}

/** 某一关的「多种解法」文件路径（Markdown，与参考答案同目录） */
export function solutionsFilePath(context: vscode.ExtensionContext, level: Level): string {
  const name = `第${String(level.day).padStart(2, '0')}关_多种解法.md`;
  return path.join(answerDir(context), name);
}

export function todayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dateKeyShift(key: string, deltaDays: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + deltaDays);
  return todayKey(dt);
}

/** 毫秒 -> 「1小时23分」 */
export function humanDuration(ms: number): string {
  if (ms <= 0) {
    return '0 分钟';
  }
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) {
    return `${m} 分钟`;
  }
  if (m === 0) {
    return `${h} 小时`;
  }
  return `${h} 小时 ${m} 分`;
}
