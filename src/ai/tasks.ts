/**
 * tasks.ts —— 讲解类的长文本 AI 任务
 *
 * 与 grader.ts 的分工：
 *   grader.ts —— 批改。要求模型返回 JSON，核心难点是**解析与容错**。
 *   tasks.ts  —— 讲解类任务。产出是给人看的 Markdown，**不需要解析**，
 *                直接落盘或渲染进面板。失败模式也简单得多（只是没有结果）。
 *
 * 所有任务都复用 client.ts 的 chat()，因此 max_tokens、超时、
 * 截断检测、错误分类这些能力自动共享。
 */

import { chat, type ChatMessage } from './client';
import {
  buildAnswerMessages,
  buildAlternativeSolutionsMessages,
  buildAskMessages,
  buildErrorMessages,
} from './prompt';
import type { Level, RunResult } from '../core/types';

export interface TextTaskOptions {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  /** 单次调用允许模型输出的最大 token 数 */
  maxTokens?: number;
  /** 模型响应超时（秒） */
  timeoutSec?: number;
  /** 5xx / 网络错误时额外重试几次（默认 1） */
  retryTransient?: number;
}

/** 长文本任务的默认预算：比批改宽得多（要写多道题的思路 + 代码） */
const LONG_FORM_TOKENS = 8000;
const LONG_FORM_TIMEOUT_SEC = 240;

async function runTask(
  messages: ChatMessage[],
  opts: TextTaskOptions,
  temperature: number,
  defaultMaxTokens = LONG_FORM_TOKENS,
  defaultTimeoutSec = LONG_FORM_TIMEOUT_SEC
): Promise<string> {
  const reply = await chat({
    baseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    messages,
    temperature,
    // 取「设置值」与「长文本下限」的较大者。
    // 设置里的 maxTokens 默认 4000 是给**批改**调的，而讲解类任务要写
    // 3 道题的思路 + 代码 + 易错点，4000 很容易被截断 ——
    // 截断比多花点 token 糟糕得多，而且这些任务都是用户主动触发的。
    maxTokens: Math.max(opts.maxTokens ?? 0, defaultMaxTokens),
    timeoutMs: (opts.timeoutSec ?? defaultTimeoutSec) * 1000,
    retryTransient: opts.retryTransient,
  });
  return reply.content.trim();
}

/** 本关参考答案与讲解（Markdown） */
export async function generateLevelAnswer(level: Level, opts: TextTaskOptions): Promise<string> {
  return runTask(buildAnswerMessages(level) as ChatMessage[], opts, 0.3);
}

/**
 * 报错原因分析（Markdown）。
 *
 * 只在本地运行**失败**时才有意义 —— 所以 run 一般是有的，
 * 但保留 null 分支以防「解释一个逻辑错误而非语法错误」的场景。
 *
 * terminal：学生在集成终端里的命令与输出。学生自己跑出来的 traceback
 * 往往比插件跑的那次更贴近他的实际操作（例如他跑的是别的文件名、或改了参数），
 * 有了它模型才不会"分析错对象"。
 */
export async function generateErrorDiagnosis(
  level: Level,
  code: string,
  run: RunResult | null,
  opts: TextTaskOptions,
  terminal?: string | null
): Promise<string> {
  return runTask(
    buildErrorMessages({ level, code, run, terminal }) as ChatMessage[],
    opts,
    0.2
  );
}

/** 同一道题的多种解法（Markdown） */
export async function generateAlternativeSolutions(
  level: Level,
  opts: TextTaskOptions
): Promise<string> {
  return runTask(buildAlternativeSolutionsMessages(level) as ChatMessage[], opts, 0.4);
}

/**
 * 多轮问答。
 *
 * history 只放**历史对话**（user/assistant 交替），当前问题单独传，
 * 关卡与代码上下文由 buildAskMessages 拼进 system ——
 * 这样多轮下来模型始终知道学生在做哪一关、手上是什么代码。
 */
export async function askAssistant(
  level: Level | undefined,
  code: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  question: string,
  opts: TextTaskOptions,
  terminal?: string | null
): Promise<string> {
  const messages = buildAskMessages({ level, code, history, question, terminal }) as ChatMessage[];
  // 问答要的是「快而准」，不需要长篇大论
  return runTask(messages, opts, 0.3, 2500, 120);
}
