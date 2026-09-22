/**
 * chatPanel.ts —— 「随时提问」多轮问答面板
 *
 * 设计取舍：
 *   * 消息的 Markdown 在**扩展侧**用 renderMarkdown 渲染好再发给 webview，
 *     而不是在 webview 里再实现一遍 —— 保证只有一份 Markdown 实现，
 *     而且转义统一走 escapeHtml，模型输出里的 HTML 不会被执行。
 *   * 对话历史保存在扩展侧（模块级），面板被关掉再打开不会丢。
 */

import * as vscode from 'vscode';
import { escapeHtml, makeNonce, webviewHtml } from './html';

export interface ChatMessageModel {
  role: 'user' | 'assistant' | 'error';
  /** 已经渲染并转义好的 HTML（给面板显示用） */
  html: string;
  /** 原始 Markdown 文本（导出对话时用，保留可读格式） */
  text: string;
  at: string;
}

export interface ChatCallbacks {
  onAsk: (text: string) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  onExport: () => void | Promise<void>;
}

const EXTRA_CSS = `
.wrap { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; height: calc(100vh - 20px); }
.hd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; }
.hd h1 { font-size: 15px; }
.hd .ctx { font-size: 11px; color: var(--vscode-descriptionForeground); }
.hd .spacer { margin-left: auto; }

.msgs { flex: 1 1 auto; overflow-y: auto; padding: 4px 2px 8px; }
.msg { display: flex; gap: 8px; margin-bottom: 12px; }
.msg .who {
  flex: 0 0 26px; height: 26px; border-radius: 50%; font-size: 11px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(127,127,127,.2);
}
.msg.user .who { background: rgba(90,150,230,.25); color: var(--vscode-textLink-foreground); }
.msg.assistant .who { background: rgba(60,170,110,.22); color: var(--vscode-charts-green, #3caa6e); }
.msg.error .who { background: rgba(220,80,80,.22); color: var(--vscode-charts-red, #dc5050); }
.msg .body { flex: 1 1 auto; min-width: 0; }
.msg .body .md { word-wrap: break-word; }
.msg .time { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
.msg.user .md { background: rgba(90,150,230,.10); border-radius: 6px; padding: 6px 9px; }
.msg.error .md { background: rgba(220,80,80,.10); border-radius: 6px; padding: 6px 9px; }

.empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 28px 10px; }
.empty .chips { justify-content: center; margin-top: 12px; }

.composer { flex: 0 0 auto; border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); padding-top: 8px; }
.composer textarea {
  width: 100%; min-height: 62px; max-height: 200px; resize: vertical;
  font-family: inherit; font-size: 12.5px; line-height: 1.6;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(127,127,127,.35)));
  border-radius: 6px; padding: 7px 9px;
}
.composer textarea:focus { outline: 1px solid var(--vscode-focusBorder, #2f7fe0); outline-offset: -1px; }
.composer .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.composer .hint { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.composer .row .spacer { margin-left: auto; }

.busy { display: none; align-items: center; gap: 7px; font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.busy.on { display: flex; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-progressBar-background, #2f7fe0); animation: pulse 1s infinite ease-in-out; }
@keyframes pulse { 0%,100% { opacity: .25 } 50% { opacity: 1 } }
`;

export class ChatPanel {
  static readonly viewType = 'pythonCamp.chat';
  private static current: ChatPanel | undefined;

