/**
 * 远程动作:文件传输(上传/下载)、远程启动程序、重命名设备引导。
 * 文件传输基于自研 TermBridge(base64 分块通道):
 * 上传上限 512KB、下载上限 256KB(通道吞吐 ~5KB/s),更大文件请使用主程序的文件传输。
 */
import * as vscode from 'vscode';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename as pathBasename } from 'path';
import { resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log } from '../log';
import { psQuote, TermBridge } from '../termBridge';
import type { Device } from '../types';
import { DeviceTreeProvider } from '../providers/deviceTreeProvider';
import {
  ok,
  pickDevice,
  registerCommand,
  resolveFromSelection,
  showCliError,
  warn,
} from './common';

const UPLOAD_LIMIT = 512 * 1024;
const DOWNLOAD_LIMIT = 256 * 1024;

interface ProgramPickItem extends vscode.QuickPickItem {
  command?: string;
}

/** 常用程序(Windows 被控端) */
const QUICK_PROGRAMS: ProgramPickItem[] = [
  { label: '$(note) 记事本', detail: 'notepad.exe', command: 'notepad.exe' },
  { label: '$(pulse) 任务管理器', detail: 'taskmgr.exe', command: 'taskmgr.exe' },
  { label: '$(symbol-operator) 计算器', detail: 'calc.exe', command: 'calc.exe' },
  { label: '$(folder) 资源管理器', detail: 'explorer.exe', command: 'explorer.exe' },
  { label: '$(terminal) 命令提示符', detail: 'cmd.exe', command: 'cmd.exe' },
  { label: '$(browser) 自定义程序…', description: '输入程序路径或名称' },
];

async function bridgeFor(dev: Device): Promise<TermBridge> {
  const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
  return new TermBridge(cliPath, dev.deviceId, 'powershell', (line) => log(`[${dev.deviceId}] ${line}`));
}

