/**
 * vscode-stub.js —— 测试用的最小 vscode 模块替身
 *
 * 两处使用：
 *   * scripts/smoke.ts  —— 跑核心逻辑（解锁/调度/批改/运行）
 *   * scripts/loadtest.js —— 真正 require 打包产物并调用 activate()，
 *     用来抓「模块加载期/激活期」才会暴露的错误（缺 API、命令 ID 写错等）。
 *
 * getConfiguration 会读取 package.json 里的默认值，所以配置项改名而代码没跟上时，
 * 加载测试能直接发现。
 */

const path = require('path');
const fs = require('fs');

const PKG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  } catch {
    return { contributes: { configuration: { properties: {} } } };
  }
})();

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((f) => f !== fn);
        },
      };
    };
  }
  fire(v) {
    for (const fn of [...this.listeners]) fn(v);
  }
  dispose() {
    this.listeners = [];
  }
}

const Uri = {
  file(p) {
    return {
      scheme: 'file',
      fsPath: p,
      path: p,
      toString: () => 'file://' + String(p).replace(/\\/g, '/'),
    };
  },
  joinPath(base, ...parts) {
    return Uri.file(path.join(base.fsPath, ...parts));
  },
  parse(s) {
    return Uri.file(String(s).replace(/^file:\/\//, ''));
  },
};

const state = {
  workspaceFolders: undefined,
  focused: true,
  activeTextEditor: undefined,
  /** 记录被注册的命令 ID */
  registeredCommands: [],
  /** id → 处理函数（测试里可直接调用某个命令，绕开 executeCommand 的"只记录"语义） */
  commandHandlers: {},
  /** 创建过的 webview 面板（用于断言"关掉之后能重新打开"这类生命周期问题） */
  createdPanels: [],
  /** 记录被执行过的命令 */
  executedCommands: [],
  /** 记录 registerWebviewViewProvider 的 viewType */
  registeredViews: [],
  messages: [],
  /** 需要用户确认时返回的选项 */
  confirmAnswer: undefined,
  /**
   * 模拟「已安装的其它扩展」。默认空数组。
   * 用来测「同名插件冲突检测」：塞一个 displayName 相同的假扩展进去，
   * activate 期间就应该弹出提醒并（用户确认后）执行卸载命令。
   */
  installedExtensions: [],
};

const noopDisposable = { dispose() {} };

function makeStatusBarItem() {
  return {
    text: '',
    tooltip: '',
    command: undefined,
    show() {},
    hide() {},
    dispose() {},
  };
}

module.exports = {
  EventEmitter,
  Uri,

  window: {
    get state() {
      return { focused: state.focused };
    },
    get activeTextEditor() {
      return state.activeTextEditor;
    },
    showInformationMessage: async (msg, ...items) => {
      state.messages.push({ level: 'info', msg, items });
      return state.confirmAnswer;
    },
    showWarningMessage: async (msg, ...items) => {
      state.messages.push({ level: 'warn', msg, items });
      return state.confirmAnswer;
    },
    showErrorMessage: async (msg, ...items) => {
      state.messages.push({ level: 'error', msg, items });
      return state.confirmAnswer;
    },
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    createStatusBarItem: () => makeStatusBarItem(),
    createOutputChannel: () => ({
      appendLine() {},
      append() {},
      show() {},
      dispose() {},
    }),
    onDidChangeActiveTextEditor: () => noopDisposable,
    onDidChangeVisibleTextEditors: () => noopDisposable,
    onDidChangeWindowState: () => noopDisposable,
    registerWebviewViewProvider: (viewType) => {
      state.registeredViews.push(viewType);
      return noopDisposable;
    },
    /**
     * ★ 真实还原 VS Code 的 webview 面板语义：
     *   * `dispose()` 之后 `postMessage` / `reveal` 会**抛 `Webview is disposed`**
     *     （真实 VS Code 就是这样，而"面板被关掉后按钮失灵"这个 bug 正是这么来的）；
     *   * `dispose()` 会触发 onDidDispose 回调（扩展靠它清理引用）。
     * 只有替身也这么做，测试才能测出「关掉面板再打开」这类生命周期问题。
     */
    createWebviewPanel: (viewType, title, _column, options) => {
      const disposeListeners = [];
      let disposed = false;
      const panel = {
        viewType,
        title: title || '',
        webview: {
          html: '',
          options: options || {},
          cspSource: 'vscode-resource:',
          asWebviewUri: (u) => u,
          onDidReceiveMessage: (fn) => {
            panel.__messageHandler = fn;
            return noopDisposable;
          },
          postMessage: async (m) => {
            if (disposed) {
              throw new Error('Webview is disposed');
            }
            panel.__posted = panel.__posted || [];
            panel.__posted.push(m);
            return true;
          },
        },
        onDidDispose: (fn) => {
          disposeListeners.push(fn);
          return noopDisposable;
        },
        reveal() {
          if (disposed) {
            throw new Error('Webview is disposed');
          }
        },
        dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          for (const fn of disposeListeners) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
        },
        get __disposed() {
          return disposed;
        },
      };
      state.createdPanels.push(panel);
      return panel;
    },
    withProgress: async (_opts, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => noopDisposable }),
    setStatusBarMessage: () => noopDisposable,
  },

  workspace: {
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    getConfiguration: (section) => ({
      get(key, dflt) {
        const props = PKG?.contributes?.configuration?.properties ?? {};
        const full = section ? `${section}.${key}` : key;
        const def = props[full]?.default;
        return def !== undefined ? def : dflt;
      },
      update: async () => undefined,
      has: () => true,
      inspect: () => undefined,
    }),
    get textDocuments() {
      return [];
    },
    openTextDocument: async () => ({ uri: Uri.file('untitled'), languageId: 'plaintext', isDirty: false, save: async () => true }),
    showTextDocument: async () => ({ document: {}, options: {} }),
    onDidChangeConfiguration: () => noopDisposable,
    onDidOpenTextDocument: () => noopDisposable,
    onDidSaveTextDocument: () => noopDisposable,
    asRelativePath: (p) => String(p),
    findFiles: async () => [],
    fs: {},
  },

  commands: {
    registerCommand: (id, fn) => {
      state.registeredCommands.push(id);
      state.commandHandlers[id] = fn;
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => {
      state.executedCommands.push(id);
      return undefined;
    },
    getCommands: async () => state.registeredCommands,
  },

  extensions: {
    get all() {
      return state.installedExtensions;
    },
    getExtension: (id) => state.installedExtensions.find((e) => e.id === id),
  },

  languages: {
    createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
  },

  Diagnostic: class {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Range: class {
    constructor(...a) {
      this.args = a;
    }
  },
  Position: class {
    constructor(line, ch) {
      this.line = line;
      this.character = ch;
    }
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },

  __state: state,
  __pkg: PKG,
};