  private disposables: vscode.Disposable[] = [];
  private messages: ChatMessageModel[] = [];
  private contextLabel = '';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly cb: ChatCallbacks
  ) {
    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg: { type?: string; text?: string }) => {
        if (msg?.type === 'ask') {
          await this.cb.onAsk(String(msg.text ?? ''));
        } else if (msg?.type === 'clear') {
          await this.cb.onClear();
        } else if (msg?.type === 'export') {
          await this.cb.onExport();
        }
      },
      null,
      this.disposables
    );
  }

  static show(extensionUri: vscode.Uri, cb: ChatCallbacks): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'AI 助教 · 随时提问',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    ChatPanel.current = new ChatPanel(panel, cb);
    return ChatPanel.current;
  }

  /** 用扩展侧保存的完整历史刷新面板 */
  setMessages(messages: ChatMessageModel[]): void {
    this.messages = messages;
    void this.panel.webview.postMessage({ type: 'messages', messages: this.messages });
  }

  setBusy(busy: boolean, hint = ''): void {
    void this.panel.webview.postMessage({ type: 'busy', busy, hint });
  }

  setContext(label: string): void {
    this.contextLabel = label;
    void this.panel.webview.postMessage({ type: 'context', label });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  dispose(): void {
    ChatPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private render(): string {
    const body = `
<div class="wrap">
  <div class="hd">
    <h1>AI 助教 · 随时提问</h1>
    <span class="ctx" id="ctx">${escapeHtml(this.contextLabel || '（未识别当前关卡）')}</span>
    <span class="spacer"></span>
    <button class="tiny" data-act="export">导出对话</button>
    <button class="tiny" data-act="clear">清空</button>
  </div>

  <div class="msgs" id="msgs"></div>

  <div class="composer">
    <div class="busy" id="busy"><span class="dot"></span><span id="busyText">AI 正在思考…</span></div>
    <textarea id="q" placeholder="问点具体的，比如：这段代码为什么报错？我这个写法有什么问题？（Ctrl+Enter 发送）"></textarea>
    <div class="row">
      <span class="hint">会自动带上你当前关卡和代码作为上下文</span>
      <span class="spacer"></span>
      <button class="primary" data-act="ask" id="send">发送</button>
    </div>
  </div>
</div>`;

    const script = `
(function () {
  var vscode = acquireVsCodeApi();
  var msgsEl = document.getElementById('msgs');
  var qEl = document.getElementById('q');
  var sendEl = document.getElementById('send');
  var busyEl = document.getElementById('busy');
  var busyText = document.getElementById('busyText');
  var ctxEl = document.getElementById('ctx');

  var QUICK = [
    '这段代码为什么报错？',
    '我这个写法有什么问题？',
    '再讲一遍这一关的核心概念',
    '给我一个类似的练习'
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function render(list) {
    if (!list || !list.length) {
      var chips = QUICK.map(function (t) {
        return '<button class="chip" data-quick="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('');
      msgsEl.innerHTML = '<div class="empty">还没有对话。<br />可以点下面的问题快速开始：<div class="chips">' + chips + '</div></div>';
      return;
    }
    msgsEl.innerHTML = list.map(function (m) {
      var who = m.role === 'user' ? '我' : (m.role === 'error' ? '!' : 'AI');
      return '<div class="msg ' + esc(m.role) + '">' +
        '<div class="who">' + who + '</div>' +
        '<div class="body"><div class="md">' + m.html + '</div>' +
        '<div class="time">' + esc(m.at) + '</div></div></div>';
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function setBusy(on, hint) {
    busyEl.classList.toggle('on', !!on);
    if (hint) { busyText.textContent = hint; }
    sendEl.disabled = !!on;
  }

  function ask(text) {
    var t = String(text || '').trim();
    if (!t || sendEl.disabled) { return; }
    vscode.postMessage({ type: 'ask', text: t });
    qEl.value = '';
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act],[data-quick]');
    if (!el) { return; }
    var quick = el.getAttribute('data-quick');
    if (quick) { ask(quick); return; }
    var act = el.getAttribute('data-act');
    if (act === 'ask') { ask(qEl.value); }
    else if (act === 'clear') { vscode.postMessage({ type: 'clear' }); }
    else if (act === 'export') { vscode.postMessage({ type: 'export' }); }
  });

  qEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ask(qEl.value);
    }
  });

  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'messages') { render(m.messages); }
    else if (m.type === 'busy') { setBusy(m.busy, m.hint); }
    else if (m.type === 'context') { ctxEl.textContent = m.label || '（未识别当前关卡）'; }
  });

  render([]);
})();`;

    return webviewHtml({
      cspSource: this.panel.webview.cspSource,
      nonce: makeNonce(),
      title: 'AI 助教 · 随时提问',
      style: EXTRA_CSS,
      body,
      script,
    });
  }
}
