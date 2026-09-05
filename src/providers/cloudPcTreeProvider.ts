import * as vscode from 'vscode';
import { cloudPcStatusName, listCloudPCs, resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log } from '../log';
import type { CloudPC } from '../types';
import { StatusTreeItem } from './statusTreeItem';

export class CloudPcTreeItem extends vscode.TreeItem {
  constructor(public readonly pc: CloudPC) {
    super(pc.name, vscode.TreeItemCollapsibleState.None);
    this.id = pc.cloudPCId;
    this.description = `${cloudPcStatusName(pc.status)} · ${pc.cloudPCId}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${pc.name}**`,
        `- 云电脑 ID:\`${pc.cloudPCId}\``,
        `- 状态:${cloudPcStatusName(pc.status)}(\`${pc.status}\`)`,
        `- 类型:pcType ${pc.pcType}`,
        '\n右键可开机 / 关机 / 连接 / 断开 / 查看详情',
      ].join('\n'),
    );
    this.iconPath = pc.status === 'running' ? new vscode.ThemeIcon('vm') : new vscode.ThemeIcon('circle-slash');
    this.contextValue = pc.status === 'running' ? 'cloudpc-running' : 'cloudpc-shutdown';
  }
}

type CloudPcTreeElement = CloudPcTreeItem | StatusTreeItem;

type ProviderState = { kind: 'ready'; cloudpcs: CloudPC[] } | { kind: 'app-not-running' } | { kind: 'cli-missing' };

export class CloudPcTreeProvider implements vscode.TreeDataProvider<CloudPcTreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<CloudPcTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: ProviderState = { kind: 'app-not-running' };
  private polling = false;
  lastError: string | undefined;

  get currentCloudPcs(): CloudPC[] {
    return this.state.kind === 'ready' ? this.state.cloudpcs : [];
  }

  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
      this.state = { kind: 'ready', cloudpcs: await listCloudPCs(cliPath) };
      this.lastError = undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      log(`云电脑列表刷新失败:${msg}`);
      this.state = /未找到 uuyc-cli|uu\.cliPath/.test(msg) ? { kind: 'cli-missing' } : { kind: 'app-not-running' };
    } finally {
      this.polling = false;
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: CloudPcTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<CloudPcTreeElement[]> {
    switch (this.state.kind) {
      case 'ready':
        return this.state.cloudpcs.map((pc) => new CloudPcTreeItem(pc));
      case 'app-not-running':
        return [StatusTreeItem.appNotRunning()];
      case 'cli-missing':
        return [StatusTreeItem.cliMissing()];
    }
  }
}
