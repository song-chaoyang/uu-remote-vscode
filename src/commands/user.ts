import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { echo, getUserInfo, getVersion, getWallet, launchMainApp, resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log } from '../log';
import type { UserInfo } from '../types';
import { ok, registerCommand, resolveUser, warn, withCli } from './common';

/** UU远程官方下载页(Windows / macOS / iOS / Android) */
const UU_DOWNLOAD_URL = 'https://uuyc.163.com/download';

export function registerUserCommands(context: vscode.ExtensionContext): void {
  registerCommand(context, 'uu.showUserInfo', async () => {
    const user = await withCli((cliPath) => getUserInfo(cliPath));
    if (!user) {
      return;
    }
    const vip = user.isVip ? 'VIP' : '非 VIP';
    void vscode.window
      .showInformationMessage(`UU远程:当前用户 ${user.nickname}(${vip})`, '复制用户 ID')
      .then((btn) => {
        if (btn === '复制用户 ID') {
          void vscode.env.clipboard.writeText(user.userId);
        }
      });
  });

  // 用户节点右键「用户详情」:树节点优先,命令面板运行时查询当前登录用户
  registerCommand(context, 'uu.showUserDetails', async (selection: unknown) => {
    const user = await resolveUser(selection, () => withCli((cliPath) => getUserInfo(cliPath)));
    if (!user) {
      return;
    }
    const vip = user.isVip ? 'VIP' : '非 VIP';
    void vscode.window
      .showInformationMessage(`UU远程:${user.nickname}(${vip}) · 用户 ID:${user.userId}`, '复制用户 ID', '查询钱包余额')
      .then((btn) => {
        if (btn === '复制用户 ID') {
          void vscode.env.clipboard.writeText(user.userId);
        } else if (btn === '查询钱包余额') {
          void vscode.commands.executeCommand('uu.showWallet');
        }
      });
  });

  registerCommand(context, 'uu.copyUserId', async (selection: unknown) => {
    const user: UserInfo | undefined = await resolveUser(selection, () => withCli((cliPath) => getUserInfo(cliPath)));
    if (!user) {
      return;
    }
    await vscode.env.clipboard.writeText(user.userId);
    ok(`已复制用户 ID:${user.userId}`);
  });

  registerCommand(context, 'uu.showWallet', async () => {
    const wallet = await withCli((cliPath) => getWallet(cliPath));
    if (!wallet) {
      return;
    }
    ok(`U币余额:${wallet.coinBalance}`);
  });

  registerCommand(context, 'uu.showVersion', async () => {
    const version = await withCli((cliPath) => getVersion(cliPath));
    if (!version) {
      return;
    }
    ok(`UU远程 CLI 版本:${version}`);
  });

  registerCommand(context, 'uu.testEcho', async () => {
    const message = await vscode.window.showInputBox({
      prompt: '输入回显消息以测试与 UU远程主应用的通信',
      value: 'hello',
      ignoreFocusOut: true,
    });
    if (message === undefined || !message.trim()) {
      return;
    }
    const echoed = await withCli((cliPath) => echo(cliPath, message.trim()));
    if (echoed === undefined) {
      return;
    }
    ok(`主应用通信正常,回显:${echoed}`);
  });

  // ---------------------------------------------------------------------------
  // 账户与安装引导
  // ---------------------------------------------------------------------------

  /**
   * 退出登录:CLI 未提供 logout 命令,登录态由 UU远程主程序管理,
   * 因此引导用户在主程序中完成退出(账号菜单右上角)。
   */
  registerCommand(context, 'uu.logout', async () => {
    const choice = await vscode.window.showInformationMessage(
      'UU远程的登录状态由主程序管理(命令行暂不支持退出)。要打开 UU远程主程序,在其中的账号设置里退出登录吗?',
      '打开主程序',
    );
    if (choice !== '打开主程序') {
      return;
    }
    try {
      const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
      const launch = launchMainApp(cliPath);
      if (!launch) {
        warn('未找到 UU远程主程序,请手动打开后在账号设置中退出登录');
        return;
      }
      spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' }).unref();
      ok('已打开 UU远程主程序,请在其中的账号/头像菜单里退出登录;完成后本插件会自动检测到未登录状态');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`无法启动主程序:${msg}`);
    }
  });

  /** 打开 UU远程官方下载页(Windows / macOS / iOS / Android) */
  registerCommand(context, 'uu.downloadUuRemote', async () => {
    await vscode.env.openExternal(vscode.Uri.parse(UU_DOWNLOAD_URL));
    log(`已打开 UU远程下载页:${UU_DOWNLOAD_URL}`);
  });

  /** CLI 未找到时的可视化安装引导 */
  registerCommand(context, 'uu.cliMissingGuide', async () => {
    const choice = await vscode.window.showInformationMessage(
      '未找到 uuyc-cli(通常意味着本机未安装 UU远程主程序,或安装路径不在默认位置)。',
      '下载 UU远程(官网)',
      '设置 CLI 路径',
      '查看日志',
    );
    if (choice === '下载 UU远程(官网)') {
      await vscode.env.openExternal(vscode.Uri.parse(UU_DOWNLOAD_URL));
      void vscode.window
        .showInformationMessage('安装完成后点击「重新检测」,若仍无法识别请手动设置 CLI 路径。', '重新检测')
        .then((btn) => {
          if (btn === '重新检测') {
            void vscode.commands.executeCommand('uu.refreshDevices');
          }
        });
    } else if (choice === '设置 CLI 路径') {
      await vscode.commands.executeCommand('uu.openCliSettings');
    } else if (choice === '查看日志') {
      await vscode.commands.executeCommand('uu.showOutput');
    }
  });
}
