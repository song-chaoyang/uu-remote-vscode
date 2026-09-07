import * as vscode from 'vscode';
import { setBitrateLimit, setLitePunch, resolveCliPath } from '../cli';
import { probeCliFeatures } from '../capabilities';
import { getExtensionConfig } from '../config';
import { warn, ok, registerCommand, withCli } from './common';

/** 旧版 CLI 无 --set-bitrate-limit / --disable-lite-punch 时给出升级引导 */
async function ensureGlobals(cliPath: string): Promise<boolean> {
  const feats = await probeCliFeatures(cliPath);
  if (feats.bitrateAndPunch) {
    return true;
  }
  warn('当前 uuyc-cli 版本不支持码率上限 / 连接模式设置。请升级本机 UU远程主程序到最新版本后重试。');
  return false;
}

export function registerSettingsCommands(context: vscode.ExtensionContext): void {
  registerCommand(context, 'uu.setBitrateLimit', async () => {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureGlobals(cliPath))) {
      return;
    }
    const input = await vscode.window.showInputBox({
      prompt: '设置远程连接的最大码率上限(Mbps)',
      placeHolder: '1-500;输入 0 表示不限制',
      validateInput: (v) => (/^(0|[1-9]\d{0,2})$/.test(v.trim()) && Number(v) <= 500 ? undefined : '请输入 0-500 之间的整数(0 表示不限制)'),
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return;
    }
    const mbps = Number(input.trim());
    const result = await withCli((cliPath) => setBitrateLimit(cliPath, mbps));
    if (result !== undefined) {
      ok(`码率上限已设置:${mbps === 0 ? '不限制' : `${mbps} Mbps`}(${result})`);
    }
  });

  registerCommand(context, 'uu.toggleLitePunch', async () => {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureGlobals(cliPath))) {
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      [
        {
          label: '$(globe) 完整模式',
          description: 'disable-lite-punch = true',
          detail: '禁用 Lite Punch,使用完整连接流程(兼容性更好)',
          value: true,
        },
        {
          label: '$(zap) 精简模式',
          description: 'disable-lite-punch = false',
          detail: '启用 Lite Punch 轻量打洞,连接更快',
          value: false,
        },
      ],
      { placeHolder: '选择连接模式' },
    );
    if (!chosen) {
      return;
    }
    const result = await withCli((cliPath) => setLitePunch(cliPath, chosen.value));
    if (result !== undefined) {
      ok(`连接模式已切换:${chosen.value ? '完整模式' : '精简模式(Lite Punch)'}`);
    }
  });

  registerCommand(context, 'uu.openCliSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'uu.cliPath');
  });
}
