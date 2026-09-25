/**
 * levelPanel.ts —— 关卡详情页（编辑器区域的 Webview）
 *
 * 一关的内容结构：知识点简述 → 示例代码（复现目标）→ 本关练习 → 验收标准，
 * 底部是操作区（打开代码文件 / 本地运行 / 提交批改）与批改结果。
 */

import * as vscode from 'vscode';
import { makeNonce, webviewHtml } from './html';
import type { LevelDetailModel } from './viewModel';

const EXTRA_CSS = `
.wrap { max-width: 900px; margin: 0 auto; padding: 4px 6px 40px; }
.title-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 4px; }
.title-row h1 { font-size: 19px; line-height: 1.35; }
.meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 12px 0 16px; }
.actions button { padding: 6px 13px; font-size: 12px; }
.actions button.warnbtn { background: rgba(220,80,80,.18); color: var(--vscode-charts-red, #dc5050); }
h3.blk {
  font-size: 13px; margin: 18px 0 8px; padding-left: 9px;
  border-left: 3px solid var(--vscode-focusBorder, #2f7fe0);
}
ol.ex, ul.kn { margin: 0; padding-left: 22px; }
ol.ex li, ul.kn li { margin-bottom: 7px; }
.grade { border-radius: 9px; padding: 12px; margin-top: 16px;
  border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); background: rgba(127,127,127,.05); }
.grade .dims { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: 11.5px; }
.grade .dims b { font-size: 13px; }
.grade h4 { font-size: 12px; margin: 12px 0 4px; }
.tagrow { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.tagrow .t { font-size: 10.5px; padding: 1px 7px; border-radius: 4px; background: rgba(220,150,40,.2); }
.check { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--vscode-panel-border, rgba(127,127,127,.22)); font-size: 11.5px; }
.check:last-child { border-bottom: 0; }
.check .ic { flex: 0 0 16px; font-weight: 700; }
.check .ic.ok { color: var(--vscode-charts-green, #3caa6e); }
.check .ic.no { color: var(--vscode-charts-red, #dc5050); }
.runout { font-size: 11.5px; }
details.acc { margin-top: 10px; }
details.acc > summary { cursor: pointer; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.errbox { border-left: 3px solid var(--vscode-charts-red, #dc5050); background: rgba(220,80,80,.08);
  padding: 8px 10px; border-radius: 0 6px 6px 0; font-size: 11.5px; margin-top: 10px; white-space: pre-wrap; }
.pathbar { font-size: 10.5px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(127,127,127,.1); border-radius: 5px; padding: 5px 8px; margin-top: 8px; word-break: break-all; }
.busy { display: inline-block; margin-left: 8px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.hist { font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.hist .h { padding: 2px 7px; border-radius: 5px; background: rgba(127,127,127,.16); }
.lesson { margin-bottom: 12px; }
.lesson .lh { font-weight: 600; font-size: 12.5px; margin: 8px 0 4px; }
.lesson .lt { font-size: 12.5px; line-height: 1.75; }
.lesson pre.code { margin-top: 6px; }
/* 批改进度：每一步一行，带状态图标 —— 取代过去那句静止的「判分中…」 */
.progbox { border-radius: 9px; padding: 10px 12px; margin-top: 12px;
  border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); background: rgba(127,127,127,.06); }
.progbox .ttl { font-weight: 600; font-size: 12px; margin-bottom: 6px; }
.progbox .steps { font-size: 11.5px; }
.progbox .step { display: flex; gap: 7px; padding: 2px 0; color: var(--vscode-descriptionForeground); }
.progbox .step .ic { flex: 0 0 14px; text-align: center; }
.progbox .step.done { color: var(--vscode-foreground); }
.progbox .step.done .ic { color: var(--vscode-charts-green, #3caa6e); }
.progbox .step.running { color: var(--vscode-foreground); font-weight: 600; }
.progbox .step.failed .ic { color: var(--vscode-charts-red, #dc5050); }
.progbox .note { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.progbox .barwrap { height: 3px; border-radius: 2px; background: rgba(127,127,127,.22); margin-top: 8px; overflow: hidden; }
.progbox .barwrap i { display: block; height: 100%; background: var(--vscode-progressBar-background, #2f7fe0); transition: width .3s; }
/* 前置知识卡片 */
.prq { border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.22)); padding: 8px 0 4px; }
.prq:first-of-type { border-top: 0; }
.prq .ph { font-weight: 600; font-size: 12.5px; }
.prq .pr { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 0 4px; }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
let S = null;
const send = (m) => vscode.postMessage(m);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function stars(n) {
  n = Math.max(0, Math.min(5, n || 0));
  return '<span class="stars">' + '\u2605'.repeat(n) + '\u2606'.repeat(5 - n) + '</span>';
}

function statusBadge() {
  if (S.passed) return '<span class="badge pass">已过关 ' + S.bestScore + ' 分</span>';
  if (S.status === 'locked') return '<span class="badge locked">未解锁</span>';
  if (S.attempts > 0) return '<span class="badge fail">未过关 ' + S.bestScore + ' 分</span>';
  return '<span class="badge open">可挑战</span>';
}

function gradeBlock(g) {
  const cls = g.score >= S.passScore ? 'pass' : 'fail';
  let h = '<div class="grade">' +
    '<div class="score-hero"><span class="big ' + cls + '">' + g.score + '</span>' +
    '<span class="muted">/ 100 分 · 过关线 ' + S.passScore + ' 分 · ' +
    (g.source === 'ai' ? 'AI 批改' : '本地检查') + '</span></div>' +
    '<div class="dims">' +
      '<span>可运行：<b>' + (g.runnable ? '是' : '否') + '</b></span>' +
      '<span>正确性：<b>' + g.correctness + '</b></span>' +
      '<span>代码质量：<b>' + g.quality + '</b></span>' +
    '</div>' +
    (g.terminalUsed
      ? '<div class="muted" style="font-size:11px;margin-top:6px">本次批改已参考你在集成终端里的 Python 命令与输出（终端里做过的练习不会再被当成没做）。</div>'
      : '') +
    '<h4>总评</h4><div>' + esc(g.summary) + '</div>';

  if (g.exerciseChecks && g.exerciseChecks.length) {
    h += '<h4>逐题完成情况</h4>';
    g.exerciseChecks.forEach(function (c) {
      h += '<div class="check"><div class="ic ' + (c.done ? 'ok' : 'no') + '">' + (c.done ? '\u2713' : '\u2717') + '</div>' +
        '<div><b>第 ' + c.index + ' 题</b> ' + esc(c.comment) + '</div></div>';
    });
  }
  if (g.strengths && g.strengths.length) {
    h += '<h4>做得好的地方</h4><ul class="tight">' + g.strengths.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  if (g.issues && g.issues.length) {
    h += '<h4>问题</h4><ul class="tight">' + g.issues.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  if (g.suggestions && g.suggestions.length) {
    h += '<h4>改进建议</h4><ul class="tight">' + g.suggestions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  if (g.weakTags && g.weakTags.length) {
    h += '<h4>薄弱知识点</h4><div class="tagrow">' + g.weakTags.map(function (x) { return '<span class="t">' + esc(x) + '</span>'; }).join('') + '</div>';
  }
  h += '</div>';
  return h;
}

function runBlock(r) {
  if (!r) return '';
  let h = '<details class="acc"><summary>本地运行结果（' +
    (r.ok ? '成功' : '失败') + ' · ' + r.durationMs + ' ms · 退出码 ' + (r.exitCode === null ? '未启动' : r.exitCode) + '）</summary>';
  h += '<div class="runout"><div class="muted" style="margin-top:6px">stdout</div><pre class="code">' + esc(r.stdout || '（无输出）') + '</pre>';
  if (r.stderr) h += '<div class="muted">stderr</div><pre class="code">' + esc(r.stderr) + '</pre>';
  h += '</div></details>';
  return h;
}

// ★ 批改进度：每一步一行 + 进度条 + 已等待秒数。
//   过去只有一句「正在批改…」，卡住时用户完全不知道走到哪一步了。
function progressInner() {
  if (!S.progress || !S.progress.length) return '';
  const done = S.progress.filter(function (x) { return x.state === 'done' || x.state === 'failed' || x.state === 'skipped'; }).length;
  const pct = Math.round(done / S.progress.length * 100);
  let h = '<div class="ttl">批改进度 <span class="muted" style="font-weight:400">' + done + '/' + S.progress.length + '</span></div><div class="steps">';
  S.progress.forEach(function (x) {
    const ic = x.state === 'done' ? '\u2713' : x.state === 'running' ? '\u25CF' : x.state === 'failed' ? '\u2717' : x.state === 'skipped' ? '\u2013' : '\u25CB';
    h += '<div class="step ' + x.state + '"><span class="ic">' + ic + '</span><span>' + esc(x.label) + '</span></div>';
  });
  h += '</div><div class="barwrap"><i style="width:' + pct + '%"></i></div>';
  if (S.progressNote) h += '<div class="note">' + esc(S.progressNote) + '</div>';
  return h;
}

function progressBlock() {
  if (!S.progress || !S.progress.length) return '';
  return '<div class="progbox" id="progbox">' + progressInner() + '</div>';
}

// ★ 前置知识：本地算出来的，永远有 —— 学生的诉求是「用到之前关卡的内容就帮我贴出来」
function prereqBlock() {
  const items = S.prereq || [];
  if (!items.length) return '';
  let h = '<h3 class="blk">需要先会的前置知识</h3><div class="card">';
  h += '<div class="muted" style="font-size:11px;margin-bottom:6px">这一关会用到下面这些内容（都来自前面的关卡）。不熟就先回去看一眼，不用重做。</div>';
  items.forEach(function (x) {
    h += '<div class="prq"><div class="ph">第 ' + x.day + ' 关 · ' + esc(x.title) + '</div>' +
      '<div class="pr">' + esc(x.reason) + '</div>';
    if (x.points && x.points.length) {
      h += '<ul class="kn">' + x.points.map(function (k) { return '<li>' + esc(k) + '</li>'; }).join('') + '</ul>';
    }
    if (x.snippet) h += '<pre class="code">' + esc(x.snippet) + '</pre>';
    h += '<div class="btns"><button class="tiny" data-act="gotoPrereq" data-id="' + x.levelId + '">打开第 ' + x.day + ' 关</button></div></div>';
  });
  h += '</div>';
  return h;
}

// ★ 本关精讲：AI 生成（知识点讲透 + 分步操作 + 逐题分级提示），生成一次永久缓存
function tutorialBlock() {
  if (S.tutorialPending) {
    return '<h3 class="blk">本关精讲</h3><div class="card"><div class="muted">正在生成本关精讲…' +
      '（知识点讲透 + 分步操作 + 逐题提示，推理模型可能要几十秒）</div></div>';
  }
  if (!S.tutorialHtml) {
    return '<h3 class="blk">本关精讲</h3><div class="card">' +
      '<div class="muted" style="font-size:11.5px">还没有这一关的精讲。点下面的按钮让 AI 把' +
      '<b>每个知识点讲透</b>、把<b>每一步该做什么拆开写</b>、并给出<b>逐题提示</b>（不给完整答案）。' +
      '生成一次会永久保存在本地，之后打开就直接显示。</div>' +
      '<div class="btns" style="margin-top:8px"><button class="primary tiny" data-act="tutorial">生成本关精讲</button></div>' +
      '</div>';
  }
  return '<h3 class="blk">本关精讲</h3>' +
    (S.tutorialNote ? '<div class="muted" style="font-size:11px;margin-bottom:6px">' + esc(S.tutorialNote) + '</div>' : '') +
    '<div class="card md">' + S.tutorialHtml + '</div>' +
    '<div class="btns" style="margin-top:6px"><button class="tiny" data-act="tutorial">重新生成精讲</button></div>';
}

function answerBlock() {
  if (S.answerPending) {
    return '<h3 class="blk">参考答案与改进建议</h3><div class="card"><div class="muted">正在生成参考答案…（推理模型可能要几十秒）</div></div>';
  }
  if (!S.answerHtml) return '';
  return '<h3 class="blk">参考答案与改进建议</h3>' +
    (S.answerNote ? '<div class="muted" style="font-size:11px;margin-bottom:6px">' + esc(S.answerNote) + '</div>' : '') +
    '<div class="card md">' + S.answerHtml + '</div>';
}

function render() {
  if (!S) return;
  const L = S.level;
  let h = '<div class="wrap">';
  h += '<div class="title-row"><h1>第 ' + L.day + ' 关 · ' + esc(L.title) + '</h1><div style="margin-left:auto">' + statusBadge() + '</div></div>';
  h += '<div class="meta">' + esc(L.id) + ' · 第 ' + L.chapter + ' 章 ' + esc(S.chapterTitle) + ' · 难度 ' + stars(L.difficulty) +
       ' · 建议 ' + L.estimatedMinutes + ' 分钟 · ' + esc(L.source) + '</div>';

  if (L.goal) h += '<div class="card"><b>今日目标</b><div style="margin-top:4px">' + esc(L.goal) + '</div></div>';

  // 文件里已经有自己写的代码、但一次都没提交过 —— 明确说出来，
  // 免得学生以为「我做了但插件不认」。
  if (S.pendingLines) {
    h += '<div class="card" style="border-left:3px solid var(--vscode-charts-orange,#d99628)">' +
      '<b>这一关你写了 ' + S.pendingLines + ' 行代码，但还没提交过批改</b>' +
      '<div class="muted" style="font-size:11px;margin-top:4px">所以进度里还没有它的成绩。' +
      '点下面的「提交并批改」补上即可 —— 已有的代码不会被改动。</div></div>';
  }

  h += '<div class="actions">' +
    '<button class="primary" data-act="openFile">' + (S.fileExists ? '打开代码文件' : '创建代码文件并开始') + '</button>' +
    '<button data-act="run">本地运行</button>' +
    '<button data-act="submit">提交并批改</button>' +
    '<button data-act="tutorial">本关精讲（怎么做）</button>' +
    '<button data-act="answer">AI 讲解 / 看参考答案</button>' +
    '<button data-act="solutions">多种解法</button>' +
    '<button data-act="ask">问 AI 助教</button>' +
    (S.runFailed ? '<button class="warnbtn" data-act="diagnose">AI 分析报错</button>' : '') +
    (S.prev ? '<button data-act="prev">上一关</button>' : '') +
    (S.next ? '<button data-act="next">下一关</button>' : '') +
    '</div>';

  h += '<div class="pathbar">代码文件：' + esc(S.filePath || '（尚未创建）') + '</div>';

  h += progressBlock();

  // ★ 本关讲解：学生只看这一页就该知道怎么动手。
  //   旧题库的知识点是 PDF 换行切碎的半句，读不懂（用户实测反馈过），
  //   所以这里优先渲染结构化的讲义（小标题 + 完整段落 + 配套代码）。
  const lesson = L.lesson || [];
  if (lesson.length) {
    h += '<h3 class="blk">本关讲解</h3>';
    lesson.forEach(function (b) {
      h += '<div class="lesson">';
      if (b.heading) h += '<div class="lh">' + esc(b.heading) + '</div>';
      if (b.text) h += '<div class="lt">' + esc(b.text) + '</div>';
      if (b.code) h += '<pre class="code">' + esc(b.code) + '</pre>';
      h += '</div>';
    });
  }

  h += '<h3 class="blk">知识点速览</h3><ul class="kn">' +
    L.knowledge.map(function (k) { return '<li>' + esc(k) + '</li>'; }).join('') + '</ul>';

  // 前置知识 → 精讲 → 练习：先知道要会什么，再看怎么做，最后动手
  h += prereqBlock();
  h += tutorialBlock();

  if (L.manualExample) {
    h += '<h3 class="blk">示例代码（照着复现一遍）</h3><pre class="code">' + esc(L.manualExample) + '</pre>' +
      '<div class="muted" style="font-size:11px">这段代码来自你手上的课程材料，先在编辑器里亲手敲一遍并跑通，再去做下面的练习。</div>';
  }

  h += '<h3 class="blk">编程练习题</h3><ol class="ex">' +
    L.exercises.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ol>';

  if (L.accept) h += '<h3 class="blk">验收标准</h3><div class="card">' + esc(L.accept) + '</div>';
  if (L.transfer) h += '<details class="acc"><summary>迁移视角（这个知识点还能用在哪）</summary><div style="margin-top:6px">' + esc(L.transfer) + '</div></details>';

  if (S.attempts > 0) {
    h += '<h3 class="blk">历史成绩</h3><div class="hist">' +
      S.history.map(function (a) {
        const d = (a.at || '').slice(5, 16).replace('T', ' ');
        return '<span class="h">' + d + ' · ' + a.score + ' 分' + (a.source === 'local' ? '（本地）' : '') + '</span>';
      }).join('') + '</div>';
  }

  if (S.diagnosisHtml) {
    h += '<h3 class="blk">AI 报错分析</h3><div class="card md">' + S.diagnosisHtml + '</div>';
  }

  if (S.run) h += runBlock(S.run);
  if (S.grade) h += gradeBlock(S.grade);
  h += answerBlock();
  h += '</div>';
  document.getElementById('root').innerHTML = h;
}

document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');
  if (act === 'gotoPrereq' && id) { send({ type: 'openLevelById', levelId: id }); return; }
  send({ type: act });
});

window.addEventListener('message', function (e) {
  const m = e.data;
  if (!m) return;
  if (m.type === 'state') { S = m.model; render(); }
  // 进度只更新那一小块，避免整页重绘（重绘会丢滚动位置）
  if (m.type === 'progress') {
    if (!S) return;
    S.progress = m.steps;
    S.progressNote = m.note;
    const box = document.getElementById('progbox');
    if (box) {
      if (!m.steps || !m.steps.length) { box.remove(); return; }
      box.innerHTML = progressInner();
    } else {
      render();
    }
  }
  if (m.type === 'busy') {
    let b = document.getElementById('busy');
    if (!b) {
      b = document.createElement('span');
      b.id = 'busy'; b.className = 'busy';
      const a = document.querySelector('.actions');
      if (a) a.appendChild(b);
    }
    b.textContent = m.text || '';
  }
});

send({ type: 'ready' });
`;

