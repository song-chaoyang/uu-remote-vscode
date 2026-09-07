/**
 * UU远程 AI 工具共享后端(纯 Node,无 vscode 依赖):
 * 同时供 MCP 服务器(独立进程,经 UU_CLI_PATH 注入 CLI 路径)与
 * Language Model Tools(扩展进程内)复用。
 */
import { existsSync } from 'fs';
import {
  execCliJson,
  echo,
  getDeviceStatus,
  getLocalDeviceId,
  listCloudPCs,
  listDevices,
  resolveCliPath,
} from './cli.js';
import { psQuote, TermBridge } from './termBridge.js';
import type { ShellKind } from './types.js';

const BRIDGE_IDLE_MS = 5 * 60 * 1000;
const READ_LIMIT = 256 * 1024;
const WRITE_LIMIT = 512 * 1024;
/** 交互式 PTY 会话空闲超时(AI 可能慢速交互,给更长窗口) */
const PTY_IDLE_MS = 30 * 60 * 1000;

interface PtySession {
  bridge: TermBridge;
  timer: NodeJS.Timeout;
}

export class UuToolsBackend {
  private readonly bridges = new Map<string, TermBridge>();
  private readonly ptySessions = new Map<string, PtySession>();
  private ptySeq = 0;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private cachedCliPath: string | undefined;

  /** CLI 路径:构造注入优先(MCP 进程),否则动态解析(扩展进程) */
  async cli(): Promise<string> {
    if (this.cachedCliPath) {
      return this.cachedCliPath;
    }
    const injected = process.env['UU_CLI_PATH'];
    if (injected && existsSync(injected)) {
      this.cachedCliPath = injected;
      return injected;
    }
    const resolved = await resolveCliPath('');
    this.cachedCliPath = resolved;
    return resolved;
  }

  /** bridge 按 设备+shell 缓存;空闲自动释放(避免远程会话残留) */
  private async bridge(deviceId: string, shell: ShellKind = 'powershell'): Promise<TermBridge> {
    const id = deviceId.toLowerCase();
    const key = `${id}::${shell}`;
    let bridge = this.bridges.get(key);
    if (!bridge) {
      bridge = new TermBridge(await this.cli(), id, shell);
      this.bridges.set(key, bridge);
    }
    const old = this.idleTimers.get(key);
    if (old) {
      clearTimeout(old);
    }
    this.idleTimers.set(
      key,
      setTimeout(() => {
        this.idleTimers.delete(key);
        const b = this.bridges.get(key);
        this.bridges.delete(key);
        void b?.dispose().catch(() => undefined);
      }, BRIDGE_IDLE_MS),
    );
    return bridge;
  }

  async listDevices(): Promise<string> {
    const cli = await this.cli();
    const [devices, connected] = await Promise.all([
      listDevices(cli),
      getDeviceStatus(cli).catch(() => []),
    ]);
    const connectedIds = new Set(connected.map((c) => c.targetId));
    const rows = devices.map((d) => ({
      device_id: d.deviceId,
      name: d.deviceName,
      online: d.isOnline,
      platform: String(d.platform),
      platform_hint:
        d.platform === 1 || d.platform === 4 || String(d.platform).toLowerCase() === 'windows' ? 'Windows' : '未知,先用探测命令确认',
      connected: connectedIds.has(d.deviceId),
    }));
    return JSON.stringify(
      { devices: rows, connected_devices: connected.map((c) => ({ target_id: c.targetId, name: c.targetName })) },
      null,
      2,
    );
  }

  /**
   * 在远程设备上执行命令并返回输出(输出按行分页拉取)。
   * shell:Windows 被控端用 powershell;macOS/Linux 被控端用 zsh 或 bash。
   */
  async remoteExec(deviceId: string, command: string, shell: ShellKind = 'powershell'): Promise<string> {
    const bridge = await this.bridge(deviceId, shell);
    const rows = await bridge.execRows(command, { timeoutMs: 60000 });
    return rows.length > 0 ? rows.join('\n') : '(命令执行完成,无输出)';
  }

