import * as vscode from 'vscode';
import type { ConnectedDevice } from './types';

export class UuStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'UU远程';
    this.item.command = 'uu.showDeviceStatus';
    this.item.hide();
  }

  update(connected: ConnectedDevice[], cliError?: string): void {
    if (cliError) {
      this.item.text = '$(circle-slash) UU远程';
      this.item.tooltip = `无法连接 UU远程主应用:${cliError}(点击查看状态)`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = `$(radio-tower) UU远程: ${connected.length}`;
      this.item.tooltip = connected.length
        ? `已连接 ${connected.length} 台:${connected.map((c) => c.targetName).join('、')}(点击查看状态)`
        : 'UU远程:当前无已连接设备(点击查看状态)';
      this.item.backgroundColor = undefined;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
