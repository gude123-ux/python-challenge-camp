/**
 * terminal.ts —— 集成终端记录（Shell Integration API）
 *
 * 为什么需要这一层：
 *   课程材料里相当一部分练习是「在终端里敲一条命令，观察输出」——
 *   例如 `python -c "print(2026 - 2000, 10 / 4, 10 // 4)"`、
 *   `pip list`、`python 第02关.py`。
 *   这类证据**只存在于终端里**，学生那个 .py 文件本身当然体现不出来。
 *
 *   早期版本只把「插件自己跑这个 .py 文件的结果」交给 AI，
 *   于是 AI 看到代码里没有相关命令，就判「练习未完成」并扣分 ——
 *   学生明明在终端里做过了，分数却低（用户实测反馈的问题）。
 *
 * 做法：
 *   用 VS Code 1.93+ 的 Shell Integration API 监听集成终端里**由学生手动执行**的命令，
 *   连同它的输出一起放进一个环形缓冲，批改 / 报错分析 / 问答时作为「真实证据」喂给模型。
 *
 * 隐私：
 *   1. **只读取与 Python 相关的命令**（python / pip / conda / jupyter 等）的输出，
 *      其它命令（git、ssh、curl…）连输出都不会进内存，更不会外发；
 *   2. 缓冲区只保留最近若干条，且每条截断；
 *   3. 只有学生主动点「提交并批改 / 分析报错 / 问 AI」时才会随请求发给模型。
 *
 * 兼容性：
 *   Shell Integration API 需要 VS Code 1.93 及以上。低版本或未启用 shell integration 时
 *   本模块静默降级为空记录（功能照常，只是拿不到终端证据）。
 */

import * as vscode from 'vscode';
import type { Level } from './types';

export interface TerminalEntry {
  /** 终端名字（如 "python" / "pwsh"） */
  terminal: string;
  /** 学生敲的那一行命令 */
  command: string;
  /** 命令的输出（已去掉 ANSI 控制码、已截断） */
  output: string;
  /** 采集时间戳 */
  at: number;
  /** 退出码（结束时才有） */
  exitCode?: number;
}

/** 环形缓冲最多保留多少条命令 */
const MAX_ENTRIES = 12;
/** 单条命令的输出上限（字符） */
const MAX_OUTPUT = 4000;
/** 送进提示词的终端记录上限（字符） */
export const DEFAULT_CONTEXT_CHARS = 3000;

/**
 * 「与 Python 相关」的判定。
 *
 * 用保守的白名单而不是「排除法」：宁可少收几条，也不要把
 * `git remote add origin https://user:token@…` 这类输出收进来。
 */
