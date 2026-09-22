/**
 * config.ts —— 插件设置读取
 */

import * as vscode from 'vscode';

export interface CampConfig {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  enableAI: boolean;
  passScore: number;
  dailyTaskCount: number;
  allowSkipLevels: boolean;
  pythonPath: string;
  autoRunBeforeGrade: boolean;
  runTimeoutSec: number;
  trackStudyTime: boolean;
  strictMode: boolean;
}

export function readConfig(): CampConfig {
  const c = vscode.workspace.getConfiguration('pythonCamp');
  return {
    apiKey: (c.get<string>('apiKey') ?? '').trim(),
    apiBaseUrl: (c.get<string>('apiBaseUrl') ?? 'https://api.deepseek.com/v1').trim(),
    model: (c.get<string>('model') ?? 'deepseek-chat').trim(),
    enableAI: c.get<boolean>('enableAI') ?? true,
    passScore: c.get<number>('passScore') ?? 60,
    dailyTaskCount: c.get<number>('dailyTaskCount') ?? 3,
    allowSkipLevels: c.get<boolean>('allowSkipLevels') ?? false,
    pythonPath: (c.get<string>('pythonPath') ?? 'python').trim() || 'python',
    autoRunBeforeGrade: c.get<boolean>('autoRunBeforeGrade') ?? true,
    runTimeoutSec: c.get<number>('runTimeoutSec') ?? 20,
    trackStudyTime: c.get<boolean>('trackStudyTime') ?? true,
    strictMode: c.get<boolean>('strictMode') ?? false,
  };
}

/** AI 是否真的可用（开关打开 + 配了 Key） */
export function aiReady(cfg: CampConfig): boolean {
  return cfg.enableAI && cfg.apiKey.length > 0;
}
