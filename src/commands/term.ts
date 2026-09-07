import * as vscode from 'vscode';
import {
  CliError,
  LOCAL_SHELLS,
  REMOTE_SHELLS,
  execCli,
  execCliText,
  firstErrorLine,
  listLtermSessions,
  looksLikeError,
  parseTermSessions,
  resolveCliPath,
} from '../cli';
import { probeCliFeatures } from '../capabilities';
import { getExtensionConfig } from '../config';
import { log, showOutput } from '../log';
import type { Device, LtermSession, ShellKind, TermSessionInfo } from '../types';
import { DeviceTreeProvider } from '../providers/deviceTreeProvider';
import {
  confirmModal,
  ok,
  pickDevice,
  registerCommand,
  resolveFromSelection,
  runInteractive,
  showCliError,
  warn,
  withCli,
} from './common';

interface ShellPickItem extends vscode.QuickPickItem {
  value: ShellKind;
}

async function pickShell(shells: ShellKind[], placeHolder: string, defaultShell: string): Promise<ShellKind | undefined> {
  const items: ShellPickItem[] = shells.map((s) => ({
    label: s,
    description: s === defaultShell ? '默认' : '',
    value: s,
  }));
  const chosen = await vscode.window.showQuickPick(items, { placeHolder });
  return chosen?.value;
}

/**
 * 旧版 CLI 无 term --device-id 管道通道:打开远程终端前先探测,
 * 不支持时给出清晰引导(升级主程序 / 到主程序中使用内置终端)。
 */
async function ensureTermChannel(cliPath: string): Promise<boolean> {
  const feats = await probeCliFeatures(cliPath);
  if (feats.termChannel) {
    return true;
  }
  warn(
    '当前 uuyc-cli 版本不支持在 VSCode 中打开远程终端(需要新版 CLI 的 term --device-id 通道)。' +
      '请升级本机 UU远程主程序到最新版本,或在 UU远程主程序中使用自带远程终端;本地 UU 终端(lterm)不受影响。',
  );
  return false;
}

interface RemoteSessionPayload {
  sessions: TermSessionInfo[];
  raw: string;
}

/** 获取指定设备的远程终端会话列表(新版 CLI 有会话时才输出 JSON,无会话输出 "No active sessions.") */
async function fetchRemoteSessions(cliPath: string, device: Device): Promise<RemoteSessionPayload | undefined> {
  const feats = await probeCliFeatures(cliPath);
  if (!feats.termChannel) {
    warn(
      '当前 uuyc-cli 版本不支持远程终端会话管理(term --list-sessions)。请升级本机 UU远程主程序,或在主程序中使用远程终端。',
    );
    return undefined;
  }
  const r = await execCli(cliPath, ['term', '--device-id', device.deviceId, '--list-sessions']);
  if (looksLikeError(r)) {
    throw new CliError(firstErrorLine(r));
  }
  return { sessions: parseTermSessions(r.stdout), raw: r.stdout };
}

async function pickRemoteSession(
  cliPath: string,
  device: Device,
  placeHolder: string,
): Promise<TermSessionInfo | undefined> {
  const payload = await fetchRemoteSessions(cliPath, device);
  if (!payload) {
    return undefined;
  }
  if (payload.sessions.length === 0) {
    if (/no active sessions/i.test(payload.raw)) {
      ok(`设备「${device.deviceName}」上无活动的远程终端会话`);
    } else {
      log(`远程终端会话输出(未识别格式):\n${payload.raw}`);
      void vscode.window
        .showInformationMessage('远程终端会话输出格式未识别,已写入日志', '查看日志')
        .then((btn) => btn === '查看日志' && showOutput());
    }
    return undefined;
  }
  const chosen = await vscode.window.showQuickPick(
    payload.sessions.map((s) => ({
      label: `$(terminal) ${s.label}`,
      description: s.id,
      detail: [s.shell, s.state, s.lastActiveMs ? new Date(s.lastActiveMs).toLocaleString('zh-CN') : '']
        .filter(Boolean)
        .join(' · '),
      session: s,
    })),
    { placeHolder },
  );
  return chosen?.session;
}

