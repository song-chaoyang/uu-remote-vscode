/**
 * UU远程 MCP 服务器(stdio):
 * 由 VSCode 扩展的 McpServerDefinitionProvider 以独立进程启动
 * (env 注入 UU_CLI_PATH),供 Copilot agent 模式等 MCP 客户端调用。
 * 工具核心逻辑复用 src/tools.ts(与 Language Model Tools 共享)。
 */
import { existsSync } from 'fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';

type UuToolsBackend = import('../tools.mjs').UuToolsBackend;
/**
 * 说明:esbuild 将本入口打包为 CJS 单文件,此 require 由 bundle 内部解析。
 * 之所以不用静态 import:ESM 入口静态引入 CJS 工具链会触发 tsc 的跨模块
 * 泛型级联问题(误报 McpServer 构造签名),require + 类型表达式可完全绕开。
 */
const { UuToolsBackend: Backend } = require('../tools.mts') as {
  UuToolsBackend: new (cliPath: string) => UuToolsBackend;
};

async function main(): Promise<void> {
  const cliPath = process.env['UU_CLI_PATH'] ?? '';
  if (!cliPath || !existsSync(cliPath)) {
    console.error('UU MCP 服务器:未配置有效的 UU_CLI_PATH(扩展应在启动时注入)');
    process.exit(1);
  }

  const backend = new Backend(cliPath);
  const server = new McpServer({ name: 'uu-remote', version: '0.6.0' });

  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

  server.registerTool(
    'uu_list_devices',
    {
      title: '列出 UU远程设备',
      description: '列出 UU远程(GameViewer)账号下所有可连接的远程设备,含名称、设备 ID、在线状态与当前串流连接状态。用于回答"我有哪些设备/哪台在线"。',
      inputSchema: {},
    },
    async () => text(await backend.listDevices()),
  );

  server.registerTool(
    'uu_remote_exec',
    {
      title: '远程执行命令',
      description: '在指定的 UU远程设备上执行一条 shell 命令并返回输出(远程终端通道,输出分页拉取)。Windows 被控端使用 PowerShell 语法(shell=powershell);macOS/Linux 被控端使用 zsh/bash 语法。通道吞吐约 5KB/s,输出较大时请分批查询。',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        device_id: z.string().describe('目标设备 ID(来自 uu_list_devices 的 device_id)'),
        command: z.string().describe('要执行的命令;Windows 用 PowerShell 语法(如 Get-ComputerInfo),macOS/Linux 用 zsh 语法(如 uname -a)'),
        shell: z.enum(['powershell', 'zsh', 'bash']).optional().describe('被控端 Shell;Windows 默认 powershell,macOS/Linux 请选 zsh 或 bash'),
      },
    },
    async ({ device_id, command, shell }) => text(await backend.remoteExec(device_id, command, shell ?? 'powershell')),
  );

  server.registerTool(
    'uu_remote_list_dir',
    {
      title: '列出远程目录',
      description: '列出远程设备上指定目录的文件与子目录(含大小)。路径为绝对路径。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        device_id: z.string().describe('目标设备 ID'),
        path: z.string().describe('远程目录绝对路径,如 C:\\Users 或 /Users/xxx'),
        shell: z.enum(['powershell', 'zsh', 'bash']).optional().describe('被控端 Shell;Windows 默认 powershell'),
      },
    },
    async ({ device_id, path, shell }) => text(await backend.remoteListDir(device_id, path, shell ?? 'powershell')),
  );

  server.registerTool(
    'uu_remote_read_file',
    {
      title: '读取远程文件',
      description: '读取远程设备上的文本文件内容(UTF-8,≤256KB,经 base64 传输避免编码歧义)。更大的文件请改用 uu_remote_exec 搭配命令处理。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        device_id: z.string().describe('目标设备 ID'),
        path: z.string().describe('远程文件绝对路径'),
        shell: z.enum(['powershell', 'zsh', 'bash']).optional().describe('被控端 Shell;Windows 默认 powershell'),
      },
    },
    async ({ device_id, path, shell }) => text(await backend.remoteReadFile(device_id, path, shell ?? 'powershell')),
  );

  server.registerTool(
    'uu_remote_write_file',
    {
      title: '写入远程文件',
      description: '将文本内容写入远程设备的指定文件(UTF-8,≤512KB,文件不存在时自动创建,已存在时覆盖)。这是一项破坏性操作。',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        device_id: z.string().describe('目标设备 ID'),
        path: z.string().describe('远程文件绝对路径'),
        content: z.string().describe('要写入的文本内容'),
        shell: z.enum(['powershell', 'zsh', 'bash']).optional().describe('被控端 Shell;Windows 默认 powershell'),
      },
    },
    async ({ device_id, path, content, shell }) =>
      text(await backend.remoteWriteFile(device_id, path, content, shell ?? 'powershell')),
  );

  server.registerTool(
    'uu_connect_device',
    {
      title: '串流连接设备',
      description: '发起对远程设备的串流连接(远程控制),连接窗口由 UU远程主应用打开。这是一项有副作用的操作。',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        device_id: z.string().describe('目标设备 ID'),
      },
    },
    async ({ device_id }) => text(await backend.connectDevice(device_id)),
  );

  server.registerTool(
    'uu_disconnect_device',
    {
      title: '断开设备连接',
      description: '断开远程设备的串流连接;不传 device_id 则断开全部设备。',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        device_id: z.string().optional().describe('目标设备 ID;省略则断开全部'),
      },
    },
    async ({ device_id }) => text(await backend.disconnectDevice(device_id)),
  );

  server.registerTool(
    'uu_cloudpc_list',
    {
      title: '列出云电脑',
      description: '列出 UU远程账号下的云电脑,含 ID、名称、运行状态(如 running/shutdown)。',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => text(await backend.cloudpcList()),
  );

  server.registerTool(
    'uu_cloudpc_power',
    {
      title: '云电脑开机/关机',
      description: '对指定云电脑执行开机(on)或关机(off)。关机是破坏性操作。',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        cloudpc_id: z.string().describe('云电脑 ID(来自 uu_cloudpc_list)'),
        action: z.enum(['on', 'off']).describe('on=开机,off=关机'),
      },
    },
    async ({ cloudpc_id, action }) => text(await backend.cloudpcPower(cloudpc_id, action)),
  );

  server.registerTool(
    'uu_echo_test',
    {
      title: '测试主应用通信',
      description: '向 UU远程主应用发送回显消息,验证 CLI 与主应用通信是否正常。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        message: z.string().optional().describe('要回显的消息(默认 hello)'),
      },
    },
    async ({ message }) => text(await backend.echoTest(message ?? 'hello')),
  );

  server.registerTool(
    'uu_local_device_id',
    {
      title: '获取本机设备 ID',
      description: '获取当前这台电脑在 UU远程中的设备 ID(可用于把本机作为被控端时的信息查询)。',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => text(await backend.localDeviceId()),
  );

  // -----------------------------------------------------------------------
  // 交互式终端原语(与 uu-pty-bridge 生态同名工具语义对齐):
  // 处理需要交互的场景:ssh 密码、y/n 确认、滚动输出的长任务等
  // -----------------------------------------------------------------------

  server.registerTool(
    'uu_remote_launch',
    {
      title: '远程启动程序',
      description: '在远程设备上启动一个程序(桌面端"快速启动程序"能力的命令行版,基于 Start-Process)。适合让远程机器打开记事本、任务管理器、浏览器或任意应用。仅在 Windows 被控端有效。',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        device_id: z.string().describe('目标设备 ID'),
        program: z.string().describe('程序路径或名称,如 notepad.exe、taskmgr.exe 或 C:\\Program Files\\App\\app.exe'),
      },
    },
    async ({ device_id, program }) => text(await backend.remoteLaunch(device_id, program)),
  );

  server.registerTool(
    'uu_pty_open',
    {
      title: '打开交互式远程终端',
      description: '在目标设备上打开一个持久交互式远程终端,返回 handle 与当前屏幕快照。适合处理交互提示(如 ssh 密码、确认对话)与长任务;普通单次命令请优先用 uu_remote_exec。用 uu_pty_send 发送输入(\\r 表示回车),uu_pty_read 读屏,uu_pty_close 关闭。空闲 30 分钟自动释放。',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        device_id: z.string().describe('目标设备 ID'),
        shell: z.enum(['powershell', 'cmd', 'zsh', 'bash']).optional().describe('远程 Shell;Windows 默认 powershell'),
      },
    },
    async ({ device_id, shell }) => text(await backend.ptyOpen(device_id, { shell })),
  );

  server.registerTool(
    'uu_pty_send',
    {
      title: '向交互终端发送输入',
      description: '向 uu_pty_open 打开的交互式终端发送按键/文本(原样写入,\\r 表示回车),等待 wait_ms 毫秒后返回屏幕快照。适用于回答密码提示、确认对话、继续分页输出等。',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        handle: z.string().describe('uu_pty_open 返回的会话 handle'),
        keys: z.string().describe('要发送的输入;\\r 表示回车,如 "yes\\r"'),
        wait_ms: z.number().optional().describe('发送后等待的毫秒数(默认 500,最大 30000)'),
      },
    },
    async ({ handle, keys, wait_ms }) => text(await backend.ptySend(handle, keys, wait_ms)),
  );

  server.registerTool(
    'uu_pty_read',
    {
      title: '读取交互终端屏幕',
      description: '读取交互式终端当前屏幕快照(服务端虚拟屏幕约 39 行,更早内容会滚出)。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        handle: z.string().describe('uu_pty_open 返回的会话 handle'),
      },
    },
    async ({ handle }) => text(await backend.ptyRead(handle)),
  );

  server.registerTool(
    'uu_pty_close',
    {
      title: '关闭交互终端',
      description: '关闭交互式终端会话(向远程发送 exit 正常结束,不残留远程会话)。',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        handle: z.string().describe('uu_pty_open 返回的会话 handle'),
      },
    },
    async ({ handle }) => text(await backend.ptyClose(handle)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error('UU MCP 服务器启动失败:', e);
  process.exit(1);
});
