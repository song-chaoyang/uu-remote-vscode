import * as vscode from 'vscode';

/**
 * 状态引导节点:CLI 缺失 / 主应用未运行 / 未登录时显示在树顶部,
 * label 即问题、description 即引导、点击节点直接执行对应动作。
 */
export class StatusTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    iconId: string,
    contextValue: string,
    commandId?: string,
    commandTitle?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = contextValue;
    if (commandId) {
      this.command = {
        title: commandTitle ?? label,
        command: commandId,
        tooltip: description,
      };
    }
  }

  /** 主应用未运行 → 点击启动 GameViewer */
  static appNotRunning(): StatusTreeItem {
    return new StatusTreeItem(
      'UU远程主应用未运行',
      '点击启动主程序 · 修复后自动刷新',
      'debug-restart',
      'uu-status-app',
      'uu.launchMainApp',
      '启动 UU远程主程序',
    );
  }

  /** 疑似未登录 → 点击启动主程序(主程序内完成登录) */
  static notLoggedIn(): StatusTreeItem {
    return new StatusTreeItem(
      '尚未登录 UU远程',
      '点击打开主程序完成登录',
      'key',
      'uu-status-login',
      'uu.launchMainApp',
      '打开 UU远程主程序登录',
    );
  }

  /** CLI 未找到 → 点击打开安装引导(下载官网 / 设置路径) */
  static cliMissing(): StatusTreeItem {
    return new StatusTreeItem(
      '未找到 uuyc-cli',
      '点击打开安装引导 · 或设置 CLI 路径',
      'error',
      'uu-status-cli',
      'uu.cliMissingGuide',
      '打开安装引导',
    );
  }
}
