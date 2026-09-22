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
  /** 单次调用允许模型输出的最大 token 数 */
  maxTokens: number;
  /** 模型响应超时（秒）。推理模型需要给足时间。 */
  aiTimeoutSec: number;
  /** 返回的 JSON 结构损坏时是否自动重试一次 */
  retryOnBadJson: boolean;
  /** 本地运行失败后是否自动让 AI 分析报错原因 */
  autoDiagnoseOnError: boolean;
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
    maxTokens: c.get<number>('maxTokens') ?? 4000,
    aiTimeoutSec: c.get<number>('aiTimeoutSec') ?? 120,
    retryOnBadJson: c.get<boolean>('retryOnBadJson') ?? true,
    autoDiagnoseOnError: c.get<boolean>('autoDiagnoseOnError') ?? true,
  };
}

/** AI 是否真的可用（开关打开 + 配了 Key） */
export function aiReady(cfg: CampConfig): boolean {
  return cfg.enableAI && cfg.apiKey.length > 0;
}
