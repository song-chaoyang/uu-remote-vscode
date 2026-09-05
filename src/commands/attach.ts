import * as vscode from 'vscode';
import { resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log } from '../log';
import { uriForWinPath } from '../remoteFs';
import { TermBridge } from '../termBridge';
import type { Device } from '../types';
import { DeviceTreeProvider } from '../providers/deviceTreeProvider';
import { ok, pickDevice, registerCommand, resolveFromSelection, showCliError } from './common';

interface StartDirPickItem extends vscode.QuickPickItem {
  path: string | undefined;
}

/**
 * 附加到编辑器:把远程设备的文件系统挂载为 uu-remote:// 虚拟工作区,
 * 在新窗口中像 Remote-SSH 一样浏览、编辑、保存远程文件。
 */
export function registerAttachCommands(context: vscode.ExtensionContext, deviceProvider: DeviceTreeProvider): void {
  registerCommand(context, 'uu.attachToEditor', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要附加到编辑器的设备');
    if (!dev) {
      return;
    }
    await attachFlow(dev);
  });
}

async function attachFlow(dev: Device): Promise<void> {
  // 「附加到编辑器」基于 PowerShell 文件协议,面向 Windows 被控端
  // (platform 1 与 4 均实测为 Windows,不再做前置拦截)。
  // 若被控端实际不是 Windows、或本机主控端版本过低,握手阶段会失败,
  // 由下方 catch 给出带上下文的诊断而非误报。
  let bridge: TermBridge | undefined;
  try {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    bridge = new TermBridge(cliPath, dev.deviceId, 'powershell', (line) => log(`[${dev.deviceId}] ${line}`));
    const homeRows = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `UU远程:正在连接「${dev.deviceName}」并获取远程主目录…` },
      () => bridge!.exec('$env:USERPROFILE', { timeoutMs: 25000 }),
    );
    const home = homeRows[0];
    const picks: StartDirPickItem[] = [];
    if (home) {
      picks.push({ label: `$(home) ${home}`, description: '远程用户主目录', path: home });
    }
    picks.push({ label: '$(root-folder) C:\\', description: 'C 盘根目录', path: 'C:\\' });
    picks.push({ label: '$(edit) 自定义路径…', description: '输入远程 Windows 路径', path: undefined });

    const chosen = await vscode.window.showQuickPick(picks, { placeHolder: '选择要在编辑器中打开的远程目录' });
    if (!chosen) {
      return;
    }
    let path = chosen.path;
    if (path === undefined) {
      const input = await vscode.window.showInputBox({
        prompt: '输入远程起始目录(Windows 路径)',
        placeHolder: '例如 C:\\Projects\\demo',
        ignoreFocusOut: true,
      });
      if (input === undefined || !input.trim()) {
        return;
      }
      path = input.trim();
    }
    const uri = uriForWinPath(dev.deviceId, path);
    ok(`正在新窗口打开「${dev.deviceName}」的 ${path}(首次加载目录可能需要数秒)`);
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 握手失败:可能是本机主控端版本过低(CLI 会报"版本过低"),也可能是被控端非 Windows
    if (/无法就绪|超时|版本过低/.test(msg)) {
      void vscode.window
        .showErrorMessage(
          `UU远程:「附加到编辑器」连接「${dev.deviceName}」失败 —— ${msg}。常见原因:① 本机 UU远程 主控端版本低于被控端,请到 uuyc.163.com/download 升级本机后重试;② 该设备不是 Windows 被控端(当前仅支持 Windows)。`,
          '打开下载页',
          '查看日志',
        )
        .then((btn) => {
          if (btn === '打开下载页') {
            void vscode.env.openExternal(vscode.Uri.parse('https://uuyc.163.com/download'));
          } else if (btn === '查看日志') {
            void vscode.commands.executeCommand('uu.showOutput');
          }
        });
    } else {
      showCliError(e);
    }
  } finally {
    void bridge?.dispose().catch(() => undefined);
  }
}
