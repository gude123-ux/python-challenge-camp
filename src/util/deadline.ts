/**
 * deadline.ts —— 「无论如何都要有个结果」的时限工具
 *
 * 为什么需要它：
 *   网络层的超时只能保证**那一次请求**不会挂死。但一条业务流水线里还有别的环节
 *   （本地跑 Python、读写文件、写进度、解析…），任何一环卡住，界面就会停在
 *   「正在批改…」上不动 —— 用户看到的就是"一直转但没结果"。
 *
 *   所以在业务层再加一道**总时限**：到点就抛错，让 UI 一定能收尾
 *   （弹提示、解锁防重入闸门、如实说明"本次不记成绩"）。
 *
 * 注意：这里只负责"不再等"，不负责杀掉底层请求 —— 底层各自的超时会自己收尾。
 */

export class DeadlineError extends Error {
  constructor(readonly label: string, readonly ms: number) {
    super(`${label}超时（已等待 ${Math.round(ms / 1000)} 秒）`);
    this.name = 'DeadlineError';
  }
}

/**
 * 给一个 Promise 套上总时限。
 *
 * @param task  要等的事情
 * @param ms    总时限（毫秒）
 * @param label 超时时提示里用的名字，例如「批改」
 */
export function withDeadline<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return task;
  }
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  return Promise.race([task, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}

/**
 * 带进度回调的等待：每 intervalMs 回调一次「已经等了多久」，
 * 让 UI 能显示"已等待 N 秒"，而不是一句静止的"正在批改"。
 */
export function withTicker<T>(
  task: Promise<T>,
  intervalMs: number,
  onTick: (elapsedMs: number) => void
): Promise<T> {
  const started = Date.now();
  const timer = setInterval(() => onTick(Date.now() - started), intervalMs);
  return task.finally(() => clearInterval(timer));
}
