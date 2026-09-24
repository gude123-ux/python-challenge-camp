/**
 * client.ts —— OpenAI 兼容的 Chat Completions 客户端
 *
 * 兼容 DeepSeek / OpenAI / 通义 / 本地代理（vLLM、one-api、tokenproxy 等）——
 * 只要它提供 POST {baseUrl}/chat/completions。
 *
 * 只用 Node 内置 fetch，不引入任何第三方依赖。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  /** 模型给出的正文（已归一化为纯字符串） */
  content: string;
  /** 结束原因：stop / length / content_filter ... */
  finishReason?: string;
  /** 推理模型单独返回的思维链（如果有） */
  reasoning?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  model?: string;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'no-key'
      | 'auth'
      | 'not-found'
      | 'rate-limit'
      | 'server'
      | 'network'
      | 'timeout'
      | 'bad-response'
      | 'truncated'
      | 'unknown',
    readonly detail?: string
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** 把各种 baseUrl 写法统一成 chat/completions 端点 */
export function resolveEndpoint(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new AiError('未配置模型服务地址（pythonCamp.apiBaseUrl）', 'no-key');
  }
  if (/\/chat\/completions$/.test(base)) {
    return base;
  }
  if (/\/v\d+$/.test(base)) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

/** 把各种形态的 content 归一化成字符串（有的服务返回 [{type:'text',text:'...'}]） */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part?.text === 'string') {
          return part.text;
        }
        if (typeof part?.content === 'string') {
          return part.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new AiError('未配置 API Key（pythonCamp.apiKey）', 'no-key');
  }
  const endpoint = resolveEndpoint(opts.baseUrl);
  const maxTokens = opts.maxTokens ?? 4000;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  /**
   * ★ 超时必须覆盖「读到完整响应体」为止。
   *
   * 早期实现只在 `await fetch()` 外面挂定时器，一拿到响应头就 `clearTimeout`，
   * 之后的 `res.text()` **完全没有超时保护** —— 于是当服务端（或中间代理）
   * 先回了响应头、然后卡住不再吐数据时，这里会永远挂着：
   * 界面上就是「一直显示正在批改，但永远不出结果」（用户实测反馈的 bug）。
   */
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const timeoutError = () =>
    new AiError(
      `模型响应超时（已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒，上限 ${Math.round(
        timeoutMs / 1000
      )} 秒）。推理模型通常较慢，可在设置里调大 pythonCamp.aiTimeoutSec；` +
        `若经常卡住不动，多半是服务端或中转在响应头之后不再返回数据。`,
      'timeout'
    );

  let res: Response;
  let text: string;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    // 注意：这一句也在定时器的保护范围内（见上面的说明）
    text = await res.text();
  } catch (err: any) {
    if (timedOut || err?.name === 'AbortError') {
      throw timeoutError();
    }
    throw new AiError(
      `无法连接模型服务：${endpoint}`,
      'network',
      String(err?.message ?? err)
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = text.slice(0, 600);
    if (res.status === 401 || res.status === 403) {
      throw new AiError('API Key 无效或没有权限（HTTP 401/403）', 'auth', detail);
    }
    if (res.status === 404) {
      throw new AiError(
        `接口或模型不存在（HTTP 404）。请检查服务地址与模型名：${endpoint} / ${opts.model}`,
        'not-found',
        detail
      );
    }
    if (res.status === 429) {
      throw new AiError('请求过于频繁或额度不足（HTTP 429）', 'rate-limit', detail);
    }
    if (res.status >= 500) {
      throw new AiError(`模型服务内部错误（HTTP ${res.status}）`, 'server', detail);
    }
    throw new AiError(`请求失败（HTTP ${res.status}）`, 'unknown', detail);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError('模型返回的不是合法 JSON', 'bad-response', text.slice(0, 600));
  }

  const choice = json?.choices?.[0];
  const finishReason: string | undefined = choice?.finish_reason ?? choice?.finishReason;
  const content = normalizeContent(choice?.message?.content ?? choice?.text ?? json?.content);
  const reasoning = normalizeContent(
    choice?.message?.reasoning_content ?? choice?.message?.reasoning
  );
  const usage = json?.usage
    ? {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
      }
    : undefined;

  // 被 max_tokens 截断：这时候正文一定是不完整的 JSON，必须明确报出来，
  // 否则用户只会看到「无法解析为 JSON」，根本猜不到要调大 max_tokens。
  if (finishReason === 'length') {
    throw new AiError(
      `模型输出被 max_tokens 截断（当前上限 ${maxTokens} token），返回的 JSON 不完整。` +
        `请在设置里调大 pythonCamp.maxTokens 后重试。`,
      'truncated',
      content.slice(-400)
    );
  }

  if (!content.trim()) {
    if (reasoning.trim()) {
      throw new AiError(
        `模型只返回了思考过程、没有正文，通常也是 max_tokens 被推理过程耗尽（当前上限 ${maxTokens}）。` +
          `请调大 pythonCamp.maxTokens 后重试。`,
        'truncated',
        reasoning.slice(-400)
      );
    }
    throw new AiError('模型返回内容为空', 'bad-response', text.slice(0, 600));
  }

  return {
    content,
    finishReason,
    reasoning: reasoning || undefined,
    usage,
    model: json?.model,
  };
}
