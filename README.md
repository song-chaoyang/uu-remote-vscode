# UU远程助手 (UU Remote for VSCode)

基于网易 **UU远程(GameViewer)** 官方命令行工具 `uuyc-cli` 封装的 VSCode 插件:
在 VSCode 侧边栏管理远程设备与云电脑、直接打开**远程终端**、调整连接设置并执行输入诊断。

## 前置条件

- 已安装并运行 **UU远程主程序**,且已登录(插件通过 `uuyc-cli` 与主应用通信,主应用未运行时所有命令会失败)
- 未安装?[点击下载 UU远程](https://uuyc.163.com/download)(Windows / macOS / iOS / Android),安装后插件自动识别;CLI 未找到时插件会弹出安装引导
- `uuyc-cli` 可执行文件:插件会按以下顺序自动探测
  1. 设置项 `uu.cliPath`(推荐显式配置)
  2. 常见安装目录(Windows:`C:\Program Files\Netease\GameViewer\bin\uuyc-cli.exe` 等;macOS:`/Applications/UU远程.app/Contents/MacOS/` 等)
  3. 系统 `PATH`(`where/which uuyc-cli`)

> **主控端与被控端版本需匹配**:若远程终端报「主控端版本过低,被控端不再兼容此协议」,请把**本机** UU远程升级到与被控端相同或更新的版本。

## 平台支持

| 能力 | Windows 被控端 | macOS / Linux 被控端 |
|---|---|---|
| 串流连接、状态、云电脑、验证码、码率、诊断 | ✅ | ✅ |
| 远程终端(交互式) | ✅ powershell / cmd | ✅ zsh / bash(实验性) |
| AI 工具 remote_exec / list_dir / read / write(传 shell 参数) | ✅ | ✅(实验性,`shell: zsh/bash`) |
| 附加到编辑器(虚拟文件系统) | ✅ | 规划中(当前给出引导提示) |
| 插件运行环境(本机) | ✅ | ✅(macOS 自动探测 CLI 路径,`open -a` 启动主程序) |

## 功能总览

### 侧边栏「UU远程」

| 视图 | 说明 |
|---|---|
| 设备 | 顶部用户节点(昵称 / VIP,右键:用户详情、钱包、复制用户 ID);设备按在线 / 离线分组;在线设备内联按钮:连接、远程终端、详情;右键:串流连接、远程终端、新建会话、会话列表、详情、复制 ID、断开 |
| 云电脑 | 内联按钮:开机(关机时)/ 连接(运行时)/ 详情;右键:开机、关机、连接、断开、详情、复制 ID |

**状态引导**:UU远程主应用未运行或未登录时,树顶部显示引导节点,点击即可启动主程序(登录后自动刷新);CLI 未找到时点击打开**安装引导**(官网下载 / 设置路径 / 日志),首次使用也会自动弹出引导。

**交互速览**:
- **单击设备** → 打开详情面板(Webview,内嵌操作按钮)
- **悬停设备** → 显示 3 个内联小按钮(连接 / 远程终端 / 详情)
- **右键设备** → 完整操作菜单(串流连接、附加到编辑器、远程终端、会话管理、详情、复制 ID、断开)
- **右键用户节点** → 用户详情 / 钱包余额 / 复制用户 ID / **退出登录**(登录态由 UU远程主程序管理,选择后引导在主程序中退出)
- **右键分组标题** → 刷新
- 状态栏 `UU远程: N` 点击 → QuickPick 状态面板(已连接设备二级操作)

### 设备 / 云电脑详情面板

右键「详情」打开 Webview 面板(跟随 VSCode 主题):展示 ID、平台、在线 / 连接状态等,并内嵌操作按钮(串流连接、打开远程终端、开关机、复制 ID),操作后自动刷新状态。

### 状态栏

`UU远程: N` 显示当前已连接设备数;点击打开 **QuickPick 状态面板**:选择已连接设备可继续打开终端 / 查看详情 / 断开,底部提供连接新设备、断开全部、刷新等入口。主应用不可达时显示警告色。

### 附加到编辑器(Attach to Editor)

右键在线设备 → **「附加到编辑器」**,在**新窗口**中打开该设备的远程目录(`uu-remote://` 虚拟文件系统):
像 Remote-SSH 一样在资源管理器中浏览远程文件、双击打开编辑、保存即写回远端,全程无需串流画面。

- 支持:浏览目录、打开/保存文件、新建/删除/重命名
- 目前仅支持 **Windows 被控端**(基于远程 PowerShell)
- 性能:UU远程终端通道吞吐约 5KB/s,文件 **≤256KB 可读、≤512KB 可写**,更大文件会被拒绝并提示改用远程终端
- 首次打开目录 / 首次打开文件需要数秒(建立远程会话 + 分页传输),之后同会话内很快
- 通道空闲 5 分钟自动断开(正常结束远程会话,不残留)

### 无线副屏

将闲置的 iOS / Android 手机或平板通过 UU远程 变身为电脑的高性能无线触控副屏,拓展工作与操作区域。

- **零延迟**:0 延迟甚至负延迟,操作丝滑流畅
- **不限网络**:局域网 / 公网均可使用,无需数据线
- **触控操作**:副屏支持触控,可直接操作电脑内容
- **全平台**:iOS / Android 手机和平板均可作为副屏

**使用方式**:
- 侧边栏标题栏点击「📱」按钮 → 打开无线副屏引导面板(Webview)
- 右键设备 → 「启动无线副屏(主程序)」 → 一键启动主程序并引导操作
- 命令面板输入「UU远程: 打开无线副屏」→ 打开引导面板

**限制**:仅支持扩展模式(不支持镜像);目前仅能扩展一个副屏;声音仍从主屏传出;可通过浮层中的「布局方向」调整副屏位置。副屏使用期间可以发起远控,但不可被控。

### AI 集成(MCP + Copilot 工具)

安装即用,无需任何配置。提供 **11 个 AI 工具**,两条接入路径共享同一套后端:

| 工具 | 能力 |
|---|---|
| `uu_list_devices` | 列出设备与在线/连接状态 |
| `uu_remote_exec` | **在远程设备上执行命令**(AI 的核心能力) |
| `uu_remote_list_dir` / `uu_remote_read_file` / `uu_remote_write_file` | 浏览/读取/写入远程文件 |
| `uu_connect_device` / `uu_disconnect_device` | 串流连接/断开 |
| `uu_cloudpc_list` / `uu_cloudpc_power` | 云电脑列表/开机/关机 |
| `uu_echo_test` / `uu_local_device_id` | 通信测试/本机 ID |
| **`uu_pty_open` / `uu_pty_send` / `uu_pty_read` / `uu_pty_close`** | **交互式终端原语**:处理 ssh 密码、y/n 确认、分页输出等交互场景(与 uu-pty-bridge 生态同名同义) |

- **MCP 服务器**(标准协议):内嵌于插件(stdio),Copilot agent 模式自动发现;其他 MCP 客户端也可通过 VSCode 的 MCP 管理界面查看与启用
- **Copilot 原生工具**(languageModelTools):Copilot Chat 中可直接 `#uuDevices`、`#uuExec`、`#uuPtyOpen` 等引用,或让 agent 自动调用
- 危险操作(远程执行、写文件、关机等)由 VSCode 工具调用确认 UI 把关,annotations 已标注只读/破坏性

**穿越内网操控集群(参考 uu-pty-bridge 的验证链路)**:
> 「#uuPtyOpen 打开 HomePC,ssh 到实验室集群,看到密码提示后帮我输入并跑 squeue」
> AI:`uu_pty_open(HomePC)` → `uu_pty_send("ssh user@内网集群\r")` → 读屏看到提示 → 发送密码/回答确认 → 执行集群命令。UU远程账号链路天然穿越内网 NAT。

**示例**(Copilot Chat):
> 「用 #uuDevices 看看哪台设备在线,帮我在 HomePC 上跑一下 `Get-ComputerInfo`」
> 「读一下 HomePC 的 C:\Windows\win.ini 给我看看」

### 命令面板(输入 "UU" 查看全部)

**设备管理**
| 命令 | 对应 CLI |
|---|---|
| UU远程: 连接设备 | `uuyc-cli device connect <id>` |
| UU远程: 断开设备 / 断开所有设备 | `uuyc-cli device disconnect [id]` |
| UU远程: 查看连接状态 | `uuyc-cli device status` |
| UU远程: 刷新设备列表 | `uuyc-cli device list` |
| UU远程: 获取本机设备 ID | `uuyc-cli -d` |
| UU远程: 附加到编辑器(浏览/编辑远程文件) | 基于 `uuyc-cli term` 通道封装 |
| UU远程: 重置自定义验证码 | `uuyc-cli --reset-custom-code <code>` |

**云电脑**
| 命令 | 对应 CLI |
|---|---|
| UU远程: 云电脑开机 | `uuyc-cli cloudpc launch <id>` |
| UU远程: 云电脑关机(命令面板运行可选择「全部」) | `uuyc-cli cloudpc shutdown [id]` |
| UU远程: 连接云电脑(需已开机) | `uuyc-cli cloudpc connect <id>` |
| UU远程: 断开云电脑(命令面板运行可选择「全部」) | `uuyc-cli cloudpc disconnect [id]` |
| UU远程: 刷新云电脑列表 | `uuyc-cli cloudpc list` |

**远程终端(在 VSCode 集成终端中运行被控设备的终端)**
| 命令 | 对应 CLI |
|---|---|
| UU远程: 打开远程终端(shell 可选 powershell / cmd / zsh / bash) | `uuyc-cli term --device-id <id> --shell <s>` |
| UU远程: 新建远程终端会话 | `... --new-session` |
| UU远程: 远程终端会话列表(附加 / 终止) | `... --list-sessions` |
| UU远程: 附加远程终端会话 | `... --session-id <id>` |
| UU远程: 终止远程终端会话 | `... --kill-session <id>` |

**本地 UU 终端会话(`lterm`,终端下拉中也有「UU 本地终端」Profile)**
| 命令 | 对应 CLI |
|---|---|
| UU远程: 新建本地 UU 终端 | `uuyc-cli lterm new [name] --shell <s>` |
| UU远程: 附加本地 UU 终端 | `uuyc-cli lterm attach <name>` |
| UU远程: 本地终端会话列表 | `uuyc-cli lterm ls` |
| UU远程: 检查本地终端会话 | `uuyc-cli lterm has <name>` |
| UU远程: 终止本地终端会话 | `uuyc-cli lterm kill <name>` |
| UU远程: 重命名本地终端会话 | `uuyc-cli lterm rename <old> <new>` |

**用户 / 设置 / 诊断**
| 命令 | 对应 CLI |
|---|---|
| UU远程: 用户信息 | `uuyc-cli user info` |
| UU远程: 钱包余额 | `uuyc-cli user wallet` |
| UU远程: 版本信息 | `uuyc-cli --version` |
| UU远程: 测试主应用通信 | `uuyc-cli echo <msg>` |
| UU远程: 设置码率上限(1-500 Mbps,0=不限) | `uuyc-cli --set-bitrate-limit <bps>` |
| UU远程: 切换连接模式(完整 / 精简 Lite Punch) | `uuyc-cli --disable-lite-punch <bool>` |
| UU远程: 开启 / 关闭 / 导出输入诊断 | `uuyc-cli input-diag on/off/dump` |
| UU远程: 重装键盘钩子 / Win 键诊断探测 | `uuyc-cli input-diag hook-reinstall/server-win-probe` |
| UU远程: 打开输出日志 | 输出面板「UU远程」 |

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `uu.cliPath` | `""` | `uuyc-cli` 完整路径;留空自动探测 |
| `uu.autoRefreshSeconds` | `10` | 设备 / 云电脑 / 状态栏自动刷新间隔(秒),`0` 禁用 |
| `uu.term.defaultShell` | `powershell` | 远程终端默认 Shell |

## 开发

```bash
npm install
npm run typecheck        # 类型检查
npm run compile          # esbuild 构建 dist/extension.js
npm run smoke            # 构建并运行冒烟测试(实跑 CLI 只读命令,无需 VSCode)
npm run test-integration # VSCode 集成测试(启动本机 VSCode 实例,自动断言激活/命令/查询)
npm run package          # 类型检查 + 构建 + vsce 打包 .vsix
```

调试:在 VSCode 中打开本项目,按 `F5` 启动扩展开发宿主。

## 说明

- 「连接设备 / 云电脑」由 UU远程主应用打开远程控制(串流)窗口,插件负责发起与状态跟踪
- 远程终端为纯文本终端,在 VSCode 集成终端中直接与被控设备交互,不影响串流画面
- 所有 CLI 调用(含完整输出与耗时)记录在输出面板「UU远程」中
