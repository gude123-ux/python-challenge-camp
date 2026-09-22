#!/usr/bin/env node
/**
 * launch.js —— 一键启动器
 *
 * 双击桌面快捷方式时实际跑的就是这个脚本。它按顺序做四件事：
 *   1. 检查 Node / 安装依赖（只在缺的时候做）
 *   2. 编译插件（esbuild，几十毫秒）
 *   3. 找到 VS Code 的可执行文件（**优先正版 VS Code**，不是 PATH 里第一个 code）
 *   4. 准备好学习工作区，然后带着插件启动 VS Code
 *
 * 为什么不用 .bat 写逻辑：Windows 中文系统的 cmd 默认代码页是 GBK，
 * 批处理里的中文会乱码。所以 .cmd 只做「找到 node 并调用本脚本」这一件纯 ASCII 的事，
 * 所有中文输出和判断都放在这里 —— Node 走 WriteConsoleW，中文在 cmd 里正常显示。
 *
 * 用法：
 *   node scripts/launch.js                  启动（开发宿主模式，始终用最新代码）
 *   node scripts/launch.js --install        打包 vsix 并永久安装到 VS Code，再启动
 *   node scripts/launch.js --check          只做环境诊断，不启动
 *   node scripts/launch.js --workspace D:\py 指定学习工作区
 *   node scripts/launch.js --help           帮助
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_ID = 'zhongou-aviation.python-challenge-camp';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

// ------------------------------------------------------------------ 输出

const isTTY = process.stdout.isTTY;
const paint = (code) => (s) => (isTTY ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');

const out = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => out(dim('─'.repeat(58)));
const step = (n, total, msg) => out(`\n${cyan(`[${n}/${total}]`)} ${bold(msg)}`);
const info = (s) => out(`      ${s}`);
const good = (s) => out(`      ${green('✓')} ${s}`);
const warn = (s) => out(`      ${yellow('!')} ${s}`);
const bad = (s) => out(`      ${red('✗')} ${s}`);

/**
 * 追加诊断日志到 %TEMP%\python-camp-launch.log
 * （launch.cmd 会先写一行，这里接着写，出问题时用户把日志发过来就能定位）
 */
const LOG = path.join(os.tmpdir(), 'python-camp-launch.log');
function logLine(s) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function fail(msg, hint) {
  out('');
  bad(msg);
  logLine(`FAIL ${msg}${hint ? ` | hint: ${hint}` : ''}`);
  if (hint) {
    out(`        ${dim(hint)}`);
  }
  out('');
  process.exitCode = 1;
  return false;
}

// ------------------------------------------------------------------ 工具

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 在 PATH 里找可执行文件（Windows 要试 PATHEXT） */
function which(cmd) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (exists(p)) {
        return p;
      }
    }
  }
  return null;
}

/** 找一个能用的 npm：优先直接跑 npm-cli.js，避免 .cmd 在 Node 20+ 下的 shell 限制 */
function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const cands = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, 'node_modules', 'npm', 'lib', 'cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of cands) {
    if (exists(c)) {
      return c;
    }
  }
  return null;
}

function runNpm(npmArgs) {
  const cli = findNpmCli();
  if (cli) {
    return spawnSync(process.execPath, [cli, ...npmArgs], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
  const npmCmd = which('npm') || which('npm.cmd');
  if (!npmCmd) {
    return { status: 1, error: new Error('找不到 npm') };
  }
  return spawnSync(npmCmd, npmArgs, { cwd: ROOT, stdio: 'inherit', shell: true });
}

// ------------------------------------------------------------------ 步骤 1：Node

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  info(`Node ${process.versions.node}（${process.execPath}）`);
  if (major < 18) {
    return fail(
      `Node 版本过低（需要 18 及以上，当前 ${process.versions.node}）`,
      '请从 https://nodejs.org 安装 LTS 版本后重试。'
    );
  }
  good('Node 版本满足要求');
  return true;
}

// ------------------------------------------------------------------ 步骤 2：依赖

function ensureDeps() {
  const esbuild = path.join(ROOT, 'node_modules', 'esbuild', 'package.json');
  if (exists(esbuild)) {
    good('依赖已就绪，跳过安装');
    return true;
  }
  warn('首次运行，需要安装依赖（约 1 分钟，只会做这一次）…');
  out('');
  const r = runNpm(['install', '--no-audit', '--no-fund']);
  out('');
  if (r.status !== 0) {
    return fail(
      '依赖安装失败',
      '如果是网络问题，可以先把 npm 源换成国内镜像：\n' +
        '        npm config set registry https://registry.npmmirror.com'
    );
  }
  if (!exists(esbuild)) {
    return fail('依赖安装后仍找不到 esbuild，请检查 node_modules 目录');
  }
  good('依赖安装完成');
  return true;
}

// ------------------------------------------------------------------ 步骤 3：编译

function build() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'esbuild.js')], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const bundle = path.join(ROOT, 'out', 'extension.js');
  if (r.status !== 0 || !exists(bundle)) {
    out(r.stdout || '');
    out(r.stderr || '');
    return fail('编译失败', '可以手动运行 npm run compile 查看完整报错。');
  }
  const kb = (fs.statSync(bundle).size / 1024).toFixed(0);
  good(`编译完成（out/extension.js，${kb} KB）`);
  return true;
}

