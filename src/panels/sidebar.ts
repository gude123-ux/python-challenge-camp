/**
 * sidebar.ts —— 侧边栏「闯关进度」面板
 *
 * 三个页签：
 *   今日任务  —— 每天自动派发的关卡，一键开始/提交
 *   关卡地图  —— 全部章节与关卡，状态色块与解锁情况
 *   数据面板  —— 完成率、分数、学习时长趋势、薄弱知识点
 *
 * 渲染策略：HTML 骨架一次注入，之后只 postMessage 推 state，由页面 JS 重绘。
 * 这样不会丢滚动位置和章节展开状态。
 */

import * as vscode from 'vscode';
import type { WebviewMessage } from '../core/types';
import { SidebarModel } from './viewModel';
import { makeNonce, webviewHtml } from './html';

const EXTRA_CSS = `
.tabs { display: flex; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); }
.tabs .tab {
  padding: 5px 9px; cursor: pointer; font-size: 11.5px; border: 0; background: transparent;
  color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; border-radius: 0;
}
.tabs .tab.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, #2f7fe0); font-weight: 600; }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.head .avatar {
  width: 30px; height: 30px; border-radius: 8px; flex: 0 0 30px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px;
}
.head .who { flex: 1 1 auto; min-width: 0; }
.head .who .n { font-weight: 600; font-size: 12.5px; }
.head .who .d { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); border-radius: 7px; padding: 7px 8px; }
.stat .k { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.stat .v { font-size: 16px; font-weight: 700; }
.hint {
  font-size: 10.5px; color: var(--vscode-descriptionForeground);
  background: rgba(127,127,127,.1); border-radius: 6px; padding: 6px 8px; margin-top: 8px;
}
.footer { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.empty { color: var(--vscode-descriptionForeground); font-size: 11.5px; padding: 10px 0; text-align: center; }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
let M = null;
let tab = 'today';
const openCh = new Set();

const send = (m) => vscode.postMessage(m);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function stars(n) {
  n = Math.max(0, Math.min(5, n || 0));
  return '<span class="stars">' + '\u2605'.repeat(n) + '\u2606'.repeat(5 - n) + '</span>';
}

function fmtMin(ms) {
  if (!ms || ms <= 0) return '0 分钟';
  const t = Math.round(ms / 60000);
  const h = Math.floor(t / 60), m = t % 60;
  if (h === 0) return m + ' 分钟';
  if (m === 0) return h + ' 小时';
  return h + ' 小时 ' + m + ' 分';
}

function badge(c) {
  if (c.status === 'passed') return '<span class="badge pass">已过关 ' + c.bestScore + ' 分</span>';
  if (c.status === 'locked') return '<span class="badge locked">未解锁</span>';
  if (c.attempts > 0) return '<span class="badge fail">未过关 ' + c.bestScore + ' 分</span>';
  return '<span class="badge open">可挑战</span>';
}

function head() {
  const s = M.student || {};
  const initial = (s.name || '学').trim().slice(0, 1) || '学';
  const who = s.name ? esc(s.name) : '未填写姓名';
  const cohort = s.cohort ? ' · ' + esc(s.cohort) : '';
  return '<div class="head">' +
    '<div class="avatar">' + esc(initial) + '</div>' +
    '<div class="who"><div class="n">' + who + cohort + '</div>' +
    '<div class="d">' + esc(M.today) + ' · 连续打卡 ' + M.streak.current + ' 天（最长 ' + M.streak.best + ' 天）</div></div>' +
    '</div>';
}

function tabs() {
  const items = [['today', '今日任务'], ['map', '关卡地图'], ['data', '数据面板']];
  return '<div class="tabs">' + items.map(function (it) {
    return '<button class="tab ' + (tab === it[0] ? 'on' : '') + '" data-act="tab" data-tab="' + it[0] + '">' + it[1] + '</button>';
  }).join('') + '</div>';
}

function aiHint() {
  const a = M.ai;
  if (!a.enabled) {
    return '<div class="hint">AI 批改已关闭，当前只做本地运行检查。可在设置里开启。</div>';
  }
  if (!a.ready) {
    return '<div class="hint">还没配置 API Key，提交时只做本地检查。点下方「配置 API Key」开始 AI 批改。</div>';
  }
  return '<div class="hint">AI 批改：' + esc(a.model) + (a.strict ? ' · 严格模式' : '') + '</div>';
}

function renderToday() {
  const t = M.todayTask;
  const pct = t.total ? Math.round(t.done / t.total * 100) : 0;
  let html = '<div class="card">' +
    '<div class="kv"><span>今日进度</span><span class="v">' + t.done + ' / ' + t.total + ' 关</span></div>' +
    '<div class="bar" style="margin-top:6px"><i style="width:' + pct + '%"></i></div>' +
    '<div class="muted" style="font-size:10.5px;margin-top:6px">今日已学习 ' + fmtMin(M.stats.todayMs) + ' · 剩余约 ' +
      Math.round(M.stats.remainingMinutes / 60) + ' 小时内容</div>' +
    '</div>';

  if (!t.levels.length) {
    html += '<div class="empty">今天还没有任务。<br>点下面的「开始今日任务」派发。</div>';
  } else {
    html += '<div class="section-title">今日任务 <span class="count">' + t.done + '/' + t.total + '</span></div><div class="todo">';
    t.levels.forEach(function (c) {
      html += '<div class="item' + (c.dailyDone ? ' done' : '') + '">' +
        '<div class="hd"><div><div class="t">第 ' + c.day + ' 关 · ' + esc(c.title) + '</div>' +
        '<div class="sub">' + esc(c.id) + ' · ' + stars(c.difficulty) + ' · 约 ' + c.minutes + ' 分钟</div></div>' +
        '<div>' + badge(c) + '</div></div>' +
        '<div class="btns">' +
          '<button class="primary tiny" data-act="openLevel" data-id="' + c.id + '">打开关卡</button>' +
          '<button class="tiny" data-act="runLevel" data-id="' + c.id + '">运行</button>' +
          '<button class="tiny" data-act="submitLevel" data-id="' + c.id + '">提交批改</button>' +
        '</div></div>';
    });
    html += '</div>';
  }

  if (M.wrong.length) {
    html += '<div class="section-title">错题本 <span class="count">' + M.wrong.length + '</span></div>';
    html += '<div class="card"><div class="chips">' + M.wrong.slice(0, 12).map(function (c) {
      return '<button class="chip fail" data-act="openLevel" data-id="' + c.id + '">第' + c.day + '关 ' + c.bestScore + '分</button>';
    }).join('') + '</div>' +
    '<div class="btns" style="margin-top:8px"><button class="tiny" data-act="retryWrong">按错题重排今日任务</button></div></div>';
  }

  html += aiHint();
  html += '<div class="footer">' +
    '<button class="primary" data-act="startToday">开始今日任务</button>' +
    '<button data-act="resetToday">重置今日任务</button>' +
    '<button data-act="pickLevel">切换关卡</button>' +
    '<button data-act="openSettings">配置 API Key</button>' +
    '</div>';
  return html;
}

function renderMap() {
  let html = '<div class="muted" style="font-size:10.5px;margin-bottom:8px">共 ' + M.stats.total +
    ' 关 · 已过关 ' + M.stats.passed + ' 关 · 过关线 ' + M.passScore + ' 分</div>';
  M.chapters.forEach(function (ch) {
    const isOpen = openCh.has(ch.id);
    html += '<details class="chapter"' + (isOpen ? ' open' : '') + ' data-ch="' + ch.id + '">' +
      '<summary><span>' + ch.id + '. ' + esc(ch.title) + '</span>' +
      '<span class="count" style="margin-left:auto">' + ch.passed + '/' + ch.total + ' ' + stars(ch.difficulty) + '</span></summary>' +
      '<div class="levels">';
    ch.levels.forEach(function (c) {
      html += '<div class="level-row ' + (c.status === 'locked' ? 'locked' : '') + '" data-act="openLevel" data-id="' + c.id + '">' +
        '<div class="no">' + c.id + '</div>' +
        '<div class="body"><div class="t">' + esc(c.title) + '</div>' +
        '<div class="sub">第 ' + c.day + ' 天 · 约 ' + c.minutes + ' 分钟' +
          (c.attempts ? ' · 最好 ' + c.bestScore + ' 分 / ' + c.attempts + ' 次' : '') + '</div></div>' +
        '<div class="acts">' + badge(c) + '</div></div>';
    });
    html += '</div></details>';
  });
  html += '<div class="footer"><button data-act="pickLevel">快速切换关卡</button>' +
    '<button data-act="exportReport">导出学习报告</button></div>';
  return html;
}

function renderData() {
  const s = M.stats;
  const pct = Math.round(s.completionRate * 100);
  let html = '<div class="card">' +
    '<div class="kv"><span>总完成率</span><span class="v">' + pct + '%</span></div>' +
    '<div class="bar" style="margin-top:6px"><i style="width:' + pct + '%"></i></div>' +
    '</div>' +
    '<div class="grid2">' +
      '<div class="stat"><div class="k">已过关</div><div class="v">' + s.passed + ' <span style="font-size:11px" class="muted">/ ' + s.total + '</span></div></div>' +
      '<div class="stat"><div class="k">已解锁</div><div class="v">' + s.unlocked + '</div></div>' +
      '<div class="stat"><div class="k">平均分</div><div class="v">' + (s.scoredCount ? s.avgScore.toFixed(1) : '—') + '</div></div>' +
      '<div class="stat"><div class="k">总学习时长</div><div class="v" style="font-size:13px">' + fmtMin(s.totalStudyMs) + '</div></div>' +
    '</div>';

  html += '<div class="section-title">最近 14 天学习时长</div><div class="card">';
  const max = Math.max.apply(null, M.recentDays.map(function (d) { return d.ms; }).concat([1]));
  html += '<div class="spark">' + M.recentDays.map(function (d) {
    const h = Math.max(2, Math.round(d.ms / max * 38));
    return '<div class="b' + (d.ms > 0 ? '' : ' empty') + '" style="height:' + (d.ms > 0 ? h : 2) + 'px" title="' + d.date + '：' + fmtMin(d.ms) + '"></div>';
  }).join('') + '</div>';
  html += '<div class="muted" style="font-size:10px;display:flex;justify-content:space-between;margin-top:4px">' +
    '<span>' + M.recentDays[0].date.slice(5) + '</span><span>今天</span></div></div>';

  html += '<div class="section-title">薄弱知识点</div>';
  if (!M.weakPoints.length) {
    html += '<div class="empty">还没有数据。多提交几次批改就会自动积累。</div>';
  } else {
    html += '<div class="card"><div class="chips">' + M.weakPoints.map(function (w) {
      return '<span class="chip" style="cursor:default">' + esc(w.tag) + ' <b>' + w.count + '</b></span>';
    }).join('') + '</div><div class="hint">这些是批改时反复被扣分的点，建议回到对应关卡重做一遍。</div></div>';
  }

  html += '<div class="section-title">题库来源</div><div class="card">' +
    '<div class="muted" style="font-size:10.5px">生成时间：' + esc(M.bankInfo.generatedAt) + '</div>' +
    '<ul class="tight" style="font-size:10.5px">' + M.bankInfo.sources.map(function (x) {
      return '<li>' + esc(x) + '</li>';
    }).join('') + '</ul></div>';

  html += '<div class="footer"><button data-act="exportReport">导出学习报告</button>' +
    '<button data-act="openSettings">打开设置</button>' +
    '<button data-act="resetAll">重置全部进度</button></div>';
  return html;
}

function render() {
  if (!M) return;
  let body = head() + tabs();
  if (tab === 'today') body += renderToday();
  else if (tab === 'map') body += renderMap();
  else body += renderData();
  document.getElementById('root').innerHTML = body;
}

document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');
  if (act === 'tab') { tab = el.getAttribute('data-tab'); render(); return; }
  if (act === 'openLevel') { send({ type: 'openLevel', levelId: id }); return; }
  if (act === 'submitLevel') { send({ type: 'submitLevel', levelId: id }); return; }
  if (act === 'runLevel') { send({ type: 'runLevel', levelId: id }); return; }
  send({ type: act });
});

document.addEventListener('toggle', function (e) {
  const d = e.target;
  if (d && d.tagName === 'DETAILS' && d.dataset.ch) {
    const id = Number(d.dataset.ch);
    if (d.open) openCh.add(id); else openCh.delete(id);
  }
}, true);

window.addEventListener('message', function (e) {
  const m = e.data;
  if (m && m.type === 'state') { M = m.model; render(); }
});

send({ type: 'ready' });
`;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pythonCamp.sidebar';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: WebviewMessage) => void | Promise<void>,
    private readonly getModel: () => SidebarModel,
    /** 面板可见性回调，用于学习时长统计 */
    private readonly onVisibilityChange?: (visible: boolean) => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = webviewHtml({
      cspSource: view.webview.cspSource,
      nonce: makeNonce(),
      title: 'Python闯关训练营',
      style: EXTRA_CSS,
      body: '<div id="root"></div>',
      script: SCRIPT,
    });

    view.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg?.type === 'ready') {
        this.refresh();
        return;
      }
      void this.onMessage(msg);
    });

    view.onDidChangeVisibility(() => {
      this.onVisibilityChange?.(view.visible);
      if (view.visible) {
        this.refresh();
      }
    });
    this.onVisibilityChange?.(view.visible);
    this.refresh();
  }

  /** 把最新状态推给页面 */
  refresh(): void {
    if (!this.view) {
      return;
    }
    const model = this.getModel();
    void this.view.webview.postMessage({ type: 'state', model });
    // 把模型也塞进 title tooltip，方便排查
    this.view.description = `${model.stats.passed}/${model.stats.total} 已过关`;
  }

  /** 面板当前是否可见 */
  get visible(): boolean {
    return !!this.view?.visible;
  }

  /** 确保侧边栏被展开 */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand('pythonCamp.sidebar.focus');
  }
}