  async remoteListDir(deviceId: string, path: string, shell: ShellKind = 'powershell'): Promise<string> {
    const bridge = await this.bridge(deviceId, shell);
    const cmd =
      shell === 'powershell'
        ? `Get-ChildItem -Force -LiteralPath ${psQuote(path)} | ForEach-Object { if ($_.PSIsContainer) { 'D|' + $_.Name } else { 'F|' + $_.Name + '|' + $_.Length } }`
        : `ls -la -- ${path.replace(/'/g, `'\\''`)} | awk 'NR>1 { t="F"; if ($1 ~ /^d/) t="D"; print t"|"$NF"|"$(NF-1) }'`;
    const rows = await bridge.execRows(cmd, { timeoutMs: 60000 });
    const entries = rows
      .filter((r) => /^[DF]\|/.test(r))
      .map((r) => {
        const [kind, ...rest] = r.split('|');
        const name = rest[0] ?? '';
        const size = kind === 'F' ? (rest[1] !== undefined ? ` (${rest[1]} bytes)` : '') : '/';
        return `${kind === 'D' ? 'DIR ' : 'FILE'} ${name}${size}`;
      });
    return entries.length > 0 ? entries.join('\n') : '(目录为空)';
  }

  /** 读取远程文本文件(UTF-8,≤256KB);基于 base64 传输避免编码歧义 */
  async remoteReadFile(deviceId: string, path: string, shell: ShellKind = 'powershell'): Promise<string> {
    const bridge = await this.bridge(deviceId, shell);
    const rows = await bridge.readFileB64(path, READ_LIMIT, { timeoutMs: 120000 });
    const first = rows[0] ?? '';
    if (first === 'ISDIR') {
      return `错误:「${path}」是目录而非文件`;
    }
    if (first.startsWith('TOOBIG')) {
      return `错误:文件过大(${Math.round((Number(first.slice(7)) || 0) / 1024)}KB > 256KB 上限),请改用 uu_remote_exec 配合命令处理`;
    }
    const b64 = rows.map((r) => r.trim()).join('');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      return `错误:远程读取「${path}」失败(输出被截断或格式异常)`;
    }
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  async remoteWriteFile(deviceId: string, path: string, content: string, shell: ShellKind = 'powershell'): Promise<string> {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > WRITE_LIMIT) {
      return `错误:内容过大(${Math.round(bytes.length / 1024)}KB > 512KB 上限)`;
    }
    const bridge = await this.bridge(deviceId, shell);
    await bridge.writeFile(path, bytes);
    return `已写入 ${path}(${bytes.length} 字节)`;
  }

  async connectDevice(deviceId: string): Promise<string> {
    const cli = await this.cli();
    const env = await execCliJson<unknown>(cli, ['device', 'connect', deviceId]);
    return `已发起连接(${deviceId}):${JSON.stringify(env)}`;
  }

  async disconnectDevice(deviceId?: string): Promise<string> {
    const cli = await this.cli();
    const args = deviceId ? ['device', 'disconnect', deviceId] : ['device', 'disconnect'];
    await execCliJson<unknown>(cli, args);
    return deviceId ? `已断开设备 ${deviceId}` : '已断开全部设备';
  }

  async cloudpcList(): Promise<string> {
    const cli = await this.cli();
    const cloudpcs = await listCloudPCs(cli);
    return JSON.stringify(
      cloudpcs.map((c) => ({ cloudpc_id: c.cloudPCId, name: c.name, status: c.status, pc_type: c.pcType })),
      null,
      2,
    );
  }

  async cloudpcPower(cloudpcId: string, action: 'on' | 'off'): Promise<string> {
    const cli = await this.cli();
    const args = action === 'on' ? ['cloudpc', 'launch', cloudpcId] : ['cloudpc', 'shutdown', cloudpcId];
    await execCliJson<unknown>(cli, args);
    return action === 'on' ? `云电脑 ${cloudpcId} 开机中` : `云电脑 ${cloudpcId} 关机中`;
  }

  async echoTest(message = 'hello'): Promise<string> {
    const cli = await this.cli();
    const echoed = await echo(cli, message);
    return `主应用通信正常,回显:${echoed}`;
  }

  async localDeviceId(): Promise<string> {
    const cli = await this.cli();
    return `本机设备 ID:${await getLocalDeviceId(cli)}`;
  }

  /** 远程启动程序(Start-Process):桌面端"快速启动程序"能力的 CLI 版 */
  async remoteLaunch(deviceId: string, program: string): Promise<string> {
    const bridge = await this.bridge(deviceId, 'powershell');
    const rows = await bridge.exec(`Start-Process ${psQuote(program)}; 'LAUNCHED'`, { timeoutMs: 30000 });
    const launched = rows.some((r) => r.includes('LAUNCHED'));
    return launched
      ? `已在设备 ${deviceId} 上启动:${program}`
      : `启动命令已发送,但远程无回显,请检查程序 ${program} 是否存在`;
  }

  // -------------------------------------------------------------------------
  // 交互式终端原语(uu_pty_open / uu_pty_send / uu_pty_read / uu_pty_close)
  // 用于处理交互提示(ssh 密码、y/n 确认、需要滚动输出的长任务等),
  // 与 uu-pty-bridge 生态的同名工具语义对齐。
  // -------------------------------------------------------------------------

  private touchPty(handle: string, session: PtySession): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => {
        this.ptySessions.delete(handle);
        void session.bridge.dispose().catch(() => undefined);
      },
      PTY_IDLE_MS,
    );
  }

  /** 打开远程终端,返回 handle;返回内容附当前屏幕快照
   * (当前实现总是新建会话;sessionName/newSession 参数为兼容 uu-pty-bridge 语义预留) */
  async ptyOpen(deviceId: string, opts: { shell?: ShellKind } = {}): Promise<string> {
    const cli = await this.cli();
    const shell = opts.shell ?? 'powershell';
    const bridge = new TermBridge(cli, deviceId.toLowerCase(), shell);
    await bridge.ensureReady();
    this.ptySeq++;
    const handle = `pty_${this.ptySeq}_${deviceId.slice(0, 6)}`;
    const session: PtySession = { bridge, timer: setTimeout(() => undefined, 0) };
    this.ptySessions.set(handle, session);
    this.touchPty(handle, session);
    const screen = bridge.snapshot().join('\n');
    return JSON.stringify({ handle, shell, note: '用 uu_pty_send 发送输入,\\r 表示回车;用 uu_pty_read 读取屏幕', screen });
  }

  /** 发送输入(keys 原样写入,\r 为回车),等待 wait_ms 后返回屏幕快照 */
  async ptySend(handle: string, keys: string, waitMs = 500): Promise<string> {
    const session = this.ptySessions.get(handle);
    if (!session) {
      return `错误:交互会话 ${handle} 不存在(可能已关闭或超时释放),请重新 uu_pty_open`;
    }
    this.touchPty(handle, session);
    session.bridge.writeRaw(keys);
    await new Promise((r) => setTimeout(r, Math.max(50, Math.min(waitMs, 30000))));
    return session.bridge.snapshot().join('\n') || '(屏幕为空)';
  }

  /** 读取当前屏幕快照 */
  async ptyRead(handle: string): Promise<string> {
    const session = this.ptySessions.get(handle);
    if (!session) {
      return `错误:交互会话 ${handle} 不存在(可能已关闭或超时释放),请重新 uu_pty_open`;
    }
    this.touchPty(handle, session);
    return session.bridge.snapshot().join('\n') || '(屏幕为空)';
  }

  /** 关闭交互会话(发送 exit 正常结束远程会话) */
  async ptyClose(handle: string): Promise<string> {
    const session = this.ptySessions.get(handle);
    if (!session) {
      return `错误:交互会话 ${handle} 不存在`;
    }
    clearTimeout(session.timer);
    this.ptySessions.delete(handle);
    await session.bridge.dispose().catch(() => undefined);
    return `交互会话 ${handle} 已关闭(远程会话已正常结束)`;
  }

  async disposeAll(): Promise<void> {
    for (const session of this.ptySessions.values()) {
      clearTimeout(session.timer);
      void session.bridge.dispose().catch(() => undefined);
    }
    this.ptySessions.clear();
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(bridges.map((b) => b.dispose().catch(() => undefined)));
  }
}
