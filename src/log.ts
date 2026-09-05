import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('UU远程');
  }
  return channel;
}

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export function log(message: string): void {
  getOutputChannel().appendLine(`[${ts()}] ${message}`);
}

export function showOutput(): void {
  getOutputChannel().show(true);
}
