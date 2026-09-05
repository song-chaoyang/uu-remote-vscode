/**
 * 无线副屏功能:
 * 将闲置的 iOS / Android 手机或平板通过 UU远程 变身为电脑的高性能无线触控副屏。
 *
 * 无线副屏由 UU远程主应用管理,CLI 未提供直接命令。
 * 本模块提供:
 * - Webview 引导面板(操作说明 + 一键启动主程序)
 * - 快捷命令(启动主程序并提示进入无线副屏)
 * - 侧边栏入口(右键设备可启动无线副屏引导)
 */
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { launchMainApp, resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log } from '../log';
import { registerCommand, warn } from './common';
import type { DeviceTreeProvider } from '../providers/deviceTreeProvider';

const WIRELESS_SCREEN_URL = 'https://uuyc.163.com/features/wireless-screen/';

// ---------------------------------------------------------------------------
// Webview 无线副屏引导面板
// ---------------------------------------------------------------------------

function buildWirelessScreenHtml(panel: vscode.WebviewPanel): string {
  const nonce = 'uu-ws-nonce';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
  body {
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    padding: 24px 28px;
    max-width: 680px;
    margin: 0 auto;
    line-height: 1.7;
  }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
  .hero { text-align: center; padding: 20px 0 16px; }
  .hero-icon { font-size: 48px; display: block; margin-bottom: 8px; }
  .hero-sub { font-size: 14px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 12px; background: rgba(86,156,74,0.22); color: #6bb262; border: 1px solid rgba(86,156,74,0.55); margin-left: 8px; }
  .section { margin: 20px 0; }
  .section h2 { font-size: 16px; font-weight: 600; margin: 0 0 10px; color: var(--vscode-foreground); }
  .steps { list-style: none; padding: 0; margin: 0; }
  .steps li { padding: 8px 0 8px 32px; position: relative; border-bottom: 1px solid var(--vscode-panel-border); }
  .steps li:last-child { border-bottom: none; }
  .step-num {
    position: absolute; left: 0; top: 8px;
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 600;
  }
  .step-title { font-weight: 600; }
  .step-desc { font-size: 13px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .features { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 14px 0; }
  .feature-card {
    padding: 12px 14px; border-radius: 6px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
  }
  .feature-card .icon { font-size: 20px; margin-bottom: 4px; }
  .feature-card .label { font-size: 13px; font-weight: 600; }
  .feature-card .desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .tips { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 14px 0; padding: 10px 14px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); }
  .tips strong { color: var(--vscode-foreground); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
  .btn {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; padding: 8px 18px; font-size: 13px;
    cursor: pointer; font-family: inherit;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <div class="hero">
    <span class="hero-icon">🖥️ ↔ 📱</span>
    <h1>无线副屏 <span class="badge">免费</span></h1>
    <p class="hero-sub">将闲置手机 / 平板通过 UU远程 变身为电脑的高性能无线触控副屏</p>
  </div>

  <div class="section">
    <h2>✨ 功能特性</h2>
    <div class="features">
      <div class="feature-card">
        <div class="icon">⚡</div>
        <div class="label">零延迟</div>
        <div class="desc">0 延迟甚至负延迟,操作丝滑流畅</div>
      </div>
      <div class="feature-card">
        <div class="icon">🌐</div>
        <div class="label">不限网络</div>
        <div class="desc">局域网 / 公网均可使用,无需数据线</div>
      </div>
      <div class="feature-card">
        <div class="icon">👆</div>
        <div class="label">触控操作</div>
        <div class="desc">副屏支持触控,可直接操作电脑内容</div>
      </div>
      <div class="feature-card">
        <div class="icon">📱</div>
        <div class="label">全平台</div>
        <div class="desc">iOS / Android 手机和平板均可作为副屏</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>🚀 使用步骤</h2>
    <ol class="steps">
      <li>
        <span class="step-num">1</span>
        <div class="step-title">确保手机 / 平板已安装 UU远程</div>
        <div class="step-desc">iOS 在 App Store 搜索「UU远程」;Android 在应用商店搜索「UU远程」</div>
      </li>
      <li>
        <span class="step-num">2</span>
        <div class="step-title">手机 / 平板登录同一 UU远程账号</div>
        <div class="step-desc">与电脑端使用相同的网易账号登录</div>
      </li>
      <li>
        <span class="step-num">3</span>
        <div class="step-title">在电脑端打开 UU远程主程序</div>
        <div class="step-desc">点击下方按钮一键启动</div>
      </li>
      <li>
        <span class="step-num">4</span>
        <div class="step-title">在主程序中选择「无线副屏」</div>
        <div class="step-desc">点击主程序左侧「无线副屏」标签,选择要作为副屏的设备</div>
      </li>
      <li>
        <span class="step-num">5</span>
        <div class="step-title">手机 / 平板上确认连接</div>
        <div class="step-desc">副屏连接后,手机 / 平板即成为电脑的扩展显示器</div>
      </li>
    </ol>
  </div>

  <div class="tips">
    <strong>💡 提示:</strong>
    副屏连接后仅支持<strong>扩展模式</strong>(不支持镜像);目前仅能扩展<strong>一个</strong>副屏;
    声音仍从主屏传出;可通过浮层中的「布局方向」调整副屏位置(左/右/上/下)。
    副屏使用期间可以发起远控,但不可被控。
  </div>

  <div class="actions">
    <button class="btn" id="launchApp">🚀 启动 UU远程主程序</button>
    <button class="btn secondary" id="openWebsite">📖 查看官方介绍</button>
    <button class="btn secondary" id="openDownload">⬇️ 下载 UU远程(手机端)</button>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      document.getElementById('launchApp').addEventListener('click', function () {
        vscode.postMessage({ type: 'action', cmd: 'uu.launchMainApp' });
      });
      document.getElementById('openWebsite').addEventListener('click', function () {
        vscode.postMessage({ type: 'openUrl', url: '${WIRELESS_SCREEN_URL}' });
      });
      document.getElementById('openDownload').addEventListener('click', function () {
        vscode.postMessage({ type: 'openUrl', url: 'https://uuyc.163.com/download' });
      });
    })();
  </script>
</body>
</html>`;
}

export function openWirelessScreenPanel(context: vscode.ExtensionContext): void {
  const existing = context.workspaceState.get<vscode.WebviewPanel>(`uu.wsPanel`);
  if (existing) {
    existing.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'uu.wirelessScreen',
    'UU远程 · 无线副屏',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  void context.workspaceState.update('uu.wsPanel', panel);
  panel.webview.html = buildWirelessScreenHtml(panel);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'action' && msg.cmd) {
      await vscode.commands.executeCommand(msg.cmd);
    } else if (msg.type === 'openUrl' && msg.url) {
      await vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }
  });
  panel.onDidDispose(() => {
    void context.workspaceState.update('uu.wsPanel', undefined);
  });
  log('已打开无线副屏引导面板');
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

export function registerWirelessScreenCommands(context: vscode.ExtensionContext, _deviceProvider: DeviceTreeProvider): void {
  /** 打开无线副屏引导面板(Webview) */
  registerCommand(context, 'uu.wirelessScreen.open', async () => {
    openWirelessScreenPanel(context);
  });

  /** 快捷启动:启动主程序并提示进入无线副屏 */
  registerCommand(context, 'uu.wirelessScreen.launch', async () => {
    try {
      const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
      const launch = launchMainApp(cliPath);
      if (!launch) {
        warn('未找到 UU远程主程序,请从官网 https://uuyc.163.com/download 下载安装');
        return;
      }
      spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' }).unref();
      log('已启动 UU远程主程序(无线副屏入口)');
      void vscode.window
        .showInformationMessage(
          'UU远程主程序已启动。请在主程序左侧点击「无线副屏」标签,选择要作为副屏的设备。',
          '打开引导面板',
          '查看官方介绍',
        )
        .then(async (btn) => {
          if (btn === '打开引导面板') {
            openWirelessScreenPanel(context);
          } else if (btn === '查看官方介绍') {
            await vscode.env.openExternal(vscode.Uri.parse(WIRELESS_SCREEN_URL));
          }
        });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`无法启动主程序:${msg}`);
    }
  });

  /** 在浏览器中打开无线副屏官方介绍页面 */
  registerCommand(context, 'uu.wirelessScreen.website', async () => {
    await vscode.env.openExternal(vscode.Uri.parse(WIRELESS_SCREEN_URL));
    log(`已打开无线副屏官方介绍:${WIRELESS_SCREEN_URL}`);
  });

  /** 右键设备 → 启动无线副屏(引导用户在主程序中操作) */
  registerCommand(context, 'uu.wirelessScreen.forDevice', async (_selection: unknown) => {
    // 无线副屏不针对特定设备,仅做引导
    void vscode.window
      .showInformationMessage(
        '无线副屏功能需要在 UU远程主程序中操作:选择手机 / 平板设备作为副屏。要启动主程序吗?',
        '启动主程序',
        '查看引导',
      )
      .then(async (btn) => {
        if (btn === '启动主程序') {
          await vscode.commands.executeCommand('uu.wirelessScreen.launch');
        } else if (btn === '查看引导') {
          openWirelessScreenPanel(context);
        }
      });
  });
}