// ------------------------------------------------------------------ 步骤 4：找 VS Code

/**
 * 关键点：这台机器 PATH 里第一个 `code` 是 Qoder（VS Code 分支），
 * 直接调 `code` 会打开错误的编辑器。所以必须显式优先正版 VS Code。
 */
function findCode() {
  if (process.env.PYCAMP_CODE) {
    if (exists(process.env.PYCAMP_CODE)) {
      good(`使用环境变量指定的编辑器：${process.env.PYCAMP_CODE}`);
      return { exe: process.env.PYCAMP_CODE, label: 'PYCAMP_CODE' };
    }
    warn('环境变量 PYCAMP_CODE 指向的路径不存在，已忽略');
  }

  const la = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || '';
  const pf86 = process.env['ProgramFiles(x86)'] || '';

  // 按「正版优先」的顺序排列；每个都是 <安装根>/bin/code.cmd
  const candidates = [
    [path.join(la, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), 'Visual Studio Code'],
    [path.join(pf, 'Microsoft VS Code', 'bin', 'code.cmd'), 'Visual Studio Code'],
    [path.join(pf86, 'Microsoft VS Code', 'bin', 'code.cmd'), 'Visual Studio Code'],
    [path.join(la, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'), 'VS Code Insiders'],
    [path.join(pf, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'), 'VS Code Insiders'],
    // 以下为 VS Code 分支，只在没装正版时兜底
    [path.join(pf, 'Qoder', 'bin', 'code'), 'Qoder（VS Code 分支）'],
    [path.join(la, 'Programs', 'cursor', 'resources', 'app', 'bin', 'code.cmd'), 'Cursor（VS Code 分支）'],
    [path.join(la, 'Programs', 'Trae CN', 'bin', 'code.cmd'), 'Trae CN（VS Code 分支）'],
    [path.join(la, 'Programs', 'Trae', 'bin', 'code.cmd'), 'Trae（VS Code 分支）'],
  ];

  for (const [cmd, label] of candidates) {
    if (exists(cmd)) {
      const exe = resolveExe(cmd);
      good(`找到 ${label}`);
      info(dim(exe || cmd));
      if (label.includes('分支')) {
        warn('没找到正版 VS Code，将使用 VS Code 分支版本，界面可能略有差异');
      }
      return { exe: exe || cmd, cmd, label };
    }
  }

  // 最后退回 PATH
  const fromPath = which('code');
  if (fromPath) {
    good(`使用 PATH 中的 code：${fromPath}`);
    return { exe: resolveExe(fromPath) || fromPath, cmd: fromPath, label: 'PATH 中的 code' };
  }

  return null;
}

/** 从 bin/code.cmd 推出同安装目录下的 Code.exe，直接启动 exe 可以绕开 shell */
function resolveExe(codeCmd) {
  const installRoot = path.dirname(path.dirname(codeCmd));
  const names = ['Code.exe', 'Code - Insiders.exe', 'Qoder.exe', 'Cursor.exe', 'Trae.exe'];
  for (const n of names) {
    const p = path.join(installRoot, n);
    if (exists(p)) {
      return p;
    }
  }
  return null;
}

// ------------------------------------------------------------------ 步骤 5：学习工作区

function prepareWorkspace(dir) {
  if (!exists(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    good(`已创建学习工作区：${dir}`);
  } else {
    good(`学习工作区：${dir}`);
  }

  const readme = path.join(dir, '从这里开始.md');
  if (!exists(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# Python闯关训练营 · 学习工作区',
        '',
        '这个文件夹是给你写练习代码的地方。',
        '',
        '## 怎么用',
        '',
        '1. 左侧活动栏点「Python闯关训练营」图标（盾牌+对勾）',
        '2. 点「开始今日任务」',
        '3. 插件会在 `python-camp/` 下建好本关的 .py 文件，照着里面的注释复现示例代码、做练习题',
        '4. 写完按 `Ctrl+Alt+G` 提交批改（或 `Ctrl+Alt+R` 只运行不判分）',
        '',
        '## 文件都放在哪',
        '',
        '- `python-camp/` —— 你写的代码，一关一个文件',
        '- `.pythoncamp/` —— 进度档案、学习报告、临时文件',
        '',
        '## 隐私',
        '',
        '只有你点「提交并批改」时，才会把当前这一个文件的代码发给你配置的模型服务。',
        '插件不会扫描或上传这个文件夹里的其他内容。',
        '',
      ].join('\n'),
      'utf8'
    );
  }
  return dir;
}

// ------------------------------------------------------------------ 启动

function launch(editor, workspace, extraArgs) {
  const cargs = [...extraArgs, workspace];
  let child;
  if (editor.exe && /\.exe$/i.test(editor.exe)) {
    child = spawn(editor.exe, cargs, { detached: true, stdio: 'ignore' });
  } else {
    child = spawn(editor.cmd || editor.exe, cargs, {
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
  }
  child.unref();
  return child;
}

// ------------------------------------------------------------------ --install 模式

function packageAndInstall(editor) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const vsix = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);

  // 源码比 vsix 新就重新打包
  let needPack = !exists(vsix);
  if (!needPack) {
    const vsixTime = fs.statSync(vsix).mtimeMs;
    const srcDir = path.join(ROOT, 'src');
    const newer = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          return newer(p);
        }
        return fs.statSync(p).mtimeMs > vsixTime;
      });
    needPack = newer(srcDir) || fs.statSync(path.join(ROOT, 'package.json')).mtimeMs > vsixTime;
  }

  if (needPack) {
    info('打包 vsix…');
    const r = runNpm(['exec', '--yes', '--', '@vscode/vsce', 'package', '--no-dependencies', '--allow-missing-repository']);
    if (r.status !== 0 || !exists(vsix)) {
      warn('打包失败（可能是网络问题），改用开发宿主模式启动');
      return false;
    }
  }
  good(`vsix：${path.basename(vsix)}`);

  info('安装到 VS Code…');
  const cli = editor.cmd || editor.exe;
  const r = spawnSync(cli, ['--install-extension', vsix, '--force'], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: !/\.exe$/i.test(cli),
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    warn(`安装失败：${output.split('\n')[0] || '未知错误'}`);
    warn('改用开发宿主模式启动');
    return false;
  }
  good(`已安装 ${EXT_ID}@${pkg.version}`);
  warn('如果 VS Code 已经开着，需要按 Ctrl+Shift+P → Reload Window 让插件生效');
  return true;
}

// ------------------------------------------------------------------ --check

function runCheck() {
  out('');
  out(bold('  Python闯关训练营 · 环境诊断'));
  rule();

  step(1, 5, 'Node 环境');
  const nodeOk = checkNode();

  step(2, 5, '项目文件');
  let filesOk = true;
  for (const f of ['package.json', 'out/extension.js', 'data/levels.json', 'media/icon.ico']) {
    if (exists(path.join(ROOT, f))) {
      good(f);
    } else {
      bad(`${f} 缺失`);
      filesOk = false;
    }
  }
  if (exists(path.join(ROOT, 'node_modules', 'esbuild', 'package.json'))) {
    good('node_modules/esbuild');
  } else {
    warn('node_modules/esbuild 未安装（首次启动会自动装）');
  }
  try {
    const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'levels.json'), 'utf8'));
    good(`题库：${bank.chapters.length} 章 / ${bank.levels.length} 关`);
  } catch (e) {
    bad(`题库解析失败：${e.message}`);
    filesOk = false;
  }

  step(3, 5, 'VS Code');
  const editor = findCode();
  if (!editor) {
    bad('没有找到任何 VS Code 可执行文件');
  }

  step(4, 5, '学习工作区');
  const ws = prepareWorkspace(opt('--workspace', path.join(os.homedir(), 'Python闯关工作区')));

  step(5, 5, '结论');
  if (nodeOk && filesOk && editor) {
    good('一切就绪，双击快捷方式即可启动');
  } else {
    warn('存在需要处理的问题，见上面的 ✗ 项');
  }
  out('');
  out(dim(`  项目目录：${ROOT}`));
  out(dim(`  学习工作区：${ws}`));
  if (editor) {
    out(dim(`  编辑器：${editor.exe || editor.cmd}`));
  }
  out('');
  return nodeOk && filesOk && !!editor;
}