/** 以 CLI 本体为终端进程启动远程终端 */
function runRemoteTerm(device: Device, shell: ShellKind, extra: string[]): void {
  const args = ['term', '--device-id', device.deviceId, '--shell', shell, ...extra];
  void runInteractive(`UU远程终端:${device.deviceName}`, args);
}

export function registerTermCommands(context: vscode.ExtensionContext, deviceProvider: DeviceTreeProvider): void {
  registerCommand(context, 'uu.term.open', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择要打开远程终端的设备');
    if (!dev) {
      return;
    }
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureTermChannel(cliPath))) {
      return;
    }
    const shell = await pickShell(REMOTE_SHELLS, '选择远程 Shell', getExtensionConfig().defaultShell);
    if (!shell) {
      return;
    }
    runRemoteTerm(dev, shell, []);
  });

  registerCommand(context, 'uu.term.newSession', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择设备(将新建远程终端会话)');
    if (!dev) {
      return;
    }
    const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
    if (!(await ensureTermChannel(cliPath))) {
      return;
    }
    const shell = await pickShell(REMOTE_SHELLS, '选择远程 Shell', getExtensionConfig().defaultShell);
    if (!shell) {
      return;
    }
    runRemoteTerm(dev, shell, ['--new-session']);
  });

  registerCommand(context, 'uu.term.listSessions', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择设备(查看其远程终端会话)');
    if (!dev) {
      return;
    }
    const session = await withCli((cliPath) => pickRemoteSession(cliPath, dev, '选择会话'));
    if (!session) {
      return;
    }
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(terminal) 附加到该会话', value: 'attach' as const },
        { label: '$(trash) 终止该会话', value: 'kill' as const },
      ],
      { placeHolder: `会话 ${session.id}:选择操作` },
    );
    if (!action) {
      return;
    }
    if (action.value === 'attach') {
      runRemoteTerm(dev, getExtensionConfig().defaultShell, ['--session-id', session.id]);
    } else {
      const confirmed = await confirmModal(`将终止设备「${dev.deviceName}」上的终端会话 ${session.id},确定?`, '终止');
      if (!confirmed) {
        return;
      }
      const result = await withCli((cliPath) =>
        execCliText(cliPath, ['term', '--device-id', dev.deviceId, '--kill-session', session.id]),
      );
      if (result !== undefined) {
        ok(`已终止远程终端会话:${session.id}`);
      }
    }
  });

  registerCommand(context, 'uu.term.killSession', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择设备(终止其远程终端会话)');
    if (!dev) {
      return;
    }
    const session = await withCli((cliPath) => pickRemoteSession(cliPath, dev, '选择要终止的会话'));
    if (!session) {
      return;
    }
    const confirmed = await confirmModal(`将终止设备「${dev.deviceName}」上的终端会话 ${session.id},确定?`, '终止');
    if (!confirmed) {
      return;
    }
    const result = await withCli((cliPath) =>
      execCliText(cliPath, ['term', '--device-id', dev.deviceId, '--kill-session', session.id]),
    );
    if (result !== undefined) {
      ok(`已终止远程终端会话:${session.id}`);
    }
  });

  registerCommand(context, 'uu.term.attachSession', async (selection: unknown) => {
    const dev = await resolveFromSelection(selection, deviceProvider.currentDevices, pickDevice, '选择设备(附加其远程终端会话)');
    if (!dev) {
      return;
    }
    const session = await withCli((cliPath) => pickRemoteSession(cliPath, dev, '选择要附加的会话'));
    if (!session) {
      return;
    }
    runRemoteTerm(dev, getExtensionConfig().defaultShell, ['--session-id', session.id]);
  });

  // ---------------------------------------------------------------------------
  // 本地 UU 终端会话
  // ---------------------------------------------------------------------------

  const pickLocalSession = async (placeHolder: string): Promise<LtermSession | undefined> => {
    const sessions = await withCli((cliPath) => listLtermSessions(cliPath));
    if (!sessions) {
      return undefined;
    }
    if (sessions.length === 0) {
      warn('当前无本地 UU 终端会话');
      return undefined;
    }
    const chosen = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: `$(terminal) ${s.name}`,
        description: s.shell,
        detail: [s.state, s.createdAtMs ? new Date(s.createdAtMs).toLocaleString('zh-CN') : ''].filter(Boolean).join(' · '),
        session: s,
      })),
      { placeHolder },
    );
    return chosen?.session;
  };

  registerCommand(context, 'uu.lterm.new', async () => {
    const name = await vscode.window.showInputBox({
      prompt: '输入新终端会话名称(可留空使用默认)',
      placeHolder: '例如:work',
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }
    const shell = await pickShell(LOCAL_SHELLS, '选择本地终端 Shell', getExtensionConfig().defaultShell);
    if (!shell) {
      return;
    }
    const args = ['lterm', 'new'];
    if (name.trim()) {
      args.push(name.trim());
    }
    args.push('--shell', shell);
    await runInteractive(`UU本地终端:${name.trim() || '默认'}`, args);
  });

  registerCommand(context, 'uu.lterm.attach', async () => {
    const session = await pickLocalSession('选择要附加的本地终端会话');
    if (!session) {
      return;
    }
    await runInteractive(`UU本地终端:${session.name}`, ['lterm', 'attach', session.name]);
  });

  registerCommand(context, 'uu.lterm.list', async () => {
    const sessions = await withCli((cliPath) => listLtermSessions(cliPath));
    if (!sessions) {
      return;
    }
    if (sessions.length === 0) {
      ok('当前无本地 UU 终端会话');
      return;
    }
    const lines = sessions.map(
      (s) => `${s.name} · ${s.shell} · ${s.state}${s.createdAtMs ? ` · ${new Date(s.createdAtMs).toLocaleString('zh-CN')}` : ''}`,
    );
    ok(`本地 UU 终端会话(${sessions.length} 个):\n${lines.join('\n')}`);
  });

  registerCommand(context, 'uu.lterm.kill', async () => {
    const session = await pickLocalSession('选择要终止的本地终端会话');
    if (!session) {
      return;
    }
    const confirmed = await confirmModal(`将终止本地终端会话「${session.name}」,确定?`, '终止');
    if (!confirmed) {
      return;
    }
    const result = await withCli((cliPath) => execCliText(cliPath, ['lterm', 'kill', session.name]));
    if (result !== undefined) {
      ok(`已终止本地终端会话:${session.name}`);
    }
  });

  registerCommand(context, 'uu.lterm.has', async () => {
    const name = await vscode.window.showInputBox({
      prompt: '输入要检查的本地终端会话名称',
      placeHolder: '例如:work',
      ignoreFocusOut: true,
    });
    if (name === undefined || !name.trim()) {
      return;
    }
    const result = await withCli((cliPath) => execCliText(cliPath, ['lterm', 'has', name.trim()]));
    if (result !== undefined) {
      ok(`会话「${name.trim()}」检查结果:${result}`);
    }
  });

  registerCommand(context, 'uu.lterm.rename', async () => {
    const session = await pickLocalSession('选择要重命名的本地终端会话');
    if (!session) {
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: `将「${session.name}」重命名为`,
      ignoreFocusOut: true,
    });
    if (newName === undefined || !newName.trim()) {
      return;
    }
    const result = await withCli((cliPath) => execCliText(cliPath, ['lterm', 'rename', session.name, newName.trim()]));
    if (result !== undefined) {
      ok(`已重命名:${session.name} → ${newName.trim()}`);
    }
  });
}

/** 终端 Profile(下拉列表中的「UU 本地终端」),路径无法解析时静默返回 undefined */
export class UuTerminalProfileProvider implements vscode.TerminalProfileProvider {
  async provideTerminalProfile(_token: vscode.CancellationToken): Promise<vscode.TerminalProfile | undefined> {
    try {
      const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
      return new vscode.TerminalProfile({ name: 'UU 本地终端', shellPath: cliPath, shellArgs: ['lterm', 'new'] });
    } catch (e) {
      showCliError(e);
      return undefined;
    }
  }
}
