import * as vscode from 'vscode';
import type { ShellKind } from './types';

export interface ExtensionConfig {
  cliPath: string;
  autoRefreshSeconds: number;
  defaultShell: ShellKind;
}

export function getExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('uu');
  return {
    cliPath: (cfg.get<string>('cliPath', '') ?? '').trim(),
    autoRefreshSeconds: Math.max(0, cfg.get<number>('autoRefreshSeconds', 10)),
    defaultShell: (cfg.get<ShellKind>('term.defaultShell', 'powershell')),
  };
}
