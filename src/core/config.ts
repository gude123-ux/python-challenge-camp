/**
 * config.ts —— 插件设置读取
 *
 * ⚠️ 命名空间提醒：本插件的配置键前缀是 `pythonCamp.`，
 * 而本机曾装过另一个同名插件（publisher 不同）也占用 `pythonCamp.` ——
 * 其中 `pythonCamp.passScore` 两边都声明了，默认值还不一样（我们 60 / 它 80）。
 * 两个插件同时安装时 VS Code 只保留其中一个的默认值，
 * 于是出现「昨天 75 分算过关、今天同样 75 分突然不过关」这种灵异现象（用户实测遇到过）。
 *
 * 所以：**过线键改名为 `passLine`**，彻底避开撞车；
 * 旧键只作为兼容读取（且只认用户显式写入的值）。
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
  /** 是否把集成终端里的 Python 命令与输出作为批改 / 答疑的证据 */
  terminalContext: boolean;
  /** 模型服务返回 5xx / 网络错误时自动重试一次（第三方网关常随机 503） */
  retryOnServerError: boolean;
}

const DEFAULT_PASS_SCORE = 60;

/**
 * 读过关线。
 *
 * 先看新键 `passLine`；没设置过时再看旧键 `passScore` ——
 * 但旧键必须用 `inspect()` 取「用户显式写入的值」，
 * 不能用 `get()`：后者会把**另一个同名插件声明的默认值**当成我们的默认值读进来。
 */
function readPassLine(c: vscode.WorkspaceConfiguration): number {
  const now = c.get<number>('passLine');
  if (typeof now === 'number' && Number.isFinite(now)) {
    return now;
  }
  const legacy = c.inspect<number>('passScore');
  const explicit =
    legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue ?? undefined;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit;
  }
  return DEFAULT_PASS_SCORE;
}

export function readConfig(): CampConfig {
  const c = vscode.workspace.getConfiguration('pythonCamp');
  return {
    apiKey: (c.get<string>('apiKey') ?? '').trim(),
    apiBaseUrl: (c.get<string>('apiBaseUrl') ?? 'https://api.deepseek.com/v1').trim(),
    model: (c.get<string>('model') ?? 'deepseek-chat').trim(),
    enableAI: c.get<boolean>('enableAI') ?? true,
    passScore: readPassLine(c),
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
    terminalContext: c.get<boolean>('terminalContext') ?? true,
    retryOnServerError: c.get<boolean>('retryOnServerError') ?? true,
  };
}

/** AI 是否真的可用（开关打开 + 配了 Key） */
export function aiReady(cfg: CampConfig): boolean {
  return cfg.enableAI && cfg.apiKey.length > 0;
}
