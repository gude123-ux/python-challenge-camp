#!/usr/bin/env node
/**
 * gen-tutorials.js —— 批量生成「本关精讲」
 *
 * 为什么需要它：精讲是 AI 生成的，逐关在编辑器里点太慢。
 * 这个脚本一次把整本课程（或指定范围）的精讲全部生成好，落盘缓存；
 * **已存在的文件会跳过**，所以可以随时中断、随时续跑。
 *
 * 用法（在项目根目录）：
 *   node scripts/gen-tutorials.js                 # 生成全部缺失的
 *   node scripts/gen-tutorials.js --from 8 --to 20
 *   node scripts/gen-tutorials.js --force          # 全部重新生成
 *   node scripts/gen-tutorials.js --delay 2000     # 每次调用之间多等 2 秒
 *
 * 配置来源：优先命令行，其次 VS Code 用户设置里的 pythonCamp.*（和插件用同一套配置），
 * 也可以用环境变量 PYTHON_CAMP_API_KEY / PYTHON_CAMP_BASE_URL / PYTHON_CAMP_MODEL。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return process.argv.includes('--' + name) ? true : def;
}

/** 读 VS Code 用户设置里的 pythonCamp.*（和插件读的是同一份） */
function readVscodeSettings() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
    path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* 下一个 */
    }
  }
  return {};
}

/** 把 TS 源码打成 CommonJS 临时包，供脚本直接 require */
function bundle(entries, outfile) {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
  esbuild.buildSync({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'error',
  });
}

async function main() {
  const settings = readVscodeSettings();
  const baseUrl = arg('baseUrl') || process.env.PYTHON_CAMP_BASE_URL || settings['pythonCamp.apiBaseUrl'];
  const apiKey = arg('apiKey') || process.env.PYTHON_CAMP_API_KEY || settings['pythonCamp.apiKey'];
  const model = arg('model') || process.env.PYTHON_CAMP_MODEL || settings['pythonCamp.model'] || 'gpt-4o-mini';
  const timeoutSec = Number(arg('timeout', settings['pythonCamp.aiTimeoutSec'] || 120));
  const maxTokens = Number(arg('maxTokens', settings['pythonCamp.maxTokens'] || 8000));
  const delayMs = Number(arg('delay', 800));
  const from = Number(arg('from', 1));
  const to = Number(arg('to', 999));
  const force = !!arg('force', false);
  const outDir =
    arg('out') ||
    process.env.PYTHON_CAMP_WORKDIR ||
    path.join(os.homedir(), 'Python闯关工作区', 'python-camp', '精讲');

  if (!baseUrl || !apiKey) {
    console.error(
      '缺少模型配置。请在 VS Code 设置里配好 pythonCamp.apiBaseUrl / pythonCamp.apiKey，\n' +
        '或用 --baseUrl/--apiKey 传入，或设置 PYTHON_CAMP_BASE_URL / PYTHON_CAMP_API_KEY。'
    );
    process.exit(2);
  }

  const tmp = path.join(ROOT, '.tmp-gen-tutorials');
  fs.mkdirSync(tmp, { recursive: true });
  const promptJs = path.join(tmp, 'prompt.js');
  const prereqJs = path.join(tmp, 'prereq.js');
  const clientJs = path.join(tmp, 'client.js');
  bundle([path.join(ROOT, 'src', 'ai', 'prompt.ts')], promptJs);
  bundle([path.join(ROOT, 'src', 'core', 'prereq.ts')], prereqJs);
  bundle([path.join(ROOT, 'src', 'ai', 'client.ts')], clientJs);
  const refsJs = path.join(tmp, 'refs.js');
  bundle([path.join(ROOT, 'src', 'core', 'refs.ts')], refsJs);

  const { buildTutorialMessages } = require(promptJs);
  const { findPrerequisites, prerequisitesToText } = require(prereqJs);
  const { exerciseRefsToText } = require(refsJs);
  const { chat } = require(clientJs);

  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'levels.json'), 'utf8'));
  const levels = bank.levels.filter((l) => l.day >= from && l.day <= to).sort((a, b) => a.day - b.day);
  fs.mkdirSync(outDir, { recursive: true });

  const header = (lv) =>
    [
      `> 本文件由 AI 生成于 ${new Date().toLocaleString()}，用于讲解「怎么做」，不直接给完整答案。`,
      `> 想要逐题完整代码，看同目录下的《第${String(lv.day).padStart(2, '0')}关_参考答案.md》。`,
      '',
      `**关卡**：第 ${lv.day} 关 · ${lv.title}　　**模型**：${model}`,
      '',
      '---',
      '',
    ].join('\n');

  const todo = levels.filter((lv) => {
    const f = path.join(outDir, `第${String(lv.day).padStart(2, '0')}关_精讲.md`);
    return force || !fs.existsSync(f);
  });

  console.log(`共 ${levels.length} 关，待生成 ${todo.length} 关（已有缓存的自动跳过）`);
  console.log(`输出目录：${outDir}`);
  console.log(`模型：${model} @ ${baseUrl}\n`);

  let ok = 0;
  let fail = 0;
  const failed = [];
  for (let i = 0; i < todo.length; i++) {
    const lv = todo[i];
    const file = path.join(outDir, `第${String(lv.day).padStart(2, '0')}关_精讲.md`);
    const prereq = findPrerequisites(lv, bank.levels, 3);
    const t0 = Date.now();
    try {
      const r = await chat({
        baseUrl,
        apiKey,
        model,
        messages: buildTutorialMessages(
          lv,
          [prerequisitesToText(prereq), exerciseRefsToText(lv, bank.levels)].filter(Boolean).join('\n\n')
        ),
        maxTokens,
        timeoutMs: timeoutSec * 1000,
        retryTransient: 2,
      });
      fs.writeFileSync(file, header(lv) + r.content + '\n', 'utf8');
      ok += 1;
      console.log(
        `[${i + 1}/${todo.length}] 第 ${lv.day} 关 ✓ ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          `${r.content.length} 字符 · 前置 ${prereq.map((p) => p.day).join('/') || '无'}`
      );
    } catch (e) {
      fail += 1;
      failed.push(lv.day);
      console.log(`[${i + 1}/${todo.length}] 第 ${lv.day} 关 ✗ ${e.kind || ''} ${String(e.message).slice(0, 90)}`);
    }
    if (delayMs > 0 && i < todo.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log(`\n完成：成功 ${ok} 关，失败 ${fail} 关`);
  if (failed.length) {
    console.log(`失败清单（重跑一次即可续上）：${failed.join(', ')}`);
    console.log(`  node scripts/gen-tutorials.js --from ${failed[0]} --to ${failed[failed.length - 1]}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('批量生成失败：', e);
  process.exit(1);
});
