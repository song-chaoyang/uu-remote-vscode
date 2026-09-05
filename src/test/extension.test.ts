import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getDeviceStatus, listCloudPCs, listDevices, resolveCliPath } from '../cli';
import { CloudPcTreeProvider } from '../providers/cloudPcTreeProvider';
import { DeviceTreeProvider } from '../providers/deviceTreeProvider';
import { suite, test } from './runner';
import pkg from '../../package.json';

const EXTENSION_ID = `${pkg.publisher}.${pkg.name}`;
const DECLARED_COMMANDS = (pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command);

suite('UU远程助手 扩展集成测试', () => {
  test('扩展可激活', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `扩展 ${EXTENSION_ID} 未找到`);
    await ext!.activate();
    assert.ok(ext!.isActive, '扩展激活失败');
  });

  test('manifest 中全部命令均已注册', async () => {
    const all = await vscode.commands.getCommands(true);
    const missing = DECLARED_COMMANDS.filter((id) => !all.includes(id));
    assert.deepStrictEqual(missing, [], '以下命令未注册');
  });

  test('CLI 查询在扩展宿主内可用(真实调用)', async () => {
    const cliPath = await resolveCliPath('');
    assert.ok(cliPath.length > 0, '未探测到 CLI 路径');

    const devices = await listDevices(cliPath);
    assert.ok(Array.isArray(devices), '设备列表应为数组');
    devices.forEach((d) => {
      assert.strictEqual(typeof d.deviceId, 'string');
      assert.strictEqual(typeof d.deviceName, 'string');
      assert.strictEqual(typeof d.isOnline, 'boolean');
    });

    const cloudpcs = await listCloudPCs(cliPath);
    assert.ok(Array.isArray(cloudpcs), '云电脑列表应为数组');

    const connected = await getDeviceStatus(cliPath);
    assert.ok(Array.isArray(connected), '连接状态应为数组');
  });

  test('刷新类命令执行不抛错', async () => {
    await vscode.commands.executeCommand('uu.refreshDevices');
    await vscode.commands.executeCommand('uu.cloudpc.refresh');
  });

  test('只读信息命令执行不抛错', async () => {
    // 仅执行"自动消失式"提示命令;交互式命令(showDeviceStatus 的
    // QuickPick、logout 的确认框等)不适合自动化断言,其注册已由
    // 「manifest 中全部命令均已注册」覆盖
    await vscode.commands.executeCommand('uu.showVersion');
    await vscode.commands.executeCommand('uu.showWallet');
    await vscode.commands.executeCommand('uu.showUserInfo');
  });

  test('树节点运行时 contextValue 与菜单声明一致(右键菜单的前提)', async () => {
    // 直接实例化 Provider 拉真实数据,断言每个节点的 contextValue
    // 与 package.json menus.view/item 的 when 匹配值完全一致
    const deviceProvider = new DeviceTreeProvider();
    await deviceProvider.poll();
    const roots = (await deviceProvider.getChildren()) ?? [];
    assert.ok(roots.length > 0, '设备树根节点为空(主应用可能未运行)');

    const expectedRootContexts = ['uu-user', 'uu-group-online', 'uu-group-offline', 'uu-status-app', 'uu-status-login', 'uu-status-cli'];
    let deviceCount = 0;
    for (const root of roots) {
      const cv = (root as vscode.TreeItem).contextValue ?? '';
      assert.ok(
        expectedRootContexts.includes(cv),
        `根节点 contextValue 意外:${cv}(期望之一:${expectedRootContexts.join(', ')})`,
      );
      const group = root as unknown as { children?: Array<{ contextValue?: string }> };
      if (cv === 'uu-group-online' || cv === 'uu-group-offline') {
        assert.ok(Array.isArray(group.children), '分组节点缺少 children');
        for (const child of group.children ?? []) {
          assert.ok(
            child.contextValue === 'device-online' || child.contextValue === 'device-offline',
            `设备节点 contextValue 意外:${child.contextValue}`,
          );
          deviceCount++;
        }
      }
    }
    console.log(`  (contextValue 校验通过:${roots.length} 个根节点,${deviceCount} 台设备)`);

    const cloudPcProvider = new CloudPcTreeProvider();
    await cloudPcProvider.poll();
    const pcs = (await cloudPcProvider.getChildren()) ?? [];
    for (const pc of pcs) {
      const cv = (pc as vscode.TreeItem).contextValue ?? '';
      assert.ok(
        ['cloudpc-running', 'cloudpc-shutdown', 'uu-status-app', 'uu-status-cli'].includes(cv),
        `云电脑节点 contextValue 意外:${cv}`,
      );
    }
  });
});
