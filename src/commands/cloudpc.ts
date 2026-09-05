import * as vscode from 'vscode';
import { execCliJson, listCloudPCs, resolveCliPath } from '../cli';
import { getExtensionConfig } from '../config';
import { log } from '../log';
import { openCloudPcDetails } from '../panel';
import type { CloudPC } from '../types';
import { CloudPcTreeProvider } from '../providers/cloudPcTreeProvider';
import { confirmModal, ok, pickCloudPc, registerCommand, resolveFromSelection, withCli } from './common';

/** "全部"哨兵:对应 CLI 的 cloudpc shutdown/disconnect 不带 ID = 操作全部 */
const ALL_CLOUDPCS = Symbol('all-cloudpcs');
type CloudPcTarget = CloudPC | typeof ALL_CLOUDPCS;

interface CloudPcOrAllPickItem extends vscode.QuickPickItem {
  pc: CloudPC | undefined;
  all: boolean;
}

async function pickCloudPcOrAll(
  cloudpcs: CloudPC[],
  placeHolder: string,
  allLabel: string,
): Promise<CloudPcTarget | undefined> {
  const items: CloudPcOrAllPickItem[] = [
    { label: `$(warning) ${allLabel}`, description: '不指定 ID,对全部云电脑执行', pc: undefined, all: true },
    ...cloudpcs.map((pc) => ({
      label: pc.name,
      description: pc.cloudPCId,
      detail: `状态:${pc.status}`,
      pc,
      all: false,
    })),
  ];
  const chosen = await vscode.window.showQuickPick(items, { placeHolder });
  if (!chosen) {
    return undefined;
  }
  return chosen.all ? ALL_CLOUDPCS : chosen.pc;
}

