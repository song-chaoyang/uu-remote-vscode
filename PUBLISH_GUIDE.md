# UU远程助手 — 发布指南

## 一、GitHub 开源

### 1. 创建 GitHub 仓库

1. 打开 https://github.com/new
2. 仓库名：`uu-remote-vscode`
3. 描述：`网易 UU远程(GameViewer) 的 VSCode 集成插件：设备管理、远程终端、无线副屏、AI 工具`
4. 选择 **Public**
5. **不要**勾选任何初始化选项（README、.gitignore、License 已存在）
6. 点击 Create repository

### 2. 推送代码

```bash
cd D:\Chaoyang\WorkSpace\uuyc_cli

# 初始化 Git（如果还没有）
git init

# 添加远程仓库
git remote add origin https://github.com/<你的用户名>/uu-remote-vscode.git

# 添加所有文件
git add .

# 首次提交
git commit -m "feat: UU远程助手 v0.8.0 — 设备管理、远程终端、无线副屏、AI工具(MCP+Copilot)"

# 推送
git push -u origin main
```

> ⚠️ **安全提醒**：不要使用已暴露的 Personal Access Token。请到 GitHub Settings → Developer settings → Personal access tokens 生成新的 token。

### 3. 添加标签

```bash
git tag -a v0.8.0 -m "v0.8.0: 无线副屏功能"
git push origin v0.8.0
```

---

## 二、VSCode Marketplace 发布

### 1. 获取 Azure DevOps Personal Access Token

1. 打开 https://dev.azure.com
2. 点击右上角头像 → **Personal access tokens**
3. 点击 **+ New Token**
4. 名称：`vsce-publish`
5. 组织：选择 **All accessible organizations**
6. 作用域：选择 **Marketplace → Manage**
7. 点击 **Create**
8. **复制生成的 token**（只显示一次）

### 2. 创建 Publisher（如果还没有）

1. 打开 https://marketplace.visualstudio.com/manage
2. 使用 Microsoft 账号登录
3. 点击 **+ Create Publisher**
4. Publisher ID：`song-chaoyang`（与 package.json 中的 publisher 一致）
5. 填写显示名称和其他信息
6. 创建完成

### 3. 发布

```bash
cd D:\Chaoyang\WorkSpace\uuyc_cli

# 方式一：使用 token 直接发布
npx @vscode/vsce publish --pat <你的Azure DevOps PAT>

# 方式二：先登录再发布
npx @vscode/vsce login song-chaoyang
# 输入 Azure DevOps PAT
npx @vscode/vsce publish
```

### 4. 验证发布

1. 打开 https://marketplace.visualstudio.com/items?itemName=song-chaoyang.uuyc-cli
2. 确认版本号为 0.8.0
3. 确认功能描述和截图正确

---

## 三、发布后检查清单

- [ ] GitHub 仓库已创建并推送
- [ ] README.md 显示正常
- [ ] LICENSE 文件存在
- [ ] .gitignore 正确排除了 dist/、node_modules/、*.vsix
- [ ] VSCode Marketplace 页面可访问
- [ ] 插件可通过 VSCode 扩展市场搜索到
- [ ] 插件功能正常（设备列表、远程终端、无线副屏等）

---

## 四、后续维护

### 更新版本

1. 修改 `package.json` 中的 `version`
2. 更新 `CHANGELOG.md`
3. 运行 `npm run package` 重新打包
4. 提交并推送：`git commit -am "chore: bump version to X.Y.Z" && git push`
5. 创建标签：`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
6. 发布：`npx @vscode/vsce publish`

### 撤销发布

```bash
npx @vscode/vsce unpublish song-chaoyang.uuyc-cli
```