export class LevelPanel {
  public static current?: LevelPanel;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private model: LevelDetailModel | null = null;
  /**
   * 当前面板要响应的是哪一关。
   *
   * ★ 面板是单例（复用它避免每次开新标签页），但**回调不能只绑第一次那一关**：
   * 早期实现只在构造函数里记下 onAction，于是先打开第 5 关、再切到第 7 关时，
   * 面板上的按钮仍然作用在第 5 关 —— 点「提交并批改」会批改错误的关卡。
   */
  private onAction: (type: string) => void | Promise<void>;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    onAction: (type: string) => void | Promise<void>
  ) {
    this.panel = panel;
    this.onAction = onAction;
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [extensionUri],
    };
    this.panel.webview.html = webviewHtml({
      cspSource: panel.webview.cspSource,
      nonce: makeNonce(),
      title: '关卡详情',
      style: EXTRA_CSS,
      body: '<div id="root"></div>',
      script: SCRIPT,
    });
    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string }) => {
        if (!msg) {
          return;
        }
        if (msg.type === 'ready') {
          this.push();
          return;
        }
        void this.onAction(msg.type);
      },
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(
    extensionUri: vscode.Uri,
    onAction: (type: string) => void | Promise<void>
  ): LevelPanel {
    if (LevelPanel.current) {
      // 复用已有面板：必须把回调换成「当前这一关」的，否则按钮会作用在上一关
      LevelPanel.current.onAction = onAction;
      LevelPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return LevelPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'pythonCamp.level',
      '关卡详情',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    LevelPanel.current = new LevelPanel(panel, extensionUri, onAction);
    return LevelPanel.current;
  }

  /** 更新标题与内容 */
  setModel(model: LevelDetailModel): void {
    this.model = model;
    this.panel.title = `第 ${model.level.day} 关 · ${model.level.title}`;
    this.push();
  }

  /**
   * 推送批改进度（每一步一行 + 已等待秒数）。
   * 只更新页面里那一小块，不整页重绘 —— 否则滚动位置会被重置。
   */
  setProgress(
    steps: Array<{ label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped' }>,
    note?: string
  ): void {
    void this.panel.webview.postMessage({ type: 'progress', steps, note: note ?? '' });
  }

  /** 清掉进度块（批改结束） */
  clearProgress(): void {
    void this.panel.webview.postMessage({ type: 'progress', steps: [], note: '' });
  }

  /** 显示"正在批改…"这类临时状态 */
  busy(text: string): void {
    void this.panel.webview.postMessage({ type: 'busy', text });
  }

  private push(): void {
    if (!this.model) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'state', model: this.model });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  dispose(): void {
    LevelPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
