const esbuild = require('esbuild');

const production = process.argv.includes('--minify');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const extensionBuild = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
};

// 冒烟测试入口:仅依赖纯 Node 的 src/cli.ts,可在无 VSCode 环境下运行
const smokeBuild = {
  ...shared,
  entryPoints: ['src/smoke.ts'],
  outfile: 'dist/smoke.cjs',
};

// 集成测试入口:@vscode/test-electron 在扩展宿主中加载运行
const integrationTestBuild = {
  ...shared,
  entryPoints: ['src/test/main.ts'],
  outfile: 'dist/test/main.cjs',
};

// MCP 服务器入口:独立 stdio 进程(vscode MCP provider 启动),bundle MCP SDK(始终产出,随 vsix 发布)
// 注意:.mts(ESM)入口,与 MCP SDK 的 ESM 类型对齐;产物为 CJS 单文件。
// alias:tsc 的类型解析要求不带 .js 后缀,esbuild 的 exports 解析要求带 .js,alias 做桥接
const mcpServerBuild = {
  ...shared,
  entryPoints: ['src/mcp/server.mts'],
  outfile: 'dist/mcp-server.cjs',
  alias: {
    '@modelcontextprotocol/sdk/server/mcp': '@modelcontextprotocol/sdk/server/mcp.js',
    '@modelcontextprotocol/sdk/server/stdio': '@modelcontextprotocol/sdk/server/stdio.js',
  },
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(extensionBuild);
    await ctx.watch();
  } else {
    await esbuild.build(extensionBuild);
    await esbuild.build(mcpServerBuild);
    // 仅开发构建时产出测试产物(minify/publish 产物无需)
    if (!production) {
      await esbuild.build(smokeBuild);
      await esbuild.build(integrationTestBuild);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
