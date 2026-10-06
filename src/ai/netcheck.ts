/**
 * netcheck.ts —— 「AI 服务连不上 / 很慢」的分层诊断
 *
 * 为什么需要它：用户报「网关不能用了，但网站和视频都能看」时，光看错误信息
 * （`fetch failed` / 超时 / 502）分不清是本地网络、DNS、TLS、代理，还是服务端过载。
 * 这个模块把一次调用拆成可测量的几步，逐层给出耗时与结论：
 *
 *   ① DNS 解析        → 域名是否解析得出来（ENOTFOUND 就是 DNS/域名问题）
 *   ② TLS 握手        → 能不能建安全连接、握手多慢（慢=链路/对端拥塞）
 *   ③ 基线对比        → 同时测一个公认可达的站点（api.github.com），区分「你网络的问题」和「他服务的问题」
 *   ④ 小请求(8 token) → 端点是否活着、鉴权是否正确
 *   ⑤ 真实尺寸请求    → 用本关的批改提示词压一次，量出「真正干活时要等多久」
 *
 * 全部用 Node 内置 fetch / tls / dns，不引入依赖。
 */

import { promises as dns } from 'dns';
import * as tls from 'tls';

export interface NetCheckStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface NetCheckReport {
  target: string;
  steps: NetCheckStep[];
  /** 一句话结论 */
  verdict: string;
  /** 给用户看的下一步建议 */
  advice: string[];
}

export interface NetCheckOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单步超时（秒） */
  timeoutSec?: number;
  /** 真实尺寸请求的提示词（不给就跳过第 ⑤ 步） */
  realPromptChars?: number;
  /** 真实请求要发的消息（可选，用于第 ⑤ 步） */
  realMessages?: Array<{ role: string; content: string }>;
  /** 基线对比用的主机 */
  baselineHost?: string;
}

/** 解析 baseUrl 得到 chat/completions 地址（与 client.ts 的规则一致） */
export function endpointOf(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) {
    return base;
  }
  if (/\/v\d+$/.test(base)) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

/** TLS 握手计时（成功/失败都返回，不抛） */
export function tlsHandshake(host: string, timeoutMs = 12000): Promise<NetCheckStep> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ name: `TLS 握手 ${host}`, ok, ms: Date.now() - t0, detail });
    };
    try {
      const sock = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
        const cn = sock.getPeerCertificate()?.subject?.CN ?? '未知';
        finish(true, `${sock.getProtocol()} · 证书 CN=${cn}`);
        sock.end();
      });
      sock.on('timeout', () => {
        finish(false, `超时 >${Math.round(timeoutMs / 1000)} 秒`);
        sock.destroy();
      });
      sock.on('error', (e: any) => {
        finish(false, `${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 80)}`);
      });
    } catch (e: any) {
      finish(false, String(e?.message ?? e));
    }
  });
}

async function dnsStep(host: string): Promise<NetCheckStep> {
  const t0 = Date.now();
  try {
    const addrs = await dns.lookup(host, { all: true });
    return {
      name: `DNS 解析 ${host}`,
      ok: addrs.length > 0,
      ms: Date.now() - t0,
      detail: addrs.map((a) => `${a.address}/${a.family === 6 ? 'IPv6' : 'IPv4'}`).join(', '),
    };
  } catch (e: any) {
    return {
      name: `DNS 解析 ${host}`,
      ok: false,
      ms: Date.now() - t0,
      detail: `${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 80)}`,
    };
  }
}

