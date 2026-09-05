/**
 * 向 VSCode 注册内嵌 MCP 服务器(stdio):
 * VSCode 需要时自动 spawn `node dist/mcp-server.cjs`(编辑器内置 Node),
 * CLI 路径经 env 注入。CLI 不可达时不提供服务器,避免注册残缺实例。
 */
import * as vscode from 'vscode';
import { resolveCliPath } from './cli';
import { getExtensionConfig } from './config';
import { log } from './log';

export const MCP_PROVIDER_ID = 'uu-remote.mcpServer';
export const MCP_SERVER_LABEL = 'UU远程助手';

export function registerMcpProvider(context: vscode.ExtensionContext): void {
  const provider = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    provideMcpServerDefinitions: async () => {
      try {
        const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
        const serverPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.cjs').fsPath;
        log(`MCP 服务器定义就绪:${serverPath}`);
        return [
          new vscode.McpStdioServerDefinition(
            MCP_SERVER_LABEL,
            process.execPath, // 使用 VSCode 内置 Node,无需用户另装运行时
            [serverPath],
            { UU_CLI_PATH: cliPath },
            String(context.extension.packageJSON.version ?? '0.4.0'),
          ),
        ];
      } catch (e) {
        log(`MCP 服务器未提供(CLI 不可用):${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    },
    resolveMcpServerDefinition: async (server) => server,
  });
  context.subscriptions.push(provider);
}
