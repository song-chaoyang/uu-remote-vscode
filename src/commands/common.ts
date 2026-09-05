import * as vscode from 'vscode';
import { resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log, showOutput } from '../log';
import type { CloudPC, Device, UserInfo } from '../types';
import { CloudPcTreeItem } from '../providers/cloudPcTreeProvider';
import { DeviceTreeItem, UserTreeItem } from '../providers/deviceTreeProvider';

/** 解析 CLI 路径后执行;失败时统一弹错误提示,返回 undefined */
export async function withCli<T>(fn: (cliPath: string) => Promise<T>): Promise<T | undefined> {
  try {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    return await fn(cliPath);
  } catch (e) {
    showCliError(e);
    return undefined;
  }
}

export function showCliError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  log(`错误:${msg}`);
  void vscode.window.showErrorMessage(`UU远程:${msg}`, '查看日志').then((btn) => {
    if (btn === '查看日志') {
      showOutput();
    }
  });
}

export function ok(msg: string): void {
  void vscode.window.showInformationMessage(`UU远程:${msg}`);
}

export function warn(msg: string): void {
  void vscode.window.showWarningMessage(`UU远程:${msg}`);
}

interface DevicePickItem extends vscode.QuickPickItem {
  device: Device;
}

export async function pickDevice(devices: Device[], placeHolder: string): Promise<Device | undefined> {
  if (devices.length === 0) {
    warn('未获取到设备列表,请先刷新并确认 UU远程主应用已运行');
    return undefined;
  }
  const picks: DevicePickItem[] = devices.map((d) => ({
    label: `${d.isOnline ? '$(radio-tower)' : '$(circle-outline)'} ${d.deviceName}`,
    description: d.deviceId,
    detail: d.isOnline ? '在线' : '离线',
    device: d,
  }));
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder });
  return chosen?.device;
}

interface CloudPcPickItem extends vscode.QuickPickItem {
  pc: CloudPC;
}

export async function pickCloudPc(cloudpcs: CloudPC[], placeHolder: string): Promise<CloudPC | undefined> {
  if (cloudpcs.length === 0) {
    warn('未获取到云电脑列表,请先刷新');
    return undefined;
  }
  const picks: CloudPcPickItem[] = cloudpcs.map((pc) => ({
    label: pc.name,
    description: pc.cloudPCId,
    detail: `状态:${pc.status}`,
    pc,
  }));
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder });
  return chosen?.pc;
}

/** 在集成终端中以 CLI 本体作为终端进程运行交互式命令(term / lterm 的 TUI) */
export async function runInteractive(name: string, args: string[]): Promise<void> {
  try {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    const term = vscode.window.createTerminal({ name, shellPath: cliPath, shellArgs: args });
    term.show();
    log(`已启动交互式终端 [${name}]: uuyc-cli ${args.join(' ')}`);

    // 非零退出码诊断(实测退出码 6 = 本机主控端版本低于被控端,需要升级本机 UU远程)
    const closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === term) {
        closeSub.dispose();
        clearTimeout(guard);
        const code = closed.exitStatus?.code;
        if (code !== undefined && code !== 0) {
          const tip =
            code === 6
              ? `远程终端异常退出(退出码 6):本机 UU远程主控端版本低于被控端,请到 uuyc.163.com/download 升级本机 UU远程 后重试`
              : `远程终端异常退出(退出码 ${code}),请确认设备在线、主应用已运行,并查看输出日志`;
          void vscode.window.showErrorMessage(`UU远程:${tip}`, '查看日志').then((btn) => {
            if (btn === '查看日志') {
              showOutput();
            }
          });
        }
      }
    });
    // 兜底:终端存活超 10 分钟时移除监听,避免悬挂订阅
    const guard = setTimeout(() => closeSub.dispose(), 10 * 60 * 1000);
  } catch (e) {
    showCliError(e);
  }
}

/**
 * 从树视图菜单/内联按钮传入的选择项解析目标对象;命令面板直接调用(无选择)时回退 QuickPick。
 * VSCode 对 view/item 菜单命令传入选中元素数组,命令面板调用时为空。
 * S = 树节点携带的目标类型;T = 最终解析类型(允许 picker 返回扩展目标,如 "全部" 哨兵)
 */
export function resolveFromSelection<S, T = S>(
  selection: unknown,
  current: S[],
  picker: (items: S[], placeHolder: string) => Promise<T | undefined>,
  placeHolder: string,
): Promise<T | undefined> {
  const first = Array.isArray(selection) ? selection[0] : selection;
  const picked = extractTarget<S>(first);
  if (picked !== undefined) {
    return Promise.resolve(picked as unknown as T);
  }
  return picker(current, placeHolder);
}

function extractTarget<T>(node: unknown): T | undefined {
  if (node instanceof DeviceTreeItem) {
    return node.device as unknown as T;
  }
  if (node instanceof CloudPcTreeItem) {
    return node.pc as unknown as T;
  }
  if (node instanceof UserTreeItem) {
    return node.user as unknown as T;
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    // executeCommand 复用时可能直接传入原始对象;
    // ID 必须为非空字符串,防止字段缺失/为空的对象被误当作目标执行命令
    // (实测曾出现「连接设备 undefined(undefined)」)
    if (typeof rec['deviceId'] === 'string' && rec['deviceId'].length > 0) {
      return node as unknown as T;
    }
    if (typeof rec['cloudPCId'] === 'string' && rec['cloudPCId'].length > 0) {
      return node as unknown as T;
    }
    if (typeof rec['userId'] === 'string' && rec['userId'].length > 0 && 'nickname' in rec) {
      return node as unknown as T;
    }
  }
  return undefined;
}

/** 解析用户节点:树节点 selection 优先,否则查询当前登录用户 */
export async function resolveUser(selection: unknown, fetch: () => Promise<UserInfo | undefined>): Promise<UserInfo | undefined> {
  const first = Array.isArray(selection) ? selection[0] : selection;
  const fromTree = extractTarget<UserInfo>(first);
  if (fromTree !== undefined) {
    return fromTree;
  }
  return fetch();
}

export function registerCommand(context: vscode.ExtensionContext, id: string, fn: (...args: unknown[]) => unknown): void {
  context.subscriptions.push(vscode.commands.registerCommand(id, fn));
}

export async function confirmModal(message: string, confirmLabel: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
  return choice === confirmLabel;
}
