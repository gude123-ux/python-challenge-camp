/**
 * smoke.build.js —— 把 scripts/smoke.ts 打包成可在 Node 里直接跑的脚本
 *
 * 关键点：把 `vscode` 这个 import 别名到 scripts/vscode-stub.js，
 * 这样核心逻辑不需要真的跑在 VS Code 里就能测试。
 */

const esbuild = require('esbuild');
const path = require('path');

esbuild
  .build({
    entryPoints: ['scripts/smoke.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'out-smoke/smoke.js',
    sourcemap: 'inline',
    logLevel: 'info',
    alias: {
      vscode: path.resolve(__dirname, 'vscode-stub.js'),
    },
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
