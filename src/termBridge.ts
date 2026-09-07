/**
 * TermBridge:基于 uuyc-cli term 通道的可编程远程执行桥。
 *
 * 实测协议事实(v4.39.2,Windows 被控端 + powershell):
 * - term 通道在管道模式下完全可交互:stdin 写命令 → 远程执行 → stdout 返回
 *   服务端"虚拟屏幕"渲染流(CSI 定位 + 文本,无 \n)
 * - 服务端屏幕约 39 行;超出屏幕的输出会被丢弃(不重发),因此必须分页
 * - 长行(>~90 列)会被服务端折行渲染,但折行子行数据无损,可按页内拼接还原
 * - 输入回显会写入屏幕:命令文本中的哨兵字面会立即出现在屏幕上造成误判,
 *   因此哨兵必须用表达式拼接生成,回显中不出现完整字面
 * - 每条命令前输出 60 个换行强制滚动清屏,保证提取窗口干净
 * - 页往返固定延迟 ~600-800ms,吞吐 ~5KB/s(协议固有限制)
 * - 连接日志([连接] ...)走 stderr,与 stdout 终端数据天然分离;
 *   stderr 中的错误行(如"主控端版本过低")会并入握手失败提示
 * - 退出会话必须显式发送 exit(仅 kill 本地进程会让会话在远程残留)
 *
 * Shell 协议(powershell 已实测;zsh/bash 为 macOS/Linux 被控端的实验性实现):
 * - powershell:Write-Output ("`n" * 60) 冲刷;$uuOut=@(...) 数组;[0..25] 分页;
 *   [Convert]::ToBase64String + List[string] 传输
 * - zsh/bash:for 循环 echo 冲刷;/tmp/uuOut.$$ 临时文件 + sed -n 'a,bp' 分页;
 *   base64 + fold -w 76 传输;哨兵用相邻字符串拼接(echo "A""B")避免回显误判
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { probeCliFeatures } from './capabilities';
import { VtScreen } from './vt';
import type { ShellKind } from './types';

/** PowerShell 单引号字面量转义 */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** POSIX shell 单引号字面量转义 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ExecOptions {
  timeoutMs?: number;
}

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** 每页最大输出行数(服务端屏幕 ~39 行,留哨兵/prompt/回显余量) */
const PAGE_ROWS = 26;

/** 冲刷行数:超过服务端屏幕高度,保证旧内容滚出 */
const FLUSH_ROWS = 60;

interface ShellProtocol {
  /** 冲刷命令前缀(输出 FLUSH_ROWS 个空行) */
  flush(): string;
  /** 哨兵生成命令:输出 sentry,且回显中不出现完整哨兵字面 */
  sentry(sentry: string): string;
  /** 执行命令并把输出存为行数组,输出 "计数哨兵"(<countSentry><count>) */
  assignRows(cmd: string, countSentry: string): string;
  /** 读取已存数组的第 [start, end] 行并输出页哨兵 */
  pageRows(start: number, end: number, sentry: string): string;
  /** 读取文件为 base64(每行 ≤76 字符),输出哨兵 */
  readFileB64(path: string, sentry: string, limit: number): string;
  /** 写入 base64 内容(多行 chunk),输出哨兵 */
  writeFileB64(path: string, chunks: string[], sentry: string): string;
  quote(s: string): string;
}

/** 提示符/回显行过滤(PowerShell 实测;zsh 哨兵提取不依赖此项,仅防御) */
function isNoiseLine(t: string, fullCmd: string): boolean {
  if (t === '' || /^PS [^>]*>\s*$/.test(t)) {
    return true;
  }
  const em = /^PS [^>]*>\s?(.*)$/.exec(t);
  if (em && (fullCmd.startsWith(em[1].slice(0, 16)) || em[1].startsWith(fullCmd.slice(0, 16)))) {
    return true; // 输入回显行
  }
  return false;
}

