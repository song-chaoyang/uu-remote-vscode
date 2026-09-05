import * as vscode from 'vscode';
import { cloudPcStatusName, getDeviceStatus, listCloudPCs, listDevices, resolveCliPath } from './cli';
import { getExtensionConfig } from './config';
import { log } from './log';
import type { CloudPC, ConnectedDevice, Device } from './types';

/** Webview 按钮点击消息 */
interface PanelMessage {
  type: 'action' | 'refresh';
  cmd?: string;
  payload?: unknown;
}

const devicePanels = new Map<string, vscode.WebviewPanel>();
const cloudPcPanels = new Map<string, vscode.WebviewPanel>();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 操作按钮声明:cmd 为既有命令 ID;__copy / __refresh 为面板内置动作 */
interface PanelAction {
  cmd: string;
  label: string;
  kind?: 'secondary';
}

interface HtmlSpec {
  title: string;
  icon: string;
  statusBadge: string;
  statusClass: 'ok' | 'muted';
  rows: Array<[string, string]>;
  actions: PanelAction[];
  /** 点击操作按钮时随命令一并传回的完整目标对象 */
  payload: Record<string, unknown>;
  copyText: string;
}

function buildHtml(panel: vscode.WebviewPanel, spec: HtmlSpec): string {
  const { title, icon, statusBadge, statusClass, rows, actions, payload, copyText } = spec;
  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td class="key">${escapeHtml(k)}</td><td class="val">${escapeHtml(v)}<a class="copy" title="复制">${escapeHtml(v)}</a></td></tr>`,
    )
    .join('');
  const buttonsHtml = actions
    .map((a) => `<button class="btn ${a.kind ?? ''}" data-cmd="${escapeHtml(a.cmd)}">${escapeHtml(a.label)}</button>`)
    .join('');
  const nonce = 'uu-panel-nonce';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
  body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 20px 24px; max-width: 640px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  h1 { font-size: 22px; margin: 0; font-weight: 600; }
  .badge { display: inline-block; margin-left: 8px; padding: 2px 10px; border-radius: 10px; font-size: 12px; }
  .badge.ok { background: rgba(86, 156, 74, 0.22); color: #6bb262; border: 1px solid rgba(86, 156, 74, 0.55); }
  .badge.muted { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  table { border-collapse: collapse; margin: 18px 0 22px; width: 100%; }
  td { padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  td.key { width: 120px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  td.val { word-break: break-all; }
  a.copy { display: none; margin-left: 8px; cursor: pointer; color: var(--vscode-textLink-foreground); text-decoration: none; }
  td.val:hover a.copy { display: inline; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 7px 16px; font-size: 13px; cursor: pointer; font-family: inherit; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tip { margin-top: 16px; font-size: 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="header"><span style="font-size:24px">${icon}</span><h1>${escapeHtml(title)}</h1><span class="badge ${statusClass}">${escapeHtml(statusBadge)}</span></div>
  <table>${rowsHtml}</table>
  <div class="actions">${buttonsHtml}<button class="btn secondary" data-cmd="__refresh">刷新状态</button></div>
  <div class="tip">面板按钮与树视图右键菜单等效;状态由 UU远程主应用提供。</div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const payload = ${JSON.stringify(payload)};
      document.querySelectorAll('button[data-cmd]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const cmd = btn.getAttribute('data-cmd');
          if (cmd === '__refresh') { vscode.postMessage({ type: 'refresh' }); return; }
          vscode.postMessage({ type: 'action', cmd: cmd, payload: payload });
        });
      });
      document.querySelectorAll('a.copy').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          vscode.postMessage({ type: 'action', cmd: '__copy', payload: ${JSON.stringify(copyText)} });
        });
      });
    })();
  </script>
</body>
</html>`;
}

async function handlePanelMessage(msg: PanelMessage, refresh: () => void): Promise<void> {
  if (msg.type === 'refresh') {
    refresh();
    return;
  }
  if (msg.type !== 'action' || !msg.cmd) {
    return;
  }
  if (msg.cmd === '__copy') {
    const text = typeof msg.payload === 'string' ? msg.payload : String(msg.payload ?? '');
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('UU远程:已复制到剪贴板', 2000);
    return;
  }
  // 将面板操作转发给既有命令(payload 为完整对象,命令侧 resolveFromSelection 直接解析)
  await vscode.commands.executeCommand(msg.cmd, msg.payload);
  // 连接/开机等操作生效有延迟,稍后自动刷新面板状态
  setTimeout(refresh, 2500);
  log(`详情面板触发命令:${msg.cmd}`);
}

// ---------------------------------------------------------------------------
// 设备详情
// ---------------------------------------------------------------------------