export function registerCloudPcCommands(context: vscode.ExtensionContext, cloudPcProvider: CloudPcTreeProvider): void {
  const refresh = (): Promise<void> => cloudPcProvider.poll();

  registerCommand(context, 'uu.cloudpc.refresh', async () => {
    await refresh();
  });

  registerCommand(context, 'uu.cloudpc.launch', async (selection: unknown) => {
    const pc = await resolveFromSelection(selection, cloudPcProvider.currentCloudPcs, pickCloudPc, '选择要开机的云电脑');
    if (!pc) {
      return;
    }
    const result = await withCli(async (cliPath) => {
      const env = await execCliJson<unknown>(cliPath, ['cloudpc', 'launch', pc.cloudPCId]);
      log(`云电脑开机 ${pc.name}(${pc.cloudPCId})响应:${JSON.stringify(env)}`);
      return env;
    });
    if (result) {
      // 完整透出 CLI 响应,便于诊断"一直开不开机"(如配额/时段/会员限制会体现在响应里)
      vscode.window.setStatusBarMessage(`UU远程:云电脑「${pc.name}」开机请求已发送`, 4000);
      void vscode.window
        .showInformationMessage(
          `已请求「${pc.name}」开机。CLI 响应:${JSON.stringify(result.data ?? result).slice(0, 180)}`,
          '查看完整响应',
        )
        .then((btn) => {
          if (btn === '查看完整响应') {
            vscode.commands.executeCommand('uu.showOutput');
          }
        });

      // 轮询状态:5s / 15s / 40s;60 秒后仍未开机则明确报告原始响应
      const pollOnce = async (): Promise<CloudPC | undefined> => {
        const cliPath = await resolveCliPath(getExtensionConfig().cliPath);
        const cloudpcs = await listCloudPCs(cliPath);
        return cloudpcs.find((c) => c.cloudPCId === pc.cloudPCId);
      };
      const checkAt = async (ms: number): Promise<void> => {
        await new Promise((r) => setTimeout(r, ms));
        try {
          const current = await pollOnce();
          await refresh();
          if (!current) {
            return; // 列表已不含此云电脑,不重复提示
          }
          if (current.status !== 'shutdown') {
            ok(`云电脑「${pc.name}」已${current.status === 'running' ? '开机' : `进入 ${current.status} 状态`},可以连接了`);
          } else if (ms >= 40000) {
            void vscode.window
              .showWarningMessage(
                `云电脑「${pc.name}」请求开机 60 秒后仍为关机状态。CLI 原始响应已写入日志,请查看是否有配额/时段/会员限制。`,
                '查看日志',
              )
              .then((btn) => {
                if (btn === '查看日志') {
                  vscode.commands.executeCommand('uu.showOutput');
                }
              });
          }
        } catch {
          // 轮询失败不打扰用户,交给自动刷新
        }
      };
      void checkAt(5000);
      void checkAt(15000);
      void checkAt(40000);
    }
  });

  registerCommand(context, 'uu.cloudpc.shutdown', async (selection: unknown) => {
    const target = await resolveFromSelection(
      selection,
      cloudPcProvider.currentCloudPcs,
      (items, ph) => pickCloudPcOrAll(items, ph, '全部云电脑关机'),
      '选择要关机的云电脑(可选择全部)',
    );
    if (target === undefined) {
      return;
    }
    const isAll = target === ALL_CLOUDPCS;
    const single = target as CloudPC;
    const confirmed = await confirmModal(isAll ? '将关闭所有云电脑,确定?' : `将关闭云电脑「${single.name}」,确定?`, '关机');
    if (!confirmed) {
      return;
    }
    const args = isAll ? ['cloudpc', 'shutdown'] : ['cloudpc', 'shutdown', single.cloudPCId];
    const result = await withCli((cliPath) => execCliJson<unknown>(cliPath, args));
    if (result) {
      ok(isAll ? '全部云电脑关机中' : `云电脑关机中:${single.name}`);
      await refresh();
    }
  });

  registerCommand(context, 'uu.cloudpc.connect', async (selection: unknown) => {
    const pc = await resolveFromSelection(selection, cloudPcProvider.currentCloudPcs, pickCloudPc, '选择要连接的云电脑(需已开机)');
    if (!pc) {
      return;
    }
    if (pc.status !== 'running') {
      void vscode.window
        .showWarningMessage(`UU远程:云电脑「${pc.name}」当前状态为 ${pc.status},需开机后才能连接`, '立即开机')
        .then((btn) => {
          if (btn === '立即开机') {
            void vscode.commands.executeCommand('uu.cloudpc.launch', pc);
          }
        });
      return;
    }
    const result = await withCli((cliPath) => execCliJson<unknown>(cliPath, ['cloudpc', 'connect', pc.cloudPCId]));
    if (result) {
      ok(`已发起连接云电脑:${pc.name}`);
      await refresh();
    }
  });

  registerCommand(context, 'uu.cloudpc.disconnect', async (selection: unknown) => {
    const target = await resolveFromSelection(
      selection,
      cloudPcProvider.currentCloudPcs,
      (items, ph) => pickCloudPcOrAll(items, ph, '断开全部云电脑'),
      '选择要断开的云电脑(可选择全部)',
    );
    if (target === undefined) {
      return;
    }
    const isAll = target === ALL_CLOUDPCS;
    const single = target as CloudPC;
    const confirmed = await confirmModal(
      isAll ? '将断开所有云电脑的连接,确定?' : `将断开云电脑「${single.name}」的连接,确定?`,
      '断开',
    );
    if (!confirmed) {
      return;
    }
    const args = isAll ? ['cloudpc', 'disconnect'] : ['cloudpc', 'disconnect', single.cloudPCId];
    const result = await withCli((cliPath) => execCliJson<unknown>(cliPath, args));
    if (result) {
      ok(isAll ? '已断开全部云电脑' : `已断开云电脑:${single.name}`);
      await refresh();
    }
  });

  // 云电脑详情面板(Webview,内含操作按钮)
  registerCommand(context, 'uu.showCloudPcDetails', async (selection: unknown) => {
    const pc = await resolveFromSelection(selection, cloudPcProvider.currentCloudPcs, pickCloudPc, '选择要查看详情的云电脑');
    if (!pc) {
      return;
    }
    openCloudPcDetails(context, pc);
  });

  registerCommand(context, 'uu.copyCloudPcId', async (selection: unknown) => {
    const pc = await resolveFromSelection(selection, cloudPcProvider.currentCloudPcs, pickCloudPc, '选择要复制 ID 的云电脑');
    if (!pc) {
      return;
    }
    await vscode.env.clipboard.writeText(pc.cloudPCId);
    ok(`已复制云电脑 ID:${pc.cloudPCId}`);
  });
}