const powershellProtocol: ShellProtocol = {
  flush() {
    return `Write-Output ("\`n" * ${FLUSH_ROWS}); `;
  },
  sentry(s) {
    return `("${s.slice(0, 4)}" + "${s.slice(4)}")`;
  },
  assignRows(cmd, countSentry) {
    return `$global:uuOut = @(${cmd}); ("${countSentry.slice(0, 4)}" + "${countSentry.slice(4)}$($global:uuOut.Count)")`;
  },
  pageRows(start, end, s) {
    return `$global:uuOut[${start}..${end}]; ("${s.slice(0, 4)}" + "${s.slice(4)}")`;
  },
  readFileB64(path, s, limit) {
    return [
      `$f = Get-Item -Force -LiteralPath ${psQuote(path)}`,
      `if ($f.PSIsContainer) { 'ISDIR' } elseif ($f.Length -gt ${limit}) { 'TOOBIG|' + $f.Length } else {`,
      `  $s2 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))`,
      `  for ($j = 0; $j -lt $s2.Length; $j += 76) { $s2.Substring($j, [Math]::Min(76, $s2.Length - $j)) }`,
      `}`,
      `; ("${s.slice(0, 4)}" + "${s.slice(4)}")`,
    ].join(' ');
  },
  writeFileB64(path, chunks, s) {
    const lines = ["$L = New-Object 'System.Collections.Generic.List[string]'"];
    for (const chunk of chunks) {
      lines.push(`$L.Add('${chunk}')`);
    }
    lines.push(`[IO.File]::WriteAllBytes(${psQuote(path)}, [Convert]::FromBase64String(($L -join ''))); $L = $null; ("${s.slice(0, 4)}" + "${s.slice(4)}")`);
    return lines.join('\r\n');
  },
  quote: psQuote,
};

/** zsh / bash(实验性:针对 macOS/Linux 被控端) */
function posixProtocol(tmpPrefix: string): ShellProtocol {
  return {
    flush() {
      return `for i in $(seq 1 ${FLUSH_ROWS}); do echo; done; `;
    },
    sentry(s) {
      // 相邻字符串拼接,输入回显中不出现完整哨兵字面
      return `echo "${s.slice(0, 4)}""${s.slice(4)}"`;
    },
    assignRows(cmd, countSentry) {
      return `eval ${shQuote(cmd)} > ${tmpPrefix}uuOut 2>/dev/null; echo "${countSentry.slice(0, 4)}""${countSentry.slice(4)}$(wc -l < ${tmpPrefix}uuOut | tr -d ' ')"`;
    },
    pageRows(start, end, s) {
      return `sed -n '${start + 1},${end + 1}p' ${tmpPrefix}uuOut; echo "${s.slice(0, 4)}""${s.slice(4)}"`;
    },
    readFileB64(path, s, limit) {
      return [
        `sz=$(wc -c < ${shQuote(path)} 2>/dev/null | tr -d ' ')`,
        `if [ -d ${shQuote(path)} ]; then echo ISDIR`,
        `elif [ "$sz" -gt ${limit} ] 2>/dev/null; then echo "TOOBIG|$sz"`,
        `else base64 < ${shQuote(path)} | fold -w 76; fi`,
        `; echo "${s.slice(0, 4)}""${s.slice(4)}"`,
      ].join(' ');
    },
    writeFileB64(path, chunks, s) {
      const lines = [': > ' + shQuote(tmpPrefix + 'uuIn')];
      for (const chunk of chunks) {
        lines.push(`printf '%s' ${shQuote(chunk)} >> ${shQuote(tmpPrefix + 'uuIn')}`);
      }
      lines.push(`base64 -d < ${shQuote(tmpPrefix + 'uuIn')} > ${shQuote(path)} && rm -f ${shQuote(tmpPrefix + 'uuIn')}; echo "${s.slice(0, 4)}""${s.slice(4)}"`);
      return lines.join('\n');
    },
    quote: shQuote,
  };
}

