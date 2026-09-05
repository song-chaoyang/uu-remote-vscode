import * as vscode from 'vscode';
import { getExtensionConfig } from './config';
import { resolveCliPath } from './cli';
import { registerLmTools } from './lmTools';
import { log } from './log';
import { registerMcpProvider } from './mcpProvider';
import { CloudPcTreeProvider } from './providers/cloudPcTreeProvider';
import { DeviceTreeProvider } from './providers/deviceTreeProvider';
import { UuRemoteFsProvider, UU_FS_SCHEME } from './remoteFs';
import { UuStatusBar } from './statusBar';
import { registerAttachCommands } from './commands/attach';
import { registerCloudPcCommands } from './commands/cloudpc';
import { registerDeviceCommands } from './commands/device';
import { registerDiagCommands } from './commands/diag';
import { registerRemoteActions } from './commands/remoteActions';
import { registerWirelessScreenCommands } from './commands/wirelessScreen';
import { registerSettingsCommands } from './commands/settings';
import { registerTermCommands, UuTerminalProfileProvider } from './commands/term';
import { registerUserCommands } from './commands/user';

/** 首次使用引导:CLI 缺失时弹安装引导(全局仅提示一次) */
async function firstRunGuide(context: vscode.ExtensionContext): Promise<void> {
  try {
    await resolveCliPath(getExtensionConfig().cliPath);
  } catch {
    const shown = context.globalState.get('uu.cliMissingGuideShown', false);
    if (shown) {
      return;
    }
    void context.globalState.update('uu.cliMissingGuideShown', true);
    const choice = await vscode.window.showWarningMessage(
      'UU远程助手:未检测到 UU远程(uuyc-cli),插件功能暂不可用。下载安装后即可使用。',
      '下载安装',
      '设置 CLI 路径',
    );
    if (choice === '下载安装') {
      await vscode.commands.executeCommand('uu.downloadUuRemote');
    } else if (choice === '设置 CLI 路径') {
      await vscode.commands.executeCommand('uu.openCliSettings');
    }
  }
}

/** 设备/云电脑列表与状态栏的轮询刷新(自动刷新间隔由 uu.autoRefreshSeconds 控制) */
class Refresher implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deviceProvider: DeviceTreeProvider,
    private readonly cloudPcProvider: CloudPcTreeProvider,
    private readonly statusBar: UuStatusBar,
  ) {}

  async refresh(): Promise<void> {
    await Promise.all([this.deviceProvider.poll(), this.cloudPcProvider.poll()]);
    this.statusBar.update(this.deviceProvider.connectedDevices, this.deviceProvider.lastError);
  }

  restart(): void {
    this.stop();
    const seconds = getExtensionConfig().autoRefreshSeconds;
    if (seconds > 0) {
      this.timer = setInterval(() => void this.refresh(), seconds * 1000);
    }
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const deviceProvider = new DeviceTreeProvider();
  const cloudPcProvider = new CloudPcTreeProvider();
  const statusBar = new UuStatusBar();
  const refresher = new Refresher(deviceProvider, cloudPcProvider, statusBar);
  const fsProvider = new UuRemoteFsProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('uuDevices', deviceProvider),
    vscode.window.registerTreeDataProvider('uuCloudPcs', cloudPcProvider),
    statusBar,
    refresher,
    vscode.window.registerTerminalProfileProvider('uu.lterm', new UuTerminalProfileProvider()),
    // uu-remote:// 虚拟文件系统(「附加到编辑器」)
    vscode.workspace.registerFileSystemProvider(UU_FS_SCHEME, fsProvider, {
      isCaseSensitive: false,
      isReadonly: false,
    }),
    { dispose: () => void fsProvider.disposeAll() },
  );

  registerDeviceCommands(context, deviceProvider);
  registerCloudPcCommands(context, cloudPcProvider);
  registerUserCommands(context);
  registerSettingsCommands(context);
  registerTermCommands(context, deviceProvider);
  registerDiagCommands(context);
  registerAttachCommands(context, deviceProvider);
  registerRemoteActions(context, deviceProvider);
  registerWirelessScreenCommands(context, deviceProvider);

  // AI 集成:内嵌 MCP 服务器(供 Copilot agent 等所有 MCP 客户端)+ Copilot 原生工具
  registerMcpProvider(context);
  registerLmTools(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('uu')) {
        refresher.restart();
        void refresher.refresh();
      }
    }),
  );

  refresher.restart();
  void refresher.refresh();
  void firstRunGuide(context);
  log('UU远程助手已激活');
}

export function deactivate(): void {
  // 清理已通过 context.subscriptions 托管
}