export function registerRemoteActions(context: vscode.ExtensionContext, deviceProvider: DeviceTreeProvider): void {
  /** 上传:本机文件 → 远程设备 */
  registerCommand(context, 'uu.uploadToRemote', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要接收文件的设备');
    if (!dev || !dev.deviceId) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({ title: '选择要上传到远程设备的本地文件', canSelectMany: false });
    if (!picked || picked.length === 0) {
      return;
    }
    const localPath = picked[0].fsPath;
    if (!existsSync(localPath)) {
      warn('本地文件不存在');
      return;
    }
    let content: Buffer;
    try {
      content = readFileSync(localPath);
    } catch (e) {
      showCliError(e);
      return;
    }
    if (content.length > UPLOAD_LIMIT) {
      warn(`文件过大(${Math.round(content.length / 1024)}KB > 512KB 上限):远程通道吞吐约 5KB/s,大文件请使用 UU远程主程序的文件传输`);
      return;
    }

    const bridge = await bridgeFor(dev);
    try {
      const remotePath = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `UU远程:正在上传到「${dev.deviceName}」…` },
        async (): Promise<string> => {
          const homeRows = await bridge.exec('$env:USERPROFILE', { timeoutMs: 20000 });
          const home = homeRows[0] ?? 'C:\\Users';
          const defaultRemote = `${home.replace(/\\+$/, '')}\\${pathBasename(localPath)}`;
          const input = await vscode.window.showInputBox({
            prompt: '远程保存路径',
            value: defaultRemote,
            ignoreFocusOut: true,
          });
          return input?.trim() ?? '';
        },
      );
      if (!remotePath) {
        return;
      }
      await bridge.writeFile(remotePath, new Uint8Array(content));
      const check = await bridge.exec(
        `if (Test-Path -LiteralPath ${psQuote(remotePath)}) { (Get-Item -LiteralPath ${psQuote(remotePath)}).Length } else { 'N' }`,
        { timeoutMs: 20000 },
      );
      const written = Number(check[0] ?? '0') || 0;
      if (written === content.length) {
        ok(`已上传到「${dev.deviceName}」:${remotePath}(${content.length} 字节)`);
      } else {
        warn(`上传完成但校验异常(期望 ${content.length},实际 ${written} 字节),请核实`);
      }
      log(`上传 ${localPath} → ${dev.deviceName}:${remotePath}(${content.length} 字节)`);
    } catch (e) {
      showCliError(e);
    } finally {
      void bridge.dispose().catch(() => undefined);
    }
  });

  /** 下载:远程设备 → 本机 */
  registerCommand(context, 'uu.downloadFromRemote', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要下载文件的设备');
    if (!dev || !dev.deviceId) {
      return;
    }
    const remoteInput = await vscode.window.showInputBox({
      prompt: '远程文件路径(Windows 绝对路径)',
      placeHolder: '例如 C:\\Users\\Administrator\\report.txt',
      ignoreFocusOut: true,
    });
    if (!remoteInput?.trim()) {
      return;
    }
    const remotePath = remoteInput.trim();

    const bridge = await bridgeFor(dev);
    try {
      const rows = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `UU远程:正在从「${dev.deviceName}」读取…` },
        () => bridge.readFileB64(remotePath, DOWNLOAD_LIMIT, { timeoutMs: 120000 }),
      );
      const first = rows[0] ?? '';
      if (first === 'ISDIR') {
        warn('远程路径是目录,请输入文件路径');
        return;
      }
      if (first.startsWith('TOOBIG')) {
        warn(`远程文件过大(${Math.round((Number(first.slice(7)) || 0) / 1024)}KB > 256KB 下限),请使用 UU远程主程序的文件传输`);
        return;
      }
      const b64 = rows.map((r) => r.trim()).join('');
      const content = Buffer.from(b64, 'base64');
      const target = await vscode.window.showSaveDialog({
        title: '保存到本机',
        defaultUri: vscode.Uri.file(pathBasename(remotePath).replace(/[\\/:*?"<>|]/g, '_')),
      });
      if (!target) {
        return;
      }
      writeFileSync(target.fsPath, content);
      ok(`已下载「${dev.deviceName}」:${remotePath} → ${target.fsPath}(${content.length} 字节)`);
      log(`下载 ${dev.deviceName}:${remotePath} → ${target.fsPath}(${content.length} 字节)`);
    } catch (e) {
      showCliError(e);
    } finally {
      void bridge.dispose().catch(() => undefined);
    }
  });

  /** 远程启动程序(桌面端"快速启动程序"能力的 CLI 版) */
  registerCommand(context, 'uu.launchProgram', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要在其上启动程序的设备');
    if (!dev || !dev.deviceId) {
      return;
    }
    const picked = await vscode.window.showQuickPick(QUICK_PROGRAMS, { placeHolder: `在「${dev.deviceName}」上启动程序` });
    if (!picked) {
      return;
    }
    let command = picked.command;
    if (!command) {
      const input = await vscode.window.showInputBox({
        prompt: '输入程序路径或名称(将使用 Start-Process 启动)',
        placeHolder: '例如 C:\\Program Files\\SomeApp\\app.exe 或 notepad.exe',
        ignoreFocusOut: true,
      });
      if (!input?.trim()) {
        return;
      }
      command = input.trim();
    }
    const bridge = await bridgeFor(dev);
    try {
      const rows = await bridge.exec(`Start-Process ${psQuote(command)}; 'LAUNCHED'`, { timeoutMs: 30000 });
      const launched = rows.some((r) => r.includes('LAUNCHED'));
      if (launched) {
        ok(`已在「${dev.deviceName}」上启动:${command}`);
        log(`远程启动 ${dev.deviceName}:${command}`);
      } else {
        warn(`启动命令已发送,但未能确认结果(远程无回显),请检查 ${command} 是否存在`);
      }
    } catch (e) {
      showCliError(e);
    } finally {
      void bridge.dispose().catch(() => undefined);
    }
  });

  /** 重命名设备:CLI 未提供 rename,引导到主程序操作 */
  registerCommand(context, 'uu.renameDeviceGuide', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要重命名的设备');
    if (!dev) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `设备名称由 UU远程主程序管理(命令行暂不支持改名)。要打开主程序,在设备列表中对「${dev.deviceName}」进行重命名吗?`,
      '打开主程序',
    );
    if (choice === '打开主程序') {
      await vscode.commands.executeCommand('uu.launchMainApp');
    }
  });
}