export class TermBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private screen = new VtScreen();
  private seq = 0;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly protocol: ShellProtocol;
  private readonly stderrTail: string[] = [];

  constructor(
    private readonly cliPath: string,
    private readonly deviceId: string,
    private readonly shell: ShellKind = 'powershell',
    private readonly onStderr?: (line: string) => void,
  ) {
    this.protocol =
      shell === 'powershell'
        ? powershellProtocol
        : posixProtocol(`/tmp/uu-${process.pid}-`);
  }

  /** 串行化所有远程操作,避免命令交叉 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run as Promise<T>;
  }

  private ensureStarted(): Promise<void> {
    if (this.child && !this.closed) {
      return Promise.resolve();
    }
    if (this.closed) {
      return Promise.reject(new BridgeError('桥已关闭'));
    }
    return this.start();
  }

  private recordStderr(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 12) {
      this.stderrTail.shift();
    }
    this.onStderr?.(line);
  }

  /** stderr 中的关键错误行(过滤连接进度噪声),用于超时诊断 */
  private stderrDiagnosis(): string {
    const meaningful = this.stderrTail.filter(
      (l) => !/^\[连接\]|^\[系统\]|^\[终端\]|^─+$|^\[提示\]|^Warning:/i.test(l),
    );
    return meaningful.length > 0 ? meaningful.join(';').slice(0, 200) : '';
  }

  /** 进程已断开时抛错;带上 stderr 中的关键错误行(如「主控端版本过低」),让用户看到真实原因 */
  private throwIfDead(detail = ''): never {
    const diag = this.stderrDiagnosis();
    throw new BridgeError(`远程终端会话已断开${detail}${diag ? ` —— ${diag}` : ''}`);
  }

  private async start(): Promise<void> {
    // 旧版 CLI(如本机 macOS UURemote 4.39.1 自带的 CLI 1.0.0)的 term 仅有
    // open/exit 子命令(打开主程序终端窗口),无 --device-id/--new-session 管道通道。
    // 启动前探测一次(结果缓存),避免 spawn 后挂 20 秒超时才失败。
    const feats = await probeCliFeatures(this.cliPath);
    if (!feats.termChannel) {
      throw new BridgeError(
        '当前 uuyc-cli 版本不支持远程终端管道通道(term --device-id)。这是本机 UU远程主程序版本限制:' +
          '请升级主程序到支持该通道的版本(可在主程序内检查更新),或直接在 UU远程主程序中使用远程终端。',
      );
    }

    this.screen.reset();
    this.stderrTail.length = 0;
    this.child = spawn(this.cliPath, ['term', '--device-id', this.deviceId, '--new-session', '--shell', this.shell], {
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => this.screen.feed(d));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (line.trim()) {
          this.recordStderr(line.trim());
        }
      }
    });
    this.child.on('close', () => {
      this.child = undefined;
    });
    // 等待会话就绪:发送握手哨兵,直到它出现在屏幕上
    try {
      await this.waitSentry(this.protocol.flush() + this.protocol.sentry('UU_R_0'), 'UU_R_0', 20000);
    } catch (e) {
      const diag = this.stderrDiagnosis();
      throw diag
        ? new BridgeError(`远程终端会话无法就绪:${diag}`)
        : e instanceof Error
          ? e
          : new BridgeError(String(e));
    }
  }

  private async waitSentry(fullCmd: string, sentry: string, timeoutMs: number): Promise<void> {
    this.child!.stdin.write(fullCmd + '\r\n');
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 120));
      if (this.screen.contains(sentry)) {
        return;
      }
      if (!this.child || this.closed) {
        this.throwIfDead();
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new BridgeError(`命令超时(${timeoutMs}ms),设备可能繁忙或离线`);
      }
    }
  }

  /**
   * 执行单条命令,返回其输出行(已剔除提示符/回显)。
   * 适合输出行数确定较少的命令;行数可能超过一屏的请用 execRows。
   */
  exec(cmd: string, opts: ExecOptions = {}): Promise<string[]> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      return this.runOnce(cmd, opts.timeoutMs ?? 15000);
    });
  }

  private async runOnce(cmd: string, timeoutMs: number): Promise<string[]> {
    this.seq++;
    const sentry = `UU_E_${this.seq}`;
    const full = this.protocol.flush() + cmd + '; ' + this.protocol.sentry(sentry);
    this.child!.stdin.write(full + '\r\n');
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 130));
      if (this.screen.contains(sentry)) {
        return this.extract(sentry, full);
      }
      if (!this.child || this.closed) {
        this.throwIfDead();
      }
      if (Date.now() - t0 > timeoutMs) {
        const diag = this.stderrDiagnosis();
        throw new BridgeError(`远程命令超时(${timeoutMs}ms):${cmd.slice(0, 50)}${diag ? `(${diag})` : ''}`);
      }
    }
  }

  private extract(sentry: string, fullCmd: string): string[] {
    const lines = this.screen.snapshotLines();
    const idx = lines.findIndex((l) => l.includes(sentry));
    if (idx < 0) {
      return [];
    }
    const out: string[] = [];
    for (const line of lines.slice(0, idx)) {
      const t = line.replace(/\s+$/, '');
      if (isNoiseLine(t, fullCmd)) {
        continue;
      }
      out.push(t);
    }
    return out;
  }

  /**
   * 执行命令并把输出按行分页拉全(输出先落盘/数组,再按页读取)。
   * 用于行数不确定/可能超过一屏的命令(目录列表、base64 文件内容等)。
   */
  execRows(cmd: string, opts: ExecOptions = {}): Promise<string[]> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      const timeoutMs = opts.timeoutMs ?? 30000;
      this.seq++;
      const countSentry = `UU_N_${this.seq}`;
      const assign = this.protocol.flush() + this.protocol.assignRows(cmd, countSentry);
      this.child!.stdin.write(assign + '\r\n');
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 130));
        const hit = this.screen.snapshotLines().find((l) => l.includes(countSentry));
        if (hit) {
          const m = new RegExp(`${countSentry}(\\d+)`).exec(hit);
          const count = m ? parseInt(m[1], 10) : 0;
          return this.pullPages(count, timeoutMs);
        }
        if (!this.child || this.closed) {
          this.throwIfDead();
        }
        if (Date.now() - t0 > timeoutMs) {
          throw new BridgeError(`远程命令超时(${timeoutMs}ms):${cmd.slice(0, 50)}`);
        }
      }
    });
  }

  private async pullPages(count: number, timeoutMs: number): Promise<string[]> {
    const rows: string[] = [];
    for (let start = 0; start < count; start += PAGE_ROWS) {
      const end = Math.min(start + PAGE_ROWS - 1, count - 1);
      this.seq++;
      const sentry = `UU_P_${this.seq}`;
      const cmd = this.protocol.flush() + this.protocol.pageRows(start, end, sentry);
      this.child!.stdin.write(cmd + '\r\n');
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 130));
        if (this.screen.contains(sentry)) {
          rows.push(...this.extract(sentry, cmd));
          break;
        }
        if (!this.child || this.closed) {
          this.throwIfDead();
        }
        if (Date.now() - t0 > timeoutMs) {
          throw new BridgeError(`分页读取超时(第 ${start} 行起)`);
        }
      }
    }
    return rows;
  }

  /**
   * 读取文件为 base64(按行),末行之后追加哨兵。
   * 返回行数组;首行可能是 ISDIR / TOOBIG|<size> 状态标记。
   */
  readFileB64(path: string, limitBytes = 256 * 1024, opts: ExecOptions = {}): Promise<string[]> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      const timeoutMs = opts.timeoutMs ?? 120000;
      this.seq++;
      const sentry = `UU_F_${this.seq}`;
      const cmd = this.protocol.flush() + this.protocol.readFileB64(path, sentry, limitBytes);
      this.child!.stdin.write(cmd + '\r\n');
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 130));
        if (this.screen.contains(sentry)) {
          return this.extract(sentry, cmd);
        }
        if (!this.child || this.closed) {
          this.throwIfDead();
        }
        if (Date.now() - t0 > timeoutMs) {
          throw new BridgeError(`读取文件超时:${path}`);
        }
      }
    });
  }

  /**
   * 写文件:base64 分块经管道传输,末尾输出哨兵。
   * 上限约 512KB(协议吞吐 ~5KB/s,更大文件体验极差,直接拒绝)。
   */
  writeFile(path: string, content: Uint8Array): Promise<void> {
    const MAX = 512 * 1024;
    return this.enqueue(async () => {
      if (content.length > MAX) {
        throw new BridgeError(`文件过大(${Math.round(content.length / 1024)}KB > 512KB),远程通道暂不支持写入更大文件`);
      }
      await this.ensureStarted();
      const b64 = Buffer.from(content).toString('base64');
      this.seq++;
      const sentry = `UU_W_${this.seq}`;
      const chunkSize = 512;
      const chunks: string[] = [];
      for (let i = 0; i < b64.length; i += chunkSize) {
        chunks.push(b64.slice(i, i + chunkSize));
      }
      if (chunks.length === 0) {
        chunks.push('');
      }
      const payload = this.protocol.writeFileB64(path, chunks, sentry) + '\r\n';
      this.child!.stdin.write(payload);
      const t0 = Date.now();
      const timeoutMs = Math.max(30000, content.length / 2);
      for (;;) {
        await new Promise((r) => setTimeout(r, 150));
        if (this.screen.contains(sentry)) {
          return;
        }
        if (!this.child || this.closed) {
          this.throwIfDead('(写入可能未完成,请检查远端文件)');
        }
        if (Date.now() - t0 > timeoutMs) {
          throw new BridgeError(`写文件超时(${timeoutMs}ms)`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // 交互式终端原语(uu_pty_* 工具的底层,供 AI 处理交互提示:ssh 密码、y/n 确认等)
  // -------------------------------------------------------------------------

  /** 当前屏幕快照(非空行,行尾空白已修剪) */
  snapshot(): string[] {
    return this.screen.snapshotLines();
  }

  /** 原样写入输入(不做哨兵/冲刷处理);回车用 \r */
  writeRaw(keys: string): void {
    if (!this.child || this.closed) {
      throw new BridgeError('远程终端会话未启动或已关闭');
    }
    this.child.stdin.write(keys);
  }

  /** 会话是否仍在运行 */
  isAlive(): boolean {
    return !!this.child && !this.closed;
  }

  /** 启动并等待就绪(交互式会话打开时使用;不占用串行队列) */
  ensureReady(): Promise<void> {
    return this.ensureStarted();
  }

  /** 正常关闭:发送 exit 结束远程会话(避免会话在远程残留),再回收本地进程 */
  dispose(): Promise<void> {
    return this.enqueue(async () => {
      this.closed = true;
      if (this.child) {
        try {
          this.child.stdin.write('exit\r\n');
        } catch {
          // 进程可能已退出
        }
        await new Promise((r) => setTimeout(r, 600));
        this.child?.kill();
        this.child = undefined;
      }
    });
  }
}