const PY_HINT =
  /(^|[\s/\\"'&|(])(python[\d.]*|py|pip[\d.]*|conda|mamba|poetry|uv|jupyter|ipython|pytest)(\.exe)?(\s|$|["'])/i;

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return (text ?? '').replace(ANSI_RE, '');
}

export function isPythonRelated(entry: TerminalEntry): boolean {
  return PY_HINT.test(entry.command ?? '');
}

function clip(text: string, max = MAX_OUTPUT): string {
  const t = text ?? '';
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max)}\n…（输出过长，已截断）`;
}

/**
 * 把终端记录格式化成给模型看的一段文本。
 *
 * 没有可用记录时返回空串 —— 调用方据此决定「要不要往提示词里加这一节」，
 * 避免给模型塞一段空标题让它自由发挥。
 */
export function formatTerminalContext(
  entries: TerminalEntry[],
  maxChars = DEFAULT_CONTEXT_CHARS
): string {
  const relevant = entries.filter(isPythonRelated);
  if (!relevant.length) {
    return '';
  }

  const blocks: string[] = [];
  // 从最近往前取，保证「最新的一次运行」一定在里面
  const picked = relevant.slice(-6);
  for (const e of picked) {
    const out = stripAnsi(e.output ?? '').trim();
    const head = `$ ${e.command}`;
    blocks.push(out ? `${head}\n${out}` : `${head}\n（无输出）`);
  }

  let body = blocks.join('\n\n');
  if (body.length > maxChars) {
    body = `${body.slice(body.length - maxChars)}\n…（更早的记录已省略）`;
  }

  return [
    `【学生在集成终端里执行过的命令与输出（共 ${picked.length} 条，最新在最下）】`,
    body,
  ].join('\n');
}

export interface TerminalEvidence {
  /** 终端里确实执行过与本关相关的命令 */
  ran: boolean;
  /** 至少有一次执行没有 traceback 且有输出（看起来跑通了） */
  clean: boolean;
  /** 出现过 traceback */
  failed: boolean;
}

/**
 * 判断终端记录里有没有「这一关」的运行证据。
 *
 * 匹配命令里的关卡文件名（第02关 / 第2关）或关卡 ID（L02）——
 * 学生在终端里多半是这么敲的：`python 第02关_变量与数据类型.py`。
 */
export function analyzeTerminalForLevel(
  entries: TerminalEntry[],
  level: Pick<Level, 'id' | 'day'>
): TerminalEvidence {
  const day = String(level.day);
  const needles = [`第${day.padStart(2, '0')}关`, `第${day}关`, level.id, level.id.toLowerCase()];
  const rel = entries.filter(
    (e) => isPythonRelated(e) && needles.some((n) => (e.command ?? '').includes(n))
  );
  if (!rel.length) {
    return { ran: false, clean: false, failed: false };
  }
  const failed = rel.some((e) => /Traceback \(most recent call last\)/.test(e.output ?? ''));
  const clean = rel.some(
    (e) =>
      !/Traceback \(most recent call last\)/.test(e.output ?? '') &&
      stripAnsi(e.output ?? '').trim().length > 0 &&
      (e.exitCode === undefined || e.exitCode === 0)
  );
  return { ran: true, clean, failed };
}

/**
 * 终端记录器。
 *
 * 生命周期跟着扩展走：activate 时 start()，dispose 时释放监听。
 * API 不存在时 `available` 为 false，`context()` 恒返回空串。
 */
export class TerminalRecorder {
  private entries: TerminalEntry[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private enabled = true;
  private available = false;

  /** 是否真的能采集（VS Code 版本够 + shell integration 可用） */
  get supported(): boolean {
    return this.available;
  }

  /** 已采集到的（与 Python 相关的）命令条数 */
  get count(): number {
    return this.entries.length;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) {
      this.entries = [];
    }
  }

  start(): void {
    const win = (vscode.window ?? {}) as unknown as {
      onDidStartTerminalShellExecution?: (cb: (e: any) => void) => vscode.Disposable;
      onDidEndTerminalShellExecution?: (cb: (e: any) => void) => vscode.Disposable;
    };
    if (typeof win.onDidStartTerminalShellExecution !== 'function') {
      // VS Code < 1.93：没有这个 API，静默降级
      return;
    }
    this.available = true;

    this.disposables.push(
      win.onDidStartTerminalShellExecution((e: any) => {
        void this.capture(e);
      })
    );

    if (typeof win.onDidEndTerminalShellExecution === 'function') {
      this.disposables.push(
        win.onDidEndTerminalShellExecution((e: any) => {
          this.recordExit(e);
        })
      );
    }
  }

  /** 最近一次采集到的命令（UI 用来提示"已读取终端记录"） */
  lastCommand(): string | undefined {
    return this.entries.length ? this.entries[this.entries.length - 1].command : undefined;
  }

  /** 组装给模型的终端上下文；没有记录或功能关闭时返回空串 */
  context(maxChars = DEFAULT_CONTEXT_CHARS): string {
    if (!this.enabled) {
      return '';
    }
    return formatTerminalContext(this.entries, maxChars);
  }

  /** 本关在终端里的运行证据 */
  evidenceFor(level: Pick<Level, 'id' | 'day'>): TerminalEvidence {
    if (!this.enabled) {
      return { ran: false, clean: false, failed: false };
    }
    return analyzeTerminalForLevel(this.entries, level);
  }

  private async capture(e: any): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const command = String(e?.execution?.commandLine?.value ?? e?.execution?.commandLine ?? '').trim();
    if (!command) {
      return;
    }

    const entry: TerminalEntry = {
      terminal: String(e?.terminal?.name ?? '终端'),
      command,
      output: '',
      at: Date.now(),
    };
    // 与 Python 无关的命令：不进缓冲（隐私优先，见文件头说明）
    if (!isPythonRelated(entry)) {
      return;
    }

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }

    try {
      const stream = e?.execution?.read?.();
      if (!stream) {
        return;
      }
      for await (const chunk of stream) {
        if (!this.enabled) {
          break;
        }
        entry.output += String(chunk ?? '');
        if (entry.output.length > MAX_OUTPUT) {
          entry.output = clip(entry.output);
          break;
        }
      }
      entry.output = clip(stripAnsi(entry.output));
    } catch {
      // 终端被关掉 / 流中断：保留已经拿到的部分
    }
  }

  private recordExit(e: any): void {
    const command = String(e?.execution?.commandLine?.value ?? e?.execution?.commandLine ?? '').trim();
    const code = typeof e?.exitCode === 'number' ? e.exitCode : undefined;
    if (!command || code === undefined) {
      return;
    }
    // 从后往前找同一条命令
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].command === command) {
        this.entries[i].exitCode = code;
        return;
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.length = 0;
    this.entries = [];
  }
}
