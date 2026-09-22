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

export async function chat(opts: ChatOptions): Promise<string> {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new AiError('未配置 API Key（pythonCamp.apiKey）', 'no-key');
  }
  const endpoint = resolveEndpoint(opts.baseUrl);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
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
        max_tokens: opts.maxTokens ?? 2000,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new AiError(`模型响应超时（>${Math.round(timeoutMs / 1000)} 秒）`, 'timeout');
    }
    throw new AiError(
      `无法连接模型服务：${endpoint}`,
      'network',
      String(err?.message ?? err)
    );
  }
  clearTimeout(timer);

  const text = await res.text();

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

  const content: string | undefined =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    json?.content;

  if (!content || typeof content !== 'string') {
    throw new AiError('模型返回内容为空', 'bad-response', text.slice(0, 600));
  }
  return content;
}
