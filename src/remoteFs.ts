/**
 * uu-remote:// 虚拟文件系统:把 TermBridge(远程 PowerShell)包装成 VSCode FileSystemProvider,
 * 实现「附加到编辑器」——像 Remote-SSH 一样在 VSCode 中浏览/编辑远程文件。
 *
 * URI 约定:uu-remote://<deviceId>/<逐段编码的 Windows 路径>
 * 例:C:\Users\Admin → uu-remote://aeawt52ogmaygav7/C%3A/Users/Admin
 *
 * 性能特征(term 通道吞吐 ~5KB/s):文件 ≤256KB 可读、≤512KB 可写;
 * 更大文件直接拒绝,避免长时间阻塞。
 */
import * as vscode from 'vscode';
import { resolveCliPath } from './cli';
import { getExtensionConfig } from './config';
import { log } from './log';
import { psQuote, TermBridge } from './termBridge';

export const UU_FS_SCHEME = 'uu-remote';

const READ_LIMIT = 256 * 1024;
const BRIDGE_IDLE_MS = 5 * 60 * 1000;

function winPathFromUri(uri: vscode.Uri): string {
  const segs = uri.path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  return segs.join('\\');
}

export function uriForWinPath(deviceId: string, winPath: string): vscode.Uri {
  const segs = winPath.split('\\').filter(Boolean);
  const path = '/' + segs.map((s) => encodeURIComponent(s)).join('/');
  return vscode.Uri.parse(`${UU_FS_SCHEME}://${deviceId.toLowerCase()}${path}`);
}

export class UuRemoteFsProvider implements vscode.FileSystemProvider {
  private readonly bridges = new Map<string, TermBridge>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private async bridge(deviceId: string): Promise<TermBridge> {
    const id = deviceId.toLowerCase();
    let bridge = this.bridges.get(id);
    if (!bridge) {
      const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
      bridge = new TermBridge(cliPath, id, 'powershell', (line) => log(`[${id}] ${line}`));
      this.bridges.set(id, bridge);
    }
    this.touchIdle(id);
    return bridge;
  }

