/**
 * timer.ts —— 学习时长统计
 *
 * 计时口径：VS Code 窗口处于前台，且（打开了 Python 文件 或 闯关面板可见）时才开始计时。
 * 每 30 秒一个心跳，攒够一段时间再落盘，避免频繁写文件。
 */

import * as vscode from 'vscode';
import { ProgressStore } from './store';

const TICK_MS = 30_000;
const FLUSH_MS = 120_000;

export class StudyTimer {
  private timer?: NodeJS.Timeout;
  private lastFlush = Date.now();
  private pendingMs = 0;
  /** 闯关面板是否可见（由侧边栏 provider 维护） */
  panelVisible = false;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ProgressStore,
    private readonly enabled: () => boolean
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (!s.focused) {
          void this.flush();
        }
      })
    );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // 心跳不该阻止宿主进程退出
    this.timer.unref?.();
  }

  private isCounting(): boolean {
    if (!this.enabled() || !vscode.window.state.focused) {
      return false;
    }
    const editor = vscode.window.activeTextEditor;
    const pythonActive = !!editor && editor.document.languageId === 'python';
    return pythonActive || this.panelVisible;
  }

  private async tick(): Promise<void> {
    if (this.isCounting()) {
      this.pendingMs += TICK_MS;
    }
    if (this.pendingMs > 0 && Date.now() - this.lastFlush >= FLUSH_MS) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.pendingMs <= 0) {
      return;
    }
    const ms = this.pendingMs;
    this.pendingMs = 0;
    this.lastFlush = Date.now();
    await this.store.addStudyTime(ms);
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    await this.flush();
  }
}
