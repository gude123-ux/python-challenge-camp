/**
 * html.ts —— Webview 共享样式与工具
 *
 * 全部颜色走 VS Code 主题变量，因此浅色/深色主题自动适配，不需要写两套。
 */

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Webview 里 <script> 注入 JSON 时防止 </script> 截断 */
export function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export const BASE_CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 10px 10px 24px;
  font-family: var(--vscode-font-family);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--vscode-foreground);
  background: transparent;
}
h1, h2, h3, h4 { margin: 0; font-weight: 600; }
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }
.muted { color: var(--vscode-descriptionForeground); }
.mono { font-family: var(--vscode-editor-font-family, monospace); }

.card {
  background: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
  border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25));
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 10px;
}
.section-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600; letter-spacing: .3px;
  margin: 14px 0 8px; text-transform: none;
}
.section-title .count { color: var(--vscode-descriptionForeground); font-weight: 400; }
hr.sep { border: 0; border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); margin: 12px 0; }

button {
  font-family: inherit; font-size: 11.5px; cursor: pointer;
  border-radius: 5px; padding: 4px 10px; border: 1px solid transparent;
  background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.2));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }
button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: .45; cursor: not-allowed; }
button.tiny { padding: 2px 7px; font-size: 11px; }

.badge {
  display: inline-block; padding: 1px 6px; border-radius: 999px;
  font-size: 10.5px; line-height: 1.6; white-space: nowrap;
}
.badge.locked { background: rgba(127,127,127,.18); color: var(--vscode-descriptionForeground); }
.badge.open   { background: rgba(90,150,230,.20); color: var(--vscode-textLink-foreground); }
.badge.pass   { background: rgba(60,170,110,.22); color: var(--vscode-charts-green, #3caa6e); }
.badge.warn   { background: rgba(220,150,40,.22); color: var(--vscode-charts-orange, #d99628); }
.badge.fail   { background: rgba(220,80,80,.20); color: var(--vscode-charts-red, #dc5050); }
/* 「写了代码但没提交」—— 用醒目的橙黄，和「可挑战」区分开 */
.badge.todo   { background: rgba(220,150,40,.26); color: var(--vscode-charts-orange, #d99628); font-weight: 600; }

.stars { color: var(--vscode-charts-orange, #d99628); letter-spacing: -1px; }

.bar { height: 6px; border-radius: 3px; background: rgba(127,127,127,.22); overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--vscode-progressBar-background, #2f7fe0); }

.kv { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
.kv .v { font-weight: 600; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3));
  border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer;
  background: transparent; color: var(--vscode-foreground);
}
.chip:hover { border-color: var(--vscode-focusBorder, #2f7fe0); }
.chip.locked { opacity: .5; cursor: not-allowed; }
.chip.pass { border-color: rgba(60,170,110,.6); }
.chip.open { border-color: rgba(90,150,230,.6); }

details.chapter { margin-bottom: 6px; }
details.chapter > summary {
  cursor: pointer; list-style: none; padding: 5px 6px; border-radius: 6px;
  display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 11.5px;
}
details.chapter > summary::-webkit-details-marker { display: none; }
details.chapter > summary:hover { background: rgba(127,127,127,.12); }
details.chapter[open] > summary { background: rgba(127,127,127,.08); }
details.chapter .levels { padding: 4px 0 4px 6px; }

.level-row {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 6px;
  border-radius: 6px; cursor: pointer;
}
.level-row:hover { background: rgba(127,127,127,.12); }
.level-row .no {
  flex: 0 0 30px; font-size: 10.5px; color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace); padding-top: 1px;
}
.level-row .body { flex: 1 1 auto; min-width: 0; }
.level-row .t { font-weight: 600; font-size: 11.5px; }
.level-row .sub { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.level-row .acts { flex: 0 0 auto; display: flex; gap: 4px; }
.level-row.locked { opacity: .55; }

.todo { display: flex; flex-direction: column; gap: 8px; }
.todo .item {
  border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25));
  border-left: 3px solid var(--vscode-progressBar-background, #2f7fe0);
  border-radius: 6px; padding: 8px; background: rgba(127,127,127,.05);
}
.todo .item.done { border-left-color: var(--vscode-charts-green, #3caa6e); }
.todo .item .hd { display: flex; justify-content: space-between; gap: 6px; align-items: center; }
.todo .item .btns { display: flex; gap: 5px; margin-top: 7px; }

.score-hero { display: flex; align-items: baseline; gap: 8px; }
.score-hero .big { font-size: 30px; font-weight: 700; line-height: 1; }
.score-hero .big.pass { color: var(--vscode-charts-green, #3caa6e); }
.score-hero .big.fail { color: var(--vscode-charts-red, #dc5050); }

.spark { display: flex; align-items: flex-end; gap: 2px; height: 42px; margin-top: 6px; }
.spark .b { flex: 1 1 0; background: var(--vscode-progressBar-background, #2f7fe0); border-radius: 2px 2px 0 0; min-height: 2px; }
.spark .b.empty { background: rgba(127,127,127,.25); }

ul.tight { margin: 4px 0 0; padding-left: 18px; }
ul.tight li { margin-bottom: 4px; }
pre.code {
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12));
  border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25));
  border-radius: 6px; padding: 8px; overflow-x: auto; margin: 6px 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px; line-height: 1.5; white-space: pre;
}
.taglist { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.taglist .t { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; background: rgba(127,127,127,.18); }

/* 行内代码：只作用于 <code>，pre.code 里的代码块另有样式 */
code {
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.14));
  padding: 1px 4px; border-radius: 3px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px;
}
.md p { margin: 6px 0; }
.md h3, .md h4, .md h5 { margin: 12px 0 6px; }
.md ul, .md ol { margin: 6px 0; padding-left: 20px; }
.md li { margin-bottom: 3px; }
`;

export function webviewHtml(opts: {
  cspSource: string;
  nonce: string;
  title: string;
  style: string;
  body: string;
  script: string;
}): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${opts.cspSource} 'unsafe-inline'; script-src 'nonce-${opts.nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(opts.title)}</title>
<style>${BASE_CSS}${opts.style}</style>
</head>
<body>
${opts.body}
<script nonce="${opts.nonce}">${opts.script}</script>
</body>
</html>`;
}

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * 极简 Markdown → HTML。
 *
 * 为什么自己写而不装 markdown-it：本插件坚持**运行时零第三方依赖**。
 * 这里只需要覆盖 AI 回答里真正会出现的结构 —— 代码块、标题、列表、
 * 粗体、行内代码、分隔线 —— 不追求完整实现 Markdown 规范。
 *
 * 所有文本都先过 escapeHtml，因此模型输出里的 <script> 之类不会被执行。
 */
export function renderMarkdown(md: string): string {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let i = 0;

  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const lang = fence[1];
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      out.push(
        `<pre class="code" data-lang="${escapeHtml(lang)}">${escapeHtml(buf.join('\n'))}</pre>`
      );
      continue;
    }

    // 标题（整体降两级：# → h3，避免和面板标题打架）
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lv = Math.min(h[1].length + 2, 6);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      out.push('<hr class="sep" />');
      i += 1;
      continue;
    }

    // 无序列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      i += 1;
      continue;
    }

    // 有序列表
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i += 1;
      continue;
    }

    if (!line.trim()) {
      closeList();
      i += 1;
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }

  closeList();
  return out.join('\n');
}
