import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { runTests } from '@vscode/test-electron';

// 关键:本环境(Codely CLI 运行于 VSCode 扩展宿主)继承了 ELECTRON_RUN_AS_NODE=1,
// 会让 spawn 出的 Code.exe 进入纯 Node 模式并拒绝所有 CLI 参数,必须清除。
delete process.env['ELECTRON_RUN_AS_NODE'];

/** 优先复用本机已安装的 VSCode,避免 vscode-test 下载独立实例 */
function findCodeExe() {
  const envPath = process.env['VSCODE_CODE_PATH'];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execSync(`${finder} code`, { encoding: 'utf8' });
    const cmd = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .find((f) => f.toLowerCase().endsWith('.cmd') || f.toLowerCase().endsWith('code'));
    if (cmd) {
      const exe = path.join(path.dirname(path.dirname(cmd)), 'Code.exe');
      if (existsSync(exe)) {
        return exe;
      }
    }
  } catch {
    // code 不在 PATH,忽略
  }
  const candidates = [
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

async function main() {
  const root = process.cwd();
  const extensionDevelopmentPath = root;
  const extensionTestsPath = path.join(root, 'dist', 'test', 'main.cjs');
  const vscodeExecutablePath = findCodeExe();
  if (vscodeExecutablePath) {
    console.log(`使用本机 VSCode: ${vscodeExecutablePath}`);
  } else {
    console.log('未找到本机 VSCode,将由 vscode-test 下载独立实例(较慢)');
  }
  try {
    await runTests({ extensionDevelopmentPath, extensionTestsPath, vscodeExecutablePath });
  } catch (e) {
    console.error('== 集成测试失败 ==');
    console.error(e);
    process.exit(1);
  }
}

await main();
