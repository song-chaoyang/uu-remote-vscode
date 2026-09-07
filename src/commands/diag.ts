import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { execCliText, launchMainApp, resolveCliPath } from '../cli';
import { probeCliFeatures } from '../capabilities';
import { getExtensionConfig } from '../config';
import { log, showOutput } from '../log';
import { confirmModal, ok, registerCommand, showCliError, warn, withCli } from './common';

/** 旧版 CLI 无 input-diag 子命令时给出升级引导 */
async function ensureInputDiag(cliPath: string): Promise<boolean> {
  const feats = await probeCliFeatures(cliPath);
  if (feats.inputDiag) {
    return true;
  }
  warn('当前 uuyc-cli 版本不支持输入诊断。请升级本机 UU远程主程序到最新版本后重试。');
  return false;
}

export function registerDiagCommands(context: vscode.ExtensionContext): void {
  // 启动 UU远程主程序(未运行 / 未登录引导节点的点击动作;跨平台:Windows exe / macOS open -a)
  registerCommand(context, 'uu.launchMainApp', async () => {
    try {
      const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
      const launch = launchMainApp(cliPath);
      if (!launch) {
        warn('未找到 UU远程主程序,请从官网 https://uuyc.163.com/download 下载安装');
        return;
      }
      spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' }).unref();
      ok('已启动 UU远程主程序(若未登录,请在主程序中完成登录)');
      log(`已启动主程序:${launch.command} ${launch.args.join(' ')}`);
      setTimeout(() => {
        void vscode.commands.executeCommand('uu.refreshDevices');
        void vscode.commands.executeCommand('uu.cloudpc.refresh');
      }, 4000);
    } catch (e) {
      showCliError(e);
    }
  });

  registerCommand(context, 'uu.inputDiag.on', async () => {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureInputDiag(cliPath))) {
      return;
    }
    const result = await withCli((cli) => execCliText(cli, ['input-diag', 'on']));
    if (result !== undefined) {
      ok(`已开启输入诊断:${result || 'OK'}`);
    }
  });

  registerCommand(context, 'uu.inputDiag.off', async () => {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureInputDiag(cliPath))) {
      return;
    }
    const result = await withCli((cli) => execCliText(cli, ['input-diag', 'off']));
    if (result !== undefined) {
      ok(`已关闭输入诊断:${result || 'OK'}`);
    }
  });

  registerCommand(context, 'uu.inputDiag.dump', async () => {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureInputDiag(cliPath))) {
      return;
    }
    const result = await withCli((cli) => execCliText(cli, ['input-diag', 'dump']));
    if (result === undefined) {
      return;
    }
    log(`输入诊断 dump:\n${result}`);
    void vscode.window.showInformationMessage('输入诊断已导出到输出日志', '查看').then((btn) => {
      if (btn === '查看') {
        showOutput();
      }
    });
  });

  registerCommand(context, 'uu.inputDiag.hookReinstall', async () => {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureInputDiag(cliPath))) {
      return;
    }
    const confirmed = await confirmModal(
      '将重装 UU远程的本地低级键盘钩子(用于排查快捷键/组合键失灵问题),确定执行?',
      '重装钩子',
    );
    if (!confirmed) {
      return;
    }
    const result = await withCli((cli) => execCliText(cli, ['input-diag', 'hook-reinstall']));
    if (result !== undefined) {
      ok(`键盘钩子已重装:${result || 'OK'}`);
    }
  });

  registerCommand(context, 'uu.inputDiag.serverWinProbe', async () => {
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureInputDiag(cliPath))) {
      return;
    }
    const confirmed = await confirmModal(
      '将向被控端发送仅驱动层的 Win 键诊断探测(用于排查 Win 键异常问题),确定执行?',
      '发送探测',
    );
    if (!confirmed) {
      return;
    }
    const result = await withCli((cli) => execCliText(cli, ['input-diag', 'server-win-probe']));
    if (result !== undefined) {
      ok(`Win 键诊断探测已发送:${result || 'OK'}`);
    }
  });

  registerCommand(context, 'uu.showOutput', () => {
    showOutput();
  });
}
