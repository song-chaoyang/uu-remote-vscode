/**
 * AI 工具后端接口镜像(纯类型,与 src/tools.mts 的 UuToolsBackend 保持同步)。
 * 说明:tools 模块是 ESM(.mts),而扩展侧文件是 CJS;CJS 直接 type-import ESM
 * 需要 resolution-mode 属性(esbuild 兼容性差),因此以接口镜像的方式提供类型,
 * 运行时通过动态 import() 获取实现。
 */
export interface UuBackend {
  listDevices(): Promise<string>;
  remoteExec(deviceId: string, command: string, shell?: string): Promise<string>;
  remoteListDir(deviceId: string, path: string, shell?: string): Promise<string>;
  remoteReadFile(deviceId: string, path: string, shell?: string): Promise<string>;
  remoteWriteFile(deviceId: string, path: string, content: string, shell?: string): Promise<string>;
  connectDevice(deviceId: string): Promise<string>;
  disconnectDevice(deviceId?: string): Promise<string>;
  cloudpcList(): Promise<string>;
  cloudpcPower(cloudpcId: string, action: 'on' | 'off'): Promise<string>;
  echoTest(message?: string): Promise<string>;
  localDeviceId(): Promise<string>;
  remoteLaunch(deviceId: string, program: string): Promise<string>;
  ptyOpen(deviceId: string, opts?: { shell?: string }): Promise<string>;
  ptySend(handle: string, keys: string, waitMs?: number): Promise<string>;
  ptyRead(handle: string): Promise<string>;
  ptyClose(handle: string): Promise<string>;
}
