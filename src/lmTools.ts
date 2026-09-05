/**
 * Copilot 原生 Language Model Tools(vscode.lm.registerTool):
 * 与 MCP 服务器共享同一套工具后端(src/tools.mts,ESM 模块)。
 * 扩展入口为 CJS,故类型用 import type、运行时用动态 import() 加载。
 */
import * as vscode from 'vscode';
import type { UuBackend } from './aiToolTypes';

let backendPromise: Promise<UuBackend> | undefined;

async function getBackend(): Promise<UuBackend> {
  // tools 实现为 ESM 模块(.mts),CJS 侧通过动态 import 加载(由 esbuild 内联打包)
  backendPromise ??= import('./tools.mjs').then((m) => new m.UuToolsBackend());
  return backendPromise;
}

interface ToolDef {
  name: string;
  run: (backend: UuBackend, input: Record<string, unknown>) => Promise<string>;
}

const TOOL_DEFS: ToolDef[] = [
  { name: 'uu_list_devices', run: (b) => b.listDevices() },
  {
    name: 'uu_remote_exec',
    run: (b, input) =>
      b.remoteExec(
        String(input['device_id'] ?? ''),
        String(input['command'] ?? ''),
        typeof input['shell'] === 'string' ? String(input['shell']) : undefined,
      ),
  },
  {
    name: 'uu_remote_list_dir',
    run: (b, input) =>
      b.remoteListDir(
        String(input['device_id'] ?? ''),
        String(input['path'] ?? ''),
        typeof input['shell'] === 'string' ? String(input['shell']) : undefined,
      ),
  },
  {
    name: 'uu_remote_read_file',
    run: (b, input) =>
      b.remoteReadFile(
        String(input['device_id'] ?? ''),
        String(input['path'] ?? ''),
        typeof input['shell'] === 'string' ? String(input['shell']) : undefined,
      ),
  },
  {
    name: 'uu_remote_write_file',
    run: (b, input) =>
      b.remoteWriteFile(
        String(input['device_id'] ?? ''),
        String(input['path'] ?? ''),
        String(input['content'] ?? ''),
        typeof input['shell'] === 'string' ? String(input['shell']) : undefined,
      ),
  },
  {
    name: 'uu_connect_device',
    run: (b, input) => b.connectDevice(String(input['device_id'] ?? '')),
  },
  {
    name: 'uu_disconnect_device',
    run: (b, input) => {
      const id = input['device_id'];
      return b.disconnectDevice(typeof id === 'string' && id ? id : undefined);
    },
  },
  { name: 'uu_cloudpc_list', run: (b) => b.cloudpcList() },
  {
    name: 'uu_cloudpc_power',
    run: (b, input) =>
      b.cloudpcPower(String(input['cloudpc_id'] ?? ''), input['action'] === 'off' ? 'off' : 'on'),
  },
  {
    name: 'uu_echo_test',
    run: (b, input) => b.echoTest(typeof input['message'] === 'string' && input['message'] ? String(input['message']) : 'hello'),
  },
  { name: 'uu_local_device_id', run: (b) => b.localDeviceId() },
  {
    name: 'uu_remote_launch',
    run: (b, input) => b.remoteLaunch(String(input['device_id'] ?? ''), String(input['program'] ?? '')),
  },
  {
    name: 'uu_pty_open',
    run: (b, input) =>
      b.ptyOpen(String(input['device_id'] ?? ''), { shell: typeof input['shell'] === 'string' ? String(input['shell']) : undefined }),
  },
  {
    name: 'uu_pty_send',
    run: (b, input) =>
      b.ptySend(
        String(input['handle'] ?? ''),
        String(input['keys'] ?? ''),
        typeof input['wait_ms'] === 'number' ? Number(input['wait_ms']) : undefined,
      ),
  },
  { name: 'uu_pty_read', run: (b, input) => b.ptyRead(String(input['handle'] ?? '')) },
  { name: 'uu_pty_close', run: (b, input) => b.ptyClose(String(input['handle'] ?? '')) },
];

export function registerLmTools(context: vscode.ExtensionContext): void {
  for (const def of TOOL_DEFS) {
    const tool: vscode.LanguageModelTool<Record<string, unknown>> = {
      async invoke(options) {
        const backend = await getBackend();
        const text = await def.run(backend, options.input);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
      },
    };
    context.subscriptions.push(vscode.lm.registerTool(def.name, tool));
  }
}
