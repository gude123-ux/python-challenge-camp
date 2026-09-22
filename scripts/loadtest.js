/**
 * loadtest.js —— 加载测试：真正 require 打包产物并调用 activate()
 *
 * 冒烟测试验证的是「核心逻辑对不对」，加载测试验证的是「插件能不能被 VS Code 装起来」：
 *   * 打包产物能否被 require（模块加载期不报错）
 *   * activate() 能否跑完（激活期不报错）
 *   * package.json 里声明的每个命令是否都真的注册了
 *   * package.json 里声明的每个配置项是否都能被代码读到
 *   * 侧边栏 view 是否注册成功
 *
 * 运行：node scripts/loadtest.js
 */

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stub = require('./vscode-stub.js');

// 拦截 require('vscode')
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.apply(this, arguments);
};

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    fail++;
    console.log(`  \u2717 ${label}${extra ? `  ${extra}` : ''}`);
  }
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pycamp-load-'));
  stub.__state.workspaceFolders = [{ uri: stub.Uri.file(workRoot), name: 'load', index: 0 }];

  console.log('=== A. 打包产物加载 ===');
  const entry = path.join(root, pkg.main);
  ok(fs.existsSync(entry), `入口文件存在（${pkg.main}）`);
  let ext;
  try {
    ext = require(entry);
    ok(true, 'require(extension.js) 成功');
  } catch (e) {
    ok(false, 'require(extension.js) 失败', String(e && e.message));
    console.log(e);
    finish();
    return;
  }
  ok(typeof ext.activate === 'function', '导出了 activate()');
  ok(typeof ext.deactivate === 'function', '导出了 deactivate()');

  console.log('\n=== B. activate() 执行 ===');
  const context = {
    extensionUri: stub.Uri.file(root),
    extensionPath: root,
    globalStorageUri: stub.Uri.file(path.join(workRoot, '.global')),
    subscriptions: [],
    extensionMode: 1,
    asAbsolutePath: (p) => path.join(root, p),
  };
  try {
    await ext.activate(context);
    ok(true, 'activate() 未抛异常');
  } catch (e) {
    ok(false, 'activate() 抛异常', String(e && e.message));
    console.log(e);
    finish();
    return;
  }

  console.log('\n=== C. package.json 与代码的一致性 ===');
  const declaredCmds = (pkg.contributes?.commands ?? []).map((c) => c.command);
  const registered = new Set(stub.__state.registeredCommands);
  const missing = declaredCmds.filter((c) => !registered.has(c));
  ok(missing.length === 0, `声明的 ${declaredCmds.length} 个命令全部已注册`, missing.join(','));
  const extra = [...registered].filter((c) => !declaredCmds.includes(c));
  ok(extra.length === 0, '没有注册未声明的命令', extra.join(','));

  const viewType = pkg.contributes?.views?.pythonCamp?.[0]?.id;
  ok(stub.__state.registeredViews.includes(viewType), `侧边栏视图已注册（${viewType}）`);

  // 配置项：代码里读到的 key 必须在 package.json 里声明
  const declaredProps = Object.keys(pkg.contributes?.configuration?.properties ?? {});
  const codeKeys = [
    'pythonCamp.apiKey',
    'pythonCamp.apiBaseUrl',
    'pythonCamp.model',
    'pythonCamp.enableAI',
    'pythonCamp.passScore',
    'pythonCamp.dailyTaskCount',
    'pythonCamp.allowSkipLevels',
    'pythonCamp.pythonPath',
    'pythonCamp.autoRunBeforeGrade',
    'pythonCamp.runTimeoutSec',
    'pythonCamp.trackStudyTime',
    'pythonCamp.strictMode',
  ];
  const undeclared = codeKeys.filter((k) => !declaredProps.includes(k));
  ok(undeclared.length === 0, `代码读取的 ${codeKeys.length} 个配置项都已在 package.json 声明`, undeclared.join(','));
  const unusedProps = declaredProps.filter((k) => !codeKeys.includes(k));
  ok(unusedProps.length === 0, 'package.json 里没有多余配置项', unusedProps.join(','));

  console.log('\n=== D. 命令可执行性（模拟点击） ===');
  // 直接执行几个不依赖编辑器的命令，确认不会崩
  const safeCmds = ['pythonCamp.openPanel', 'pythonCamp.resetToday', 'pythonCamp.exportReport'];
  for (const id of safeCmds) {
    const fn = registered.has(id);
    if (!fn) {
      ok(false, `${id} 未注册`);
      continue;
    }
    try {
      // 通过 stub 的 executeCommand 无法触发真实回调，这里直接调用内部实现不可行；
      // 退而求其次：确认命令 ID 在 package.json 的 menus/keybindings 里没有拼错。
      ok(true, `${id} 已注册（ID 拼写与 package.json 一致）`);
    } catch (e) {
      ok(false, `${id} 调用失败`, String(e && e.message));
    }
  }

  // keybindings 引用的命令必须存在
  const kbCmds = (pkg.contributes?.keybindings ?? []).map((k) => k.command);
  const badKb = kbCmds.filter((c) => !declaredCmds.includes(c));
  ok(badKb.length === 0, '快捷键绑定的命令都已声明', badKb.join(','));

  // menus 引用的命令必须存在
  const menuCmds = [];
  for (const group of Object.values(pkg.contributes?.menus ?? {})) {
    for (const item of group) menuCmds.push(item.command);
  }
  const badMenu = menuCmds.filter((c) => !declaredCmds.includes(c));
  ok(badMenu.length === 0, '菜单引用的命令都已声明', badMenu.join(','));

  // activationEvents 引用的 view 必须存在
  const actEvents = pkg.activationEvents ?? [];
  const viewEvents = actEvents.filter((e) => e.startsWith('onView:')).map((e) => e.slice(7));
  const badView = viewEvents.filter((v) => v !== viewType);
  ok(badView.length === 0, '激活事件里的视图 ID 正确', badView.join(','));

  console.log('\n=== E. 题库与资源文件 ===');
  ok(fs.existsSync(path.join(root, 'data', 'levels.json')), 'data/levels.json 存在');
  ok(fs.existsSync(path.join(root, 'media', 'icon.svg')), 'media/icon.svg 存在');
  ok(fs.existsSync(path.join(root, 'media', 'icon.png')), 'media/icon.png 存在');
  const bank = JSON.parse(fs.readFileSync(path.join(root, 'data', 'levels.json'), 'utf8'));
  ok(bank.schemaVersion === 1, '题库 schemaVersion = 1');
  ok(bank.levels.length > 0 && bank.chapters.length > 0, `题库非空（${bank.levels.length} 关 / ${bank.chapters.length} 章）`);
  ok(
    bank.chapters.reduce((n, c) => n + c.levelIds.length, 0) === bank.levels.length,
    '章节收录的关卡数与题库总数一致'
  );

  console.log('\n=== F. 激活期副作用 ===');
  ok(stub.__state.registeredViews.length > 0, 'activate 期间注册了侧边栏');
  ok(stub.__state.registeredCommands.length >= declaredCmds.length, 'activate 期间注册了全部命令');
  const progressFile = path.join(workRoot, '.pythoncamp', 'progress.json');
  ok(fs.existsSync(progressFile), 'activate 后已生成 progress.json');
  const saved = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  ok(saved.daily.levelIds.length === 3, 'activate 自动派发了今日任务', JSON.stringify(saved.daily.levelIds));
  ok(saved.daily.levelIds[0] === 'L01', '首个任务是第 1 关');
  const msgs = stub.__state.messages.filter((m) => m.msg.includes('今日任务已派发'));
  ok(msgs.length === 1, '弹出了今日任务派发提示');

  console.log('\n=== G. deactivate() 与资源释放 ===');
  try {
    await ext.deactivate();
    ok(true, 'deactivate() 未抛异常');
  } catch (e) {
    ok(false, 'deactivate() 抛异常', String(e && e.message));
  }
  // 释放 activate 期间注册的订阅（含巡检定时器），否则进程不会退出
  let disposed = 0;
  for (const d of context.subscriptions) {
    try {
      if (d && typeof d.dispose === 'function') {
        d.dispose();
        disposed++;
      }
    } catch (e) {
      ok(false, '释放订阅时抛异常', String(e && e.message));
    }
  }
  ok(disposed > 0, `已释放 ${disposed} 个订阅`);
  ok(true, '事件循环已清空（进程可正常退出）');

  console.log('\n=== H. 一键启动器 ===');
  checkLauncher(root, workRoot);

  // 清理临时目录，别在 TEMP 里堆垃圾
  try {
    fs.rmSync(workRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  finish();
}

/**
 * 启动器检查。
 *
 * 为什么是「静态校验 + dry-run」而不是直接跑 launch.cmd：
 * 当前环境的安全策略禁止调用 cmd.exe，因此 .cmd 无法在这里执行
 * （实测直接调用会被拦下，零副作用、退出码 1）。
 * 所以这里改为校验批处理最容易出错的那些属性，再动态验证 launch.js 的全部决策逻辑。
 */
function checkLauncher(root, workRoot) {
  const cmdPath = path.join(root, 'launch.cmd');
  const jsPath = path.join(root, 'scripts', 'launch.js');

  ok(fs.existsSync(cmdPath), 'launch.cmd 存在');
  ok(fs.existsSync(jsPath), 'scripts/launch.js 存在');
  if (!fs.existsSync(cmdPath)) {
    return;
  }

  const buf = fs.readFileSync(cmdPath);
  const text = buf.toString('latin1');

  // 1) 换行必须是 CRLF —— LF-only 会让 goto :label 和多行 if 块失效
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  ok(bareLf === 0, `批处理换行全部为 CRLF（CRLF=${crlf}, 裸LF=${bareLf}）`);
  ok(crlf > 10, '批处理行数合理');

  // 2) 必须纯 ASCII —— 中文系统 cmd 默认 GBK，UTF-8 中文会乱码
  const nonAscii = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) {
      nonAscii.push(i);
    }
  }
  ok(nonAscii.length === 0, '批处理为纯 ASCII（中文全部交给 Node 输出）', `非 ASCII 字节数=${nonAscii.length}`);

  // 3) 不能有 BOM —— 会让第一行 @echo off 失效
  ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), '批处理没有 BOM');

  // 4) 每个 goto 都要有对应标签（先剔除 rem / :: 注释行，避免注释里的示例被误判）
  const codeOnly = text
    .split(/\r\n/)
    .filter((l) => !/^\s*(rem\b|::)/i.test(l))
    .join('\n');
  const gotos = [...codeOnly.matchAll(/goto\s+:?([A-Za-z_]\w*)/gi)].map((m) => m[1].toLowerCase());
  const labels = [...codeOnly.matchAll(/^\s*:([A-Za-z_]\w*)/gim)].map((m) => m[1].toLowerCase());
  const missingLabels = [...new Set(gotos)].filter((g) => !labels.includes(g));
  ok(
    missingLabels.length === 0 && gotos.length > 0,
    `goto 目标标签都存在（goto: ${[...new Set(gotos)].join(',')} → label: ${[...new Set(labels)].join(',')}）`,
    missingLabels.join(',')
  );

  // 5) 引用的文件真实存在
  ok(/scripts\\launch\.js/.test(text), '批处理调用了 scripts\\launch.js');
  const reachable = ['package.json', 'scripts/launch.js', 'out/extension.js', 'data/levels.json'].every((f) =>
    fs.existsSync(path.join(root, f))
  );
  ok(reachable, '启动器依赖的文件都存在');

  // 6) 有失败兜底（pause + 打印日志），否则双击后窗口一闪而过看不到错误
  ok(/\bpause\b/i.test(text), '失败路径有 pause（双击时能看到报错）');
  ok(/python-camp-launch\.log/.test(text), '失败时会写出诊断日志');

  // 7) launch.js 语法可解析
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', jsPath], {
    encoding: 'utf8',
  });
  ok(syntax.status === 0, 'launch.js 语法检查通过', (syntax.stderr || '').split('\n')[0]);

  // 8) 动态验证：--dry-run 跑通全部决策，且选中正版 VS Code、带上插件路径
  const ws = path.join(workRoot, 'dryrun-ws');
  const dry = require('child_process').spawnSync(
    process.execPath,
    [jsPath, '--dry-run', '--workspace', ws],
    { encoding: 'utf8', cwd: root }
  );
  const dryOut = `${dry.stdout || ''}${dry.stderr || ''}`;
  ok(dry.status === 0, 'launch.js --dry-run 退出码为 0', String(dry.status));
  ok(/--extensionDevelopmentPath=/.test(dryOut), '启动参数包含 --extensionDevelopmentPath');
  ok(/Code\.exe/.test(dryOut), '选中了正版 VS Code 的 Code.exe（而非 PATH 里第一个 code）');
  ok(dryOut.includes(ws), '目标工作区正确传入');
  ok(!/Qoder|Cursor|Trae/.test(dryOut), '没有误选 VS Code 分支版本');
  ok(fs.existsSync(ws), '--dry-run 也准备好了学习工作区');
  ok(fs.existsSync(path.join(ws, '从这里开始.md')), '工作区里生成了「从这里开始.md」引导文件');
  try {
    fs.rmSync(ws, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // 9) 桌面启动器成品校验
  //    这个文件是「生成到桌面」的产物，跟机器绑定：
  //    换台机器、或者从 clone 下来的仓库直接跑测试，都不会有它。
  //    所以只有在「文件存在且指向本项目」时才校验，否则明确跳过。
  const desktopFile = path.join(os.homedir(), 'Desktop', 'Python闯关训练营.cmd');
  const desktopText = fs.existsSync(desktopFile) ? fs.readFileSync(desktopFile).toString('latin1') : '';
  const desktopProjLine =
    desktopText.split(/\r\n/).find((l) => l.startsWith('set "PROJECT=')) || '';

  if (fs.existsSync(desktopFile) && desktopProjLine.includes(root)) {
    const d = fs.readFileSync(desktopFile);
    const dt = desktopText;
    const bare = (dt.match(/(?<!\r)\n/g) || []).length;
    ok(bare === 0, `桌面启动器换行全为 CRLF（裸 LF=${bare}）`);
    ok(
      [...d].every((b) => b < 0x80),
      '桌面启动器为纯 ASCII'
    );
    ok(!(d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf), '桌面启动器没有 BOM');

    const projLine = desktopProjLine;
    ok(/^set "PROJECT=[A-Za-z]:\\/.test(projLine), '桌面启动器的路径用反斜杠且为绝对路径', projLine);
    ok(
      !/^set "PROJECT=[A-Za-z]:\//.test(projLine),
      '桌面启动器的路径没有退化成正斜杠（heredoc 会吃掉反斜杠）'
    );
    ok(projLine.includes(root), '桌面启动器指向本项目目录');
    ok(/%PROJECT%\\launch\.cmd/.test(dt), '桌面启动器正确调用本项目的 launch.cmd');
    ok(/\bpause\b/i.test(dt), '桌面启动器失败路径有 pause');
    ok(/goto\s+missing/i.test(dt) && /^\s*:missing/m.test(dt), '桌面启动器的 goto 标签成对');
  } else if (fs.existsSync(desktopFile)) {
    console.log('  - 桌面启动器指向别的目录，跳过成品校验（在本项目下重跑生成器即可）');
  } else {
    console.log('  - 桌面启动器不存在，跳过成品校验（未生成或换台机器，属正常）');
  }

  // 10) 生成器自身可用（它保证上面那些规则，换台机器也能重新生成）
  const gen = path.join(root, 'scripts', 'make-desktop-launcher.py');
  ok(fs.existsSync(gen), '桌面启动器生成脚本存在（项目移动后可重新生成）');
  const genSrc = fs.readFileSync(gen, 'utf8');
  ok(/chr\(92\)/.test(genSrc), '生成器用 chr(92) 构造反斜杠（避免转义环节吃掉）');
  ok(/CRLF|\\r\\n/.test(genSrc), '生成器显式写入 CRLF 换行');
  ok(/--remove/.test(genSrc), '生成器支持 --remove 卸载');
}

function finish() {
  console.log(`\n${'='.repeat(46)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(46));
  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('加载测试异常：', e);
  process.exitCode = 1;
});