  /** 空闲 5 分钟自动结束远程会话(避免会话残留) */
  private touchIdle(id: string): void {
    const old = this.idleTimers.get(id);
    if (old) {
      clearTimeout(old);
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(id);
      const bridge = this.bridges.get(id);
      this.bridges.delete(id);
      if (bridge) {
        log(`[${id}] 远程文件通道空闲超时,已断开`);
        void bridge.dispose().catch(() => undefined);
      }
    }, BRIDGE_IDLE_MS);
    this.idleTimers.set(id, timer);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bridge = await this.withDevice(uri);
    const p = winPathFromUri(uri);
    const rows = await bridge.exec(
      `if (Test-Path -LiteralPath ${psQuote(p)}) { $i = Get-Item -Force -LiteralPath ${psQuote(p)}; if ($i.PSIsContainer) { 'D' } else { 'F|' + $i.Length } } else { 'N' }`,
    );
    const first = rows[0] ?? '';
    if (first === 'N' || first === '') {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (first.startsWith('D')) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const size = Number(first.slice(2)) || 0;
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const bridge = await this.withDevice(uri);
    const p = winPathFromUri(uri);
    const rows = await bridge.execRows(
      `Get-ChildItem -Force -LiteralPath ${psQuote(p)} | ForEach-Object { if ($_.PSIsContainer) { 'D|' + $_.Name } else { 'F|' + $_.Name } }`,
    );
    const entries: [string, vscode.FileType][] = [];
    for (const row of rows) {
      if (row.startsWith('D|')) {
        entries.push([row.slice(2), vscode.FileType.Directory]);
      } else if (row.startsWith('F|')) {
        entries.push([row.slice(2), vscode.FileType.File]);
      }
    }
    return entries;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const bridge = await this.withDevice(uri);
    const p = winPathFromUri(uri);
    const rows = await bridge.readFileB64(p, READ_LIMIT, { timeoutMs: 120000 });
    const first = rows[0] ?? '';
    if (first === 'ISDIR') {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (first.startsWith('TOOBIG')) {
      const kb = Math.round((Number(first.slice(7)) || 0) / 1024);
      throw vscode.FileSystemError.Unavailable(
        `文件过大(${kb}KB,上限 256KB):UU远程终端通道吞吐有限,读取大文件非常缓慢,建议改用远程终端操作`,
      );
    }
    if (rows.length === 0) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // base64 字符集不含空白,行首因折行定位产生的空格可以安全剔除
    const b64 = rows.map((r) => r.trim()).join('');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw vscode.FileSystemError.Unavailable(`远程读取「${p}」失败:输出被截断或格式异常`);
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const bridge = await this.withDevice(uri);
    const p = winPathFromUri(uri);
    const statRows = await bridge.exec(
      `if (Test-Path -LiteralPath ${psQuote(p)}) { $i = Get-Item -Force -LiteralPath ${psQuote(p)}; if ($i.PSIsContainer) { 'ISDIR' } else { 'EXISTS' } } else { 'N' }`,
    );
    const state = statRows[0] ?? 'N';
    if (state === 'ISDIR') {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (state === 'EXISTS' && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (state === 'N' && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const parent = p.split('\\').slice(0, -1).join('\\');
    if (parent) {
      await bridge.exec(`New-Item -ItemType Directory -Force -Path ${psQuote(parent)} | Out-Null`);
    }
    await bridge.writeFile(p, content);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const bridge = await this.withDevice(uri);
    const p = winPathFromUri(uri);
    await bridge.exec(
      `if (Test-Path -LiteralPath ${psQuote(p)}) { $i = Get-Item -Force -LiteralPath ${psQuote(p)}; if ($i.PSIsContainer) { 'OK' } else { 'EXISTS' } } else { New-Item -ItemType Directory -Path ${psQuote(p)} | Out-Null; 'OK' }`,
    );
  }

  async delete(uri: vscode.Uri, _options: { recursive: boolean }): Promise<void> {
    const bridge = await this.withDevice(uri);
    const p = winPathFromUri(uri);
    const rows = await bridge.exec(
      `if (Test-Path -LiteralPath ${psQuote(p)}) { Remove-Item -LiteralPath ${psQuote(p)} -Recurse -Force; 'OK' } else { 'N' }`,
      { timeoutMs: 60000 },
    );
    if ((rows[0] ?? '') === 'N') {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const bridge = await this.withDevice(oldUri);
    const from = winPathFromUri(oldUri);
    const to = winPathFromUri(newUri);
    const force = options.overwrite ? '-Force' : '';
    const rows = await bridge.exec(
      [
        `if (-not (Test-Path -LiteralPath ${psQuote(from)})) { 'N' }`,
        `elseif (Test-Path -LiteralPath ${psQuote(to)}) { ${options.overwrite ? `Move-Item -LiteralPath ${psQuote(from)} -Destination ${psQuote(to)} ${force}; 'OK'` : `'E'`} }`,
        `else { Move-Item -LiteralPath ${psQuote(from)} -Destination ${psQuote(to)}; 'OK' }`,
      ].join(' '),
    );
    const state = rows[0] ?? 'N';
    if (state === 'N') {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }
    if (state === 'E') {
      throw vscode.FileSystemError.FileExists(newUri);
    }
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    // 远程通道无推送能力,返回空监听(编辑器会话内的变更由保存流程自身保证一致)
    return new vscode.Disposable(() => undefined);
  }

  /** 结束所有设备的远程会话 */
  async disposeAll(): Promise<void> {
    for (const [id, timer] of this.idleTimers) {
      clearTimeout(timer);
      this.idleTimers.delete(id);
    }
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(bridges.map((b) => b.dispose().catch(() => undefined)));
  }

  private async withDevice(uri: vscode.Uri): Promise<TermBridge> {
    const deviceId = uri.authority;
    if (!deviceId) {
      throw vscode.FileSystemError.Unavailable('无效的远程路径(缺少设备 ID)');
    }
    try {
      return await this.bridge(deviceId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw vscode.FileSystemError.Unavailable(`UU远程通道不可用:${msg}`);
    }
  }
}