export function openDeviceDetails(_context: vscode.ExtensionContext, device: Device): void {
  const key = device.deviceId;
  const existing = devicePanels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'uu.deviceDetails',
    `UU远程 · ${device.deviceName}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  devicePanels.set(key, panel);
  const refresh = () => void refreshDevicePanel(panel, key).catch(() => undefined);
  panel.webview.onDidReceiveMessage((msg: PanelMessage) => void handlePanelMessage(msg, refresh));
  panel.onDidDispose(() => devicePanels.delete(key));
  panel.webview.html = buildDeviceHtml(panel, device, false);
  refresh();
}

async function refreshDevicePanel(panel: vscode.WebviewPanel, deviceId: string): Promise<void> {
  const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
  const [devices, connected] = await Promise.all([
    listDevices(cliPath),
    getDeviceStatus(cliPath).catch((): ConnectedDevice[] => []),
  ]);
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device) {
    return;
  }
  const isConnected = connected.some((c) => c.targetId === deviceId);
  panel.webview.html = buildDeviceHtml(panel, device, isConnected);
}

function buildDeviceHtml(panel: vscode.WebviewPanel, device: Device, connected: boolean): string {
  const actions: PanelAction[] = [];
  if (device.isOnline) {
    actions.push({ cmd: 'uu.attachToEditor', label: '附加到编辑器' });
    actions.push({ cmd: 'uu.connectDevice', label: connected ? '重新串流连接' : '启动串流连接' });
    actions.push({ cmd: 'uu.term.open', label: '打开远程终端' });
    actions.push({ cmd: 'uu.launchProgram', label: '启动程序', kind: 'secondary' });
    actions.push({ cmd: 'uu.uploadToRemote', label: '上传文件', kind: 'secondary' });
    actions.push({ cmd: 'uu.downloadFromRemote', label: '下载文件', kind: 'secondary' });
    actions.push({ cmd: 'uu.term.newSession', label: '新建远程会话', kind: 'secondary' });
  }
  if (connected) {
    actions.push({ cmd: 'uu.disconnectDevice', label: '断开连接', kind: 'secondary' });
  }
  return buildHtml(panel, {
    title: device.deviceName,
    icon: '🖥️',
    statusBadge: connected ? '已连接' : device.isOnline ? '在线' : '离线',
    statusClass: connected || device.isOnline ? 'ok' : 'muted',
    rows: [
      ['设备 ID', device.deviceId],
      ['平台', device.platform !== undefined ? `platform ${device.platform}` : '—'],
      ['在线状态', device.isOnline ? '在线' : '离线'],
      ['连接状态', connected ? '已连接' : '未连接'],
    ],
    actions,
    payload: device as unknown as Record<string, unknown>,
    copyText: device.deviceId,
  });
}

// ---------------------------------------------------------------------------
// 云电脑详情
// ---------------------------------------------------------------------------

export function openCloudPcDetails(_context: vscode.ExtensionContext, pc: CloudPC): void {
  const key = pc.cloudPCId;
  const existing = cloudPcPanels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'uu.cloudPcDetails',
    `UU远程 · ${pc.name}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  cloudPcPanels.set(key, panel);
  const refresh = () => void refreshCloudPcPanel(panel, key).catch(() => undefined);
  panel.webview.onDidReceiveMessage((msg: PanelMessage) => void handlePanelMessage(msg, refresh));
  panel.onDidDispose(() => cloudPcPanels.delete(key));
  panel.webview.html = buildCloudPcHtml(panel, pc);
  refresh();
}

async function refreshCloudPcPanel(panel: vscode.WebviewPanel, cloudPcId: string): Promise<void> {
  const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
  const cloudpcs = await listCloudPCs(cliPath);
  const pc = cloudpcs.find((c) => c.cloudPCId === cloudPcId);
  if (!pc) {
    return;
  }
  panel.webview.html = buildCloudPcHtml(panel, pc);
}

function buildCloudPcHtml(panel: vscode.WebviewPanel, pc: CloudPC): string {
  const running = pc.status === 'running';
  const actions: PanelAction[] = [];
  if (running) {
    actions.push({ cmd: 'uu.cloudpc.connect', label: '连接云电脑' });
    actions.push({ cmd: 'uu.cloudpc.shutdown', label: '关机', kind: 'secondary' });
  } else {
    actions.push({ cmd: 'uu.cloudpc.launch', label: '开机' });
  }
  actions.push({ cmd: 'uu.cloudpc.disconnect', label: '断开连接', kind: 'secondary' });
  return buildHtml(panel, {
    title: pc.name,
    icon: '☁️',
    statusBadge: cloudPcStatusName(pc.status),
    statusClass: running ? 'ok' : 'muted',
    rows: [
      ['云电脑 ID', pc.cloudPCId],
      ['状态', `${cloudPcStatusName(pc.status)}(${pc.status})`],
      ['类型', `pcType ${pc.pcType}`],
    ],
    actions,
    payload: pc as unknown as Record<string, unknown>,
    copyText: pc.cloudPCId,
  });
}
