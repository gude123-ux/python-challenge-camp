/**
 * esbuild.js —— 打包脚本
 *
 * 把 src/extension.ts 打成一个 out/extension.js，vscode 模块保持 external。
 * 用法：
 *   node esbuild.js            开发构建（带 sourcemap）
 *   node esbuild.js --watch    监听
 *   node esbuild.js --production  发布构建（压缩）
 */

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'out/extension.js',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`[esbuild] build done${production ? ' (production)' : ''}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
