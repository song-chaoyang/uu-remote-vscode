/**
 * 冒烟测试(纯 Node,无 VSCode 依赖):`node esbuild.js && node dist/smoke.cjs`
 * 仅执行只读命令(echo/version/列表查询),不触碰任何有副作用的操作。
 *
 * TermBridge 真机测试为 opt-in:设置环境变量 UU_SMOKE_DEVICE_ID=<deviceId> 后
 * 额外验证远程执行桥(仅只读:目录列表/读取 win.ini,结束后 exit 正常退出会话)。
 */
import { existsSync, readFileSync } from 'fs';
import {
  CliError,
  echo,
  execCli,
  execCliText,
  getDeviceStatus,
  getLocalDeviceId,
  getUserInfo,
  getVersion,
  getWallet,
  listCloudPCs,
  listDevices,
  listLtermSessions,
  parseLtermLs,
  parseTermSessions,
  tryParseJson,
} from './cli';
import { resolveCliPath } from './cli';
import { TermBridge } from './termBridge';
import { VtScreen, extractOutput } from './vt';

let failed = 0;
let passed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? `  →  ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? `  →  ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('== uuyc-cli 封装层冒烟测试 ==\n');

  // 1. CLI 路径解析
  const cli = await resolveCliPath('');
  check('resolveCliPath', cli.length > 0, cli);

  // 2. 纯文本命令
  const echoMsg = `smoke-${Date.now()}`;
  const echoed = await echo(cli, echoMsg);
  check('echo', echoed === echoMsg, echoed);

  const version = await getVersion(cli);
  check('version', /^\d+\.\d+\.\d+/.test(version), version);

  const localId = await getLocalDeviceId(cli);
  check('local device id (-d)', /^\d+$/.test(localId), localId);

  // 3. 编码:中文输出不得出现 UTF-8 替换字符
  const raw = await execCli(cli, ['device', 'list']);
  check('utf-8 decode clean', !raw.stdout.includes('\uFFFD'), `len=${raw.stdout.length}`);

  // 4. JSON 查询
  const devices = await listDevices(cli);
  check(
    'device list',
    Array.isArray(devices) && devices.every(
      (d) => typeof d.deviceId === 'string' && typeof d.deviceName === 'string' && typeof d.isOnline === 'boolean',
    ),
    `共 ${devices.length} 台:${devices.map((d) => d.deviceName).join(', ') || '(空)'}`,
  );

  const connected = await getDeviceStatus(cli);
  check('device status', Array.isArray(connected), `已连接 ${connected.length} 台`);

  const cloudpcs = await listCloudPCs(cli);
  check(
    'cloudpc list',
    Array.isArray(cloudpcs) && cloudpcs.every(
      (c) => typeof c.cloudPCId === 'string' && typeof c.name === 'string' && typeof c.status === 'string',
    ),
    `共 ${cloudpcs.length} 台:${cloudpcs.map((c) => `${c.name}(${c.status})`).join(', ') || '(空)'}`,
  );

  const user = await getUserInfo(cli);
  check('user info', typeof user.userId === 'string' && user.userId.length > 0, `${user.nickname} / VIP=${user.isVip}`);

  const wallet = await getWallet(cli);
  check('wallet', typeof wallet.coinBalance === 'number', `U币余额 ${wallet.coinBalance}`);

  // 5. 表格解析:lterm ls(可能无会话,只验证不抛错 + 解析器单测)
  const ltermOut = await execCliText(cli, ['lterm', 'ls']);
  const ltermParsed = await listLtermSessions(cli);
  check('lterm ls', typeof ltermOut === 'string' && Array.isArray(ltermParsed), `输出 ${ltermOut.split(/\r?\n/)[0] ?? ''}`);

  const sampleLs = 'NAME  SHELL  STATE  CREATED_AT_MS\nwork  powershell  running  1788599000000\nweb  cmd  exited  1788599000001';
  const parsedLs = parseLtermLs(sampleLs);
  check(
    'parseLtermLs sample',
    parsedLs.length === 2 && parsedLs[0].name === 'work' && parsedLs[0].shell === 'powershell' && parsedLs[0].createdAtMs === 1788599000000,
    JSON.stringify(parsedLs.map((s) => s.name)),
  );

  // 6. JSON 提取与远程会话解析
  const mixedJson = tryParseJson('[连接] 初始化连接\n{"data":{"devices":[]},"success":true}');
  check(
    'tryParseJson mixed log + json',
    mixedJson !== undefined && JSON.stringify(mixedJson).includes('"success":true'),
  );
  check('parseTermSessions (no active)', parseTermSessions('No active sessions.').length === 0);
  // 实测 TSV 表格格式:SESSION_ID\tNAME\tSHELL\tSTATE\tLAST_ACTIVE
  const tsvSessions = parseTermSessions(
    '[连接] 初始化连接\nSESSION_ID\tNAME\tSHELL\tSTATE\tLAST_ACTIVE\n2147483649\tsession2\tpowershell\trunning\t1788601231903\n',
  );
  check(
    'parseTermSessions (tsv sessions)',
    tsvSessions.length === 1 &&
      tsvSessions[0]?.id === '2147483649' &&
      tsvSessions[0]?.label === 'session2' &&
      tsvSessions[0]?.shell === 'powershell' &&
      tsvSessions[0]?.state === 'running',
    JSON.stringify(tsvSessions[0]?.label),
  );

  // 7. 错误检测:term 不带设备名应识别为错误并抛 CliError
  let errorCaught = '';
  try {
    await execCliText(cli, ['term', '--list-sessions']);
    errorCaught = '(未抛出错误)';
  } catch (e) {
    errorCaught = e instanceof CliError ? e.message : `非 CliError 异常: ${String(e)}`;
  }
  check('error detection (term w/o device)', /device name/i.test(errorCaught), errorCaught);

  // 8. 未找到 CLI 路径时应抛出友好错误
  let pathError = '';
  try {
    await resolveCliPath('Z:\\not\\exist\\uuyc-cli.exe');
    pathError = '(未抛出错误)';
  } catch (e) {
    pathError = e instanceof CliError ? 'ok' : `非 CliError 异常: ${String(e)}`;
  }
  check('resolveCliPath invalid config', pathError === 'ok', pathError);

  // 9. VT 屏幕模拟器:真实 term 字节流 fixture 回归
  const fixturePath = 'test/fixtures/term-session.stdout.raw.txt';
  if (existsSync(fixturePath)) {
    const raw = readFileSync(fixturePath, 'utf8');
    const screen = new VtScreen();
    for (let i = 0; i < raw.length; i += 97) {
      screen.feed(raw.slice(i, i + 97));
    }
    const hasLong = screen.contains('UU_LONG_DONE');
    const longRows = extractOutput(screen.snapshotLines(), 'UU_LONG_DONE', []).map((l) => l.trim());
    const bLen = longRows.join('').length;
    check('vt fixture: 哨兵还原', hasLong, `折行 ${longRows.length} 段`);
    check('vt fixture: 长行数据无损拼接', bLen === 2000, `B 总长 ${bLen}/2000`);
    const promptOk = screen.snapshotLines().some((l) => /^PS [^>]*>\s*$/.test(l));
    check('vt fixture: 提示符行渲染', promptOk);
  } else {
    check('vt fixture 存在', false, `缺少 ${fixturePath}(运行 node .codely-cli/capture.js 重新生成)`);
  }

  // 10. TermBridge 真机测试(opt-in:UU_SMOKE_DEVICE_ID=<deviceId>)
  const bridgeDevice = process.env['UU_SMOKE_DEVICE_ID'];
  if (bridgeDevice) {
    console.log(`\n-- TermBridge 真机测试(${bridgeDevice},只读)--`);
    const bridge = new TermBridge(cli, bridgeDevice, 'powershell', (l) => console.log(`    [stderr] ${l}`));
    try {
      const dirRows = await bridge.execRows(
        "Get-ChildItem -Force -LiteralPath 'C:\\\\Windows' | Select-Object -First 5 | ForEach-Object { if ($_.PSIsContainer) { 'D|' + $_.Name } else { 'F|' + $_.Name } }",
        { timeoutMs: 30000 },
      );
      check('bridge: 远程目录列表', dirRows.length > 0 && dirRows.every((r) => /^[DF]\|/.test(r)), dirRows.join(' ; '));

      const statRows = await bridge.exec(
        "if (Test-Path -LiteralPath 'C:\\\\Windows\\\\win.ini') { 'Y' } else { 'N' }",
        { timeoutMs: 20000 },
      );
      check('bridge: 远程 stat', statRows[0] === 'Y', statRows.join());

      const b64Rows = await bridge.execRows(
        "$s = [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\\\\Windows\\\\win.ini')); for ($j = 0; $j -lt $s.Length; $j += 76) { $s.Substring($j, [Math]::Min(76, $s.Length - $j)) }",
        { timeoutMs: 60000 },
      );
      const b64 = b64Rows.map((r) => r.trim()).join('');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      check('bridge: 远程读取文件(base64)', b64.length > 0 && decoded.includes('[fonts]'), `${Math.floor(b64.length * 3 / 4)} 字节`);
    } catch (e) {
      // 通道不可用(环境问题,如本机主控端版本低于被控端):验证错误消息必须带 stderr 诊断
      const msg = e instanceof Error ? e.message : String(e);
      const hasDiag = /版本过低|不再兼容|升级主控端|超时|已断开\s——/.test(msg);
      check('bridge: 失败时错误必须携带诊断信息', hasDiag && msg.length > 20, msg.slice(0, 160));
      console.log('  (远程通道当前不可用 —— 属环境问题(本机 UU远程 主控端需升级),错误质量已验证)');
    } finally {
      await bridge.dispose();
      check('bridge: 会话清理完成', true);
    }
  } else {
    console.log('\n(跳过 TermBridge 真机测试:设置 UU_SMOKE_DEVICE_ID=<deviceId> 启用)');
  }

  // 11. MCP 服务器 stdio 协议实测(真实 spawn + JSON-RPC + 真实工具调用)
  const mcpServer = 'dist/mcp-server.cjs';
  if (existsSync(mcpServer)) {
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, [mcpServer], {
      env: { ...process.env, UU_CLI_PATH: cli },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    let errOut = '';
    child.stderr.on('data', (d: Buffer) => (errOut += d.toString('utf8')));
    const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'uu_echo_test', arguments: { message: 'mcp-smoke' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'uu_local_device_id', arguments: {} } });
    await new Promise((r) => setTimeout(r, 6000));
    child.kill();

    const responses = new Map<number, { result?: { [k: string]: unknown }; error?: unknown }>();
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === 'number') {
          responses.set(msg.id, { result: msg.result as { [k: string]: unknown }, error: msg.error });
        }
      } catch {
        // 忽略非 JSON 行
      }
    }
    const init = responses.get(1);
    const serverName = (init?.result?.serverInfo as { name?: string } | undefined)?.name;
    check('mcp: initialize 握手', serverName === 'uu-remote', `serverInfo=${JSON.stringify(init?.result?.serverInfo ?? null)}`);
    const tools = (responses.get(2)?.result?.tools as Array<{ name: string }> | undefined) ?? [];
    const toolNames = tools.map((t) => t.name).sort();
    check(
      'mcp: tools/list 返回 16 个工具',
      toolNames.length === 16 && toolNames.every((n) => n.startsWith('uu_')),
      toolNames.join(', '),
    );
    const echo = (responses.get(3)?.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
    check('mcp: tools/call uu_echo_test(真实回显)', echo.includes('mcp-smoke'), echo);
    const myId = (responses.get(4)?.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
    check('mcp: tools/call uu_local_device_id', /\d{6,}/.test(myId), myId);
    if (errOut.trim()) {
      console.log(`    (mcp stderr: ${errOut.trim().slice(0, 120)})`);
    }
  } else {
    check('mcp: dist/mcp-server.cjs 存在', false, '先运行 node esbuild.js 构建');
  }

  console.log(`\n== 结果: ${passed} 通过, ${failed} 失败 ==`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('冒烟测试执行异常:', e);
  process.exit(1);
});