async function apiStep(
  name: string,
  url: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  timeoutMs: number
): Promise<NetCheckStep> {
  const t0 = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
      signal: controller.signal,
    });
    const text = await res.text();
    let finish = '';
    let chars = text.length;
    try {
      const j = JSON.parse(text);
      finish = j?.choices?.[0]?.finish_reason ?? '';
      chars = (j?.choices?.[0]?.message?.content ?? '').length;
    } catch {
      /* 非 JSON（例如 Cloudflare 的错误页） */
    }
    const ms = Date.now() - t0;
    if (!res.ok) {
      return {
        name,
        ok: false,
        ms,
        detail: `HTTP ${res.status}${text.includes('Bad gateway') ? '（网关 502：源站过载/不可用）' : ''} ${text.slice(0, 120).replace(/\s+/g, ' ')}`,
      };
    }
    return {
      name,
      ok: true,
      ms,
      detail: `HTTP 200 · 正文 ${chars} 字符 · finish=${finish || '未知'}`,
    };
  } catch (e: any) {
    const cause = e?.cause ? ` / ${e.cause.code ?? e.cause.message}` : '';
    return {
      name,
      ok: false,
      ms: Date.now() - t0,
      detail: timedOut
        ? `超时 >${Math.round(timeoutMs / 1000)} 秒（服务端一直没返回完整响应）`
        : `${String(e?.message ?? e).slice(0, 90)}${cause}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 跑一遍完整诊断 */
export async function checkEndpoint(opts: NetCheckOptions): Promise<NetCheckReport> {
  const url = endpointOf(opts.baseUrl);
  const host = new URL(url).hostname;
  const timeoutMs = Math.max(10, opts.timeoutSec ?? 60) * 1000;
  const steps: NetCheckStep[] = [];

  steps.push(await dnsStep(host));
  steps.push(await tlsHandshake(host, Math.min(timeoutMs, 12000)));
  // 基线：区分「本机网络不通」和「只有他这家服务不通」
  steps.push(await tlsHandshake(opts.baselineHost ?? 'api.github.com', Math.min(timeoutMs, 12000)));

  steps.push(
    await apiStep(
      '接口可用性（8 token）',
      url,
      opts.apiKey,
      opts.model,
      [{ role: 'user', content: '只回复 ok' }],
      8,
      timeoutMs
    )
  );

  if (opts.realMessages?.length) {
    steps.push(
      await apiStep(
        `真实尺寸请求（提示词约 ${opts.realPromptChars ?? 0} 字符 / 4000 token 输出）`,
        url,
        opts.apiKey,
        opts.model,
        opts.realMessages,
        4000,
        Math.max(timeoutMs, 180_000)
      )
    );
  }

  return { target: url, steps, ...verdictOf(steps) };
}

/** 根据各步结果给出结论与建议（纯函数，方便单测） */
export function verdictOf(steps: NetCheckStep[]): { verdict: string; advice: string[] } {
  const byName = (kw: string) => steps.find((s) => s.name.includes(kw));
  const dnsS = byName('DNS');
  const apiS = byName('接口可用性');
  const realS = byName('真实尺寸');
  const baseS = byName('api.github.com');

  const advice: string[] = [];

  if (dnsS && !dnsS.ok) {
    advice.push('域名解析失败：检查域名是否拼错、或本机 DNS 有问题（可换 114.114.114.114 / 8.8.8.8 试试）。');
    return { verdict: '不可用：域名解析不出来', advice };
  }
  if (baseS && !baseS.ok && apiS && !apiS.ok) {
    advice.push('连 GitHub 都连不上，说明是本机网络/代理的问题，不是 AI 服务的问题。');
    advice.push('检查是否有代理软件（Clash / v2ray 等）在运行但已失效，或在 VS Code 里设置 http.proxy。');
    return { verdict: '不可用：本机网络整体不通', advice };
  }
  if (apiS && !apiS.ok) {
    const http = /HTTP (\d+)/.exec(apiS.detail)?.[1];
    if (http === '401' || http === '403') {
      advice.push('鉴权失败：API Key 无效或没权限，去服务商后台确认 Key。');
    } else if (http === '404') {
      advice.push('接口或模型名不存在：检查「服务地址」与「模型名」是否配套（很多中转要求 baseUrl 带 /v1）。');
    } else if (http === '429') {
      advice.push('被限流：额度用完或请求太频繁，等一会儿或升级套餐。');
    } else if (http && Number(http) >= 500) {
      advice.push('服务端 5xx（常见 502 Bad gateway）：是**对方源站过载**，与你本机无关 —— 换服务商或过一会儿再试。');
    } else {
      advice.push('请求没成功：先用 curl 或浏览器直接访问这个地址确认；若浏览器能开网页但接口不通，多半是对方把 API 路径单独限了。');
    }
    return { verdict: '不可用：接口请求失败', advice };
  }

  // 接口活着 → 看速度。
  // 阈值按实测校准：8 token 的小请求正常应在 2 秒内，超过 5 秒就算"慢"；
  // 真实尺寸请求（4k 提示词 / 4k 输出）超过 60 秒也算慢 —— 这类服务商很常见，要如实说。
  const slowSmall = apiS && apiS.ms > 5000;
  const slowReal = realS && realS.ms > 60_000;
  if (realS && !realS.ok) {
    advice.push('小请求能通、真实尺寸请求失败/超时：这是**输出太长 + 服务端慢**的组合问题。');
    advice.push('把 pythonCamp.aiTimeoutSec 调大（比如 300），并优先用「按题拆分」的任务（多种解法已拆）。');
    advice.push('如果是推理模型（会输出思维链），换一个非推理模型会快很多。');
    return { verdict: '可用但很慢：真实任务会超时', advice };
  }
  if (slowReal || slowSmall) {
    advice.push(`小请求 ${apiS?.ms ?? 0} ms、真实请求 ${realS?.ms ?? 0} ms —— 服务端响应偏慢（正常小请求应在 2 秒内）。`);
    advice.push('把 pythonCamp.aiTimeoutSec 调到 300 以上；推理模型请换非推理模型。');
    return { verdict: '可用但偏慢：能把活干完，就是等得久', advice };
  }
  advice.push('各项都正常。如果插件里仍偶发失败，多半是服务端瞬时抖动，插件已自动重试。');
  return { verdict: '可用', advice };
}

/** 把报告渲染成可读文本（写进输出面板） */
export function formatReport(report: NetCheckReport): string {
  const lines = [`网络诊断 · ${new Date().toLocaleString()}`, `目标：${report.target}`, ''];
  for (const s of report.steps) {
    lines.push(`${s.ok ? '✓' : '✗'} ${s.name}　${s.ms} ms　${s.detail}`);
  }
  lines.push('', `结论：${report.verdict}`);
  for (const a of report.advice) {
    lines.push(`  · ${a}`);
  }
  return lines.join('\n');
}
