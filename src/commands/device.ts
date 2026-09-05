import * as vscode from 'vscode';
import { execCliJson, getDeviceStatus, getLocalDeviceId, resetCustomCode } from '../cli';
import { log } from '../log';
import { openDeviceDetails } from '../panel';
import { DeviceTreeProvider } from '../providers/deviceTreeProvider';
import type { Device } from '../types';
import {
  confirmModal,
  ok,
  pickDevice,
  registerCommand,
  resolveFromSelection,
  warn,
  withCli,
} from './common';

interface StatusPickItem extends vscode.QuickPickItem {
  run: () => unknown;
}

export function registerDeviceCommands(context: vscode.ExtensionContext, deviceProvider: DeviceTreeProvider): void {
  const refresh = (): Promise<void> => deviceProvider.poll();

  registerCommand(context, 'uu.refreshDevices', async () => {
    log('手动刷新设备列表');
    await refresh();
  });

  registerCommand(context, 'uu.connectDevice', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要连接的设备');
    if (!dev || !dev.deviceId) {
      // ID 缺失的脏对象不再透传(曾出现「连接设备 undefined(undefined)」)
      return;
    }
    const result = await withCli(async (cliPath) => {
      const env = await execCliJson<unknown>(cliPath, ['device', 'connect', dev.deviceId]);
      log(`连接设备 ${dev.deviceName}(${dev.deviceId}):${JSON.stringify(env)}`);
      return env;
    });
    if (result) {
      ok(`已发起连接:${dev.deviceName}(若主应用弹出远程控制窗口即表示成功)`);
      await refresh();
      setTimeout(() => void refresh(), 3000);
    }
  });

  registerCommand(context, 'uu.disconnectDevice', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要断开的设备');
    if (!dev) {
      return;
    }
    const result = await withCli((cliPath) => execCliJson<unknown>(cliPath, ['device', 'disconnect', dev.deviceId]));
    if (result) {
      ok(`已断开设备:${dev.deviceName}`);
      await refresh();
    }
  });

  registerCommand(context, 'uu.disconnectAllDevices', async () => {
    const confirmed = await confirmModal('将断开所有远程设备的连接,确定?', '断开全部');
    if (!confirmed) {
      return;
    }
    const result = await withCli((cliPath) => execCliJson<unknown>(cliPath, ['device', 'disconnect']));
    if (result) {
      ok('已断开全部设备');
      await refresh();
    }
  });

  // 状态栏 / 命令面板入口:QuickPick 状态面板,所有后续操作均为可视化选择
  registerCommand(context, 'uu.showDeviceStatus', async () => {
    const connected = await withCli((cliPath) => getDeviceStatus(cliPath));
    if (!connected) {
      return;
    }
    const items: StatusPickItem[] = [];
    for (const c of connected) {
      const pseudoDevice: Device = { deviceId: c.targetId, deviceName: c.targetName, isOnline: true, platform: 0 };
      items.push({
        label: `$(plug) ${c.targetName}`,
        description: c.targetId,
        detail: '已连接 · 回车查看可用操作',
        run: async () => {
          const action = await vscode.window.showQuickPick<StatusPickItem>(
            [
              {
                label: `$(terminal) 打开远程终端`,
                run: () => vscode.commands.executeCommand('uu.term.open', pseudoDevice),
              },
              {
                label: `$(info) 查看设备详情`,
                run: () => vscode.commands.executeCommand('uu.showDeviceDetails', pseudoDevice),
              },
              {
                label: `$(debug-disconnect) 断开该设备`,
                run: () => vscode.commands.executeCommand('uu.disconnectDevice', pseudoDevice),
              },
            ],
            { placeHolder: `设备「${c.targetName}」` },
          );
          await action?.run?.();
        },
      });
    }
    items.push({
      label: '$(link) 连接新设备…',
      detail: '选择一台设备发起串流连接',
      run: () => vscode.commands.executeCommand('uu.connectDevice'),
    });
    if (connected.length > 0) {
      items.push({
        label: '$(debug-disconnect) 断开全部设备',
        run: () => vscode.commands.executeCommand('uu.disconnectAllDevices'),
      });
    }
    items.push({ label: '$(refresh) 刷新设备与状态', run: () => refresh() });
    items.push({ label: '$(output) 打开输出日志', run: () => vscode.commands.executeCommand('uu.showOutput') });

    const chosen = await vscode.window.showQuickPick<StatusPickItem>(items, {
      placeHolder: connected.length > 0 ? `已连接 ${connected.length} 台设备 — 选择操作` : '当前无已连接设备 — 选择操作',
    });
    await chosen?.run?.();
  });

  registerCommand(context, 'uu.getLocalDeviceId', async () => {
    const id = await withCli((cliPath) => getLocalDeviceId(cliPath));
    if (!id) {
      return;
    }
    void vscode.window.showInformationMessage(`UU远程:本机设备 ID:${id}`, '复制').then((btn) => {
      if (btn === '复制') {
        void vscode.env.clipboard.writeText(id);
      }
    });
  });

  registerCommand(context, 'uu.resetCustomCode', async () => {
    const code = await vscode.window.showInputBox({
      prompt: '输入新的自定义验证码',
      password: true,
      placeHolder: '将重置 UU远程主应用中的自定义验证码',
      ignoreFocusOut: true,
    });
    if (code === undefined) {
      return;
    }
    if (!code.trim()) {
      warn('验证码不能为空');
      return;
    }
    const result = await withCli((cliPath) => resetCustomCode(cliPath, code.trim()));
    if (result !== undefined) {
      ok(`自定义验证码已重置(${result})`);
    }
  });

  // 设备详情面板(Webview,内含操作按钮)
  registerCommand(context, 'uu.showDeviceDetails', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要查看详情的设备');
    if (!dev) {
      return;
    }
    openDeviceDetails(context, dev);
  });

  registerCommand(context, 'uu.copyDeviceId', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要复制 ID 的设备');
    if (!dev) {
      return;
    }
    await vscode.env.clipboard.writeText(dev.deviceId);
    ok(`已复制设备 ID:${dev.deviceId}`);
  });
}
