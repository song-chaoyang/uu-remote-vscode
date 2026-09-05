import * as vscode from 'vscode';
import { getDeviceStatus, getUserInfo, listDevices, platformName, resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log } from '../log';
import type { ConnectedDevice, Device, UserInfo } from '../types';
import { StatusTreeItem } from './statusTreeItem';

export class DeviceTreeItem extends vscode.TreeItem {
  constructor(public readonly device: Device, connected: boolean) {
    super(device.deviceName, vscode.TreeItemCollapsibleState.None);
    this.id = device.deviceId;
    const platform = platformName(device.platform);
    const parts = [device.deviceId, platform].filter(Boolean);
    this.description = parts.join(' · ') + (connected ? ' · 已连接' : '');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${device.deviceName}**`,
        `- 设备 ID:\`${device.deviceId}\``,
        `- 状态:${device.isOnline ? '在线' : '离线'}${connected ? '(已连接)' : ''}`,
        platform ? `- 平台:${platform}` : '',
        connected ? '\n- 已连接:右键可断开连接' : '\n- 在线设备:右键可启动串流、打开远程终端或附加到编辑器\n- 单击查看详情',
      ].join('\n'),
    );
    this.iconPath = connected
      ? new vscode.ThemeIcon('plug')
      : device.isOnline
        ? new vscode.ThemeIcon('radio-tower')
        : new vscode.ThemeIcon('circle-outline');
    this.contextValue = device.isOnline ? 'device-online' : 'device-offline';
    // 单击直达详情面板(Webview);右键为完整操作菜单
    this.command = {
      title: '设备详情',
      command: 'uu.showDeviceDetails',
      arguments: [this],
    };
  }
}

/** 当前登录用户节点(树顶部) */
export class UserTreeItem extends vscode.TreeItem {
  constructor(public readonly user: UserInfo) {
    super(user.nickname, vscode.TreeItemCollapsibleState.None);
    this.id = `user-${user.userId}`;
    this.description = user.isVip ? 'VIP' : '非 VIP';
    this.iconPath = new vscode.ThemeIcon(user.isVip ? 'star-full' : 'account');
    this.contextValue = 'uu-user';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${user.nickname}**`,
        `- 用户 ID:\`${user.userId}\``,
        `- 会员:${user.isVip ? 'VIP' : '非 VIP'}`,
        '\n右键:用户详情 / 钱包余额 / 复制用户 ID / 退出登录',
      ].join('\n'),
    );
  }
}

/** 在线 / 离线分组节点 */
export class DeviceGroupTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: DeviceTreeItem[],
    kind: 'online' | 'offline',
  ) {
    super(`${label} (${children.length})`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `group-${kind}`;
    this.contextValue = `uu-group-${kind}`;
    this.iconPath = new vscode.ThemeIcon(kind === 'online' ? 'circle-filled' : 'circle-outline');
    this.tooltip = `${label}:${children.length} 台(右键刷新;设备行右键为完整操作菜单)`;
  }
}

type DeviceTreeElement = UserTreeItem | DeviceGroupTreeItem | DeviceTreeItem | StatusTreeItem;

type ProviderState =
  | { kind: 'ready'; user: UserInfo; devices: Device[]; connectedIds: Set<string>; connectedList: ConnectedDevice[] }
  | { kind: 'app-not-running' }
  | { kind: 'not-logged-in' }
  | { kind: 'cli-missing' };

export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceTreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DeviceTreeElement | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: ProviderState = { kind: 'app-not-running' };
  private polling = false;
  lastError: string | undefined;

  get currentDevices(): Device[] {
    return this.state.kind === 'ready' ? this.state.devices : [];
  }

  get currentUser(): UserInfo | undefined {
    return this.state.kind === 'ready' ? this.state.user : undefined;
  }

  get connectedDevices(): ConnectedDevice[] {
    return this.state.kind === 'ready' ? this.state.connectedList : [];
  }

  /** 拉取用户信息、设备列表与连接状态;根据失败情况切换引导状态节点 */
  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
      const [devices, connected, user] = await Promise.all([
        listDevices(cliPath).catch(() => undefined),
        getDeviceStatus(cliPath).catch(() => undefined),
        getUserInfo(cliPath).catch(() => undefined),
      ]);
      if (devices === undefined && user === undefined) {
        // 全部查询失败:主应用未运行 / 通信不可达
        this.state = { kind: 'app-not-running' };
      } else if (user === undefined) {
        // 列表可查但用户信息缺失:疑似未登录
        this.state = { kind: 'not-logged-in' };
      } else {
        this.state = {
          kind: 'ready',
          user,
          devices: devices ?? [],
          connectedIds: new Set((connected ?? []).map((c) => c.targetId)),
          connectedList: connected ?? [],
        };
      }
      this.lastError = undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      log(`设备列表刷新失败:${msg}`);
      this.state = /未找到 uuyc-cli|uu\.cliPath/.test(msg) ? { kind: 'cli-missing' } : { kind: 'app-not-running' };
    } finally {
      this.polling = false;
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: DeviceTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeviceTreeElement): vscode.ProviderResult<DeviceTreeElement[]> {
    if (element instanceof DeviceGroupTreeItem) {
      return element.children;
    }
    if (element) {
      return [];
    }
    switch (this.state.kind) {
      case 'ready': {
        const { user, devices, connectedIds } = this.state;
        const items: DeviceTreeElement[] = [new UserTreeItem(user)];
        const online = devices.filter((d) => d.isOnline);
        const offline = devices.filter((d) => !d.isOnline);
        if (online.length > 0) {
          items.push(
            new DeviceGroupTreeItem(
              '在线设备',
              online.map((d) => new DeviceTreeItem(d, connectedIds.has(d.deviceId))),
              'online',
            ),
          );
        }
        if (offline.length > 0) {
          items.push(new DeviceGroupTreeItem('离线设备', offline.map((d) => new DeviceTreeItem(d, false)), 'offline'));
        }
        return items;
      }
      case 'app-not-running':
        return [StatusTreeItem.appNotRunning()];
      case 'not-logged-in':
        return [StatusTreeItem.notLoggedIn()];
      case 'cli-missing':
        return [StatusTreeItem.cliMissing()];
    }
  }
}