// ------------------------------------------------------------------ main

function main() {
  logLine(`--- launch.js start args=${JSON.stringify(args)} node=${process.versions.node}`);

  if (flag('--help') || flag('-h')) {
    out('');
    out(bold('  Python闯关训练营 · 一键启动器'));
    rule();
    out('  node scripts/launch.js                启动（开发宿主模式，始终用最新代码）');
    out('  node scripts/launch.js --install      打包并永久安装到 VS Code，再启动');
    out('  node scripts/launch.js --check        只做环境诊断，不启动');
    out('  node scripts/launch.js --dry-run      解析全部决策但不启动（自动化验证用）');
    out('  node scripts/launch.js --workspace D:\\py   指定学习工作区');
    out('  node scripts/launch.js --help         显示本帮助');
    out('');
    return;
  }

  if (flag('--check')) {
    const ok = runCheck();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  out('');
  out(bold('  Python闯关训练营'));
  rule();

  step(1, 5, '检查 Node 环境');
  if (!checkNode()) {
    return;
  }

  step(2, 5, '检查依赖');
  if (!ensureDeps()) {
    return;
  }

  step(3, 5, '编译插件');
  if (!build()) {
    return;
  }

  step(4, 5, '查找 VS Code');
  const editor = findCode();
  if (!editor) {
    fail(
      '没有找到 VS Code',
      '请先安装 Visual Studio Code：https://code.visualstudio.com/\n' +
        '        （也可以用环境变量指定：set PYCAMP_CODE=D:\\path\\to\\Code.exe）'
    );
    return;
  }

  step(5, 5, '准备工作区并启动');
  const workspace = prepareWorkspace(opt('--workspace', path.join(os.homedir(), 'Python闯关工作区')));

  const installMode = flag('--install');

  let extraArgs;
  if (installMode && packageAndInstall(editor)) {
    extraArgs = [];
    info('以已安装插件的方式启动（无「扩展开发宿主」标题）');
  } else {
    extraArgs = [`--extensionDevelopmentPath=${ROOT}`];
    if (installMode) {
      info('以开发宿主模式启动（始终使用最新代码）');
    }
  }

  // --dry-run：只把决策结果打印出来，不真的启动编辑器（便于自动化验证）
  if (flag('--dry-run')) {
    out('');
    rule();
    out(bold('  [dry-run] 不会真的启动编辑器'));
    out(`      可执行文件：${editor.exe || editor.cmd}`);
    out(`      参数：${JSON.stringify([...extraArgs, workspace])}`);
    out(`      工作区：${workspace}`);
    out('');
    logLine(`DRYRUN editor=${editor.exe || editor.cmd} argv=${JSON.stringify([...extraArgs, workspace])}`);
    return;
  }

  try {
    launch(editor, workspace, extraArgs);
  } catch (e) {
    fail(`启动失败：${e.message}`);
    return;
  }

  out('');
  rule();
  good(`已启动 ${editor.label}`);
  out(`      ${dim('工作区：')}${workspace}`);
  out(`      ${dim('提示：')}左侧活动栏点「Python闯关训练营」→「开始今日任务」`);
  out('');
  out(dim('  这个窗口可以关掉了。'));
  out('');
  logLine(`LAUNCH ok editor=${editor.exe || editor.cmd} workspace=${workspace} args=${JSON.stringify(extraArgs)}`);
}

main();
