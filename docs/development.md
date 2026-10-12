# 开发、测试与打包

## 环境与构建

使用 Windows 10/11 x64、Node.js 24 和 npm。依赖版本以 `package-lock.json` 为准。

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run build
```

`npm run build` 先执行类型检查，再生成 Electron 主进程、Preload 和 Renderer 构建产物。构建结果位于 `out/`，不提交到 Git。

## 测试

```powershell
npm test
npm run test:watch
npm run test:e2e
```

`test:e2e` 会先重新构建应用。所有测试应使用独立临时数据目录，不应读取或修改个人正式数据库。

也可以对已经打包的应用执行同一套端到端测试：

```powershell
$env:PERSONAL_TODO_PACKAGED_EXE = (Resolve-Path 'release/win-unpacked/逐个锤.exe').Path
npx playwright test
Remove-Item Env:PERSONAL_TODO_PACKAGED_EXE
```

若受限环境中的 Vitest 临时缓存发生 `EPERM` 重命名错误，可在当前 PowerShell 会话中把临时目录设到仓库下再运行：

```powershell
New-Item -ItemType Directory -Path .tmp -Force | Out-Null
$env:TEMP = Join-Path (Get-Location).Path '.tmp'
$env:TMP = $env:TEMP
npm test
```

## Windows 打包

```powershell
# 生成 release/win-unpacked/
npm run package:dir

# 检查已有解包版的首屏、Preload、SQLite 写入、托盘驻留与重启读取
npm run test:packaged

# 生成 release/ZhuGeChui-Setup-<版本>-x64.exe
npm run package:win
```

安装包包含 Electron、Node 运行时和 SQLite 原生模块，目标电脑无需另装 Node.js。

Windows 打包脚本会在经过边界校验的 ASCII 临时目录中打包，再校验并发布到 `release/`，以规避部分打包工具对中文工作区路径的兼容问题；临时目录在成功或失败后都会清理。必要时可用 `PERSONAL_TODO_ASCII_STAGE_ROOT` 指定本机可写的 ASCII 绝对路径。

如需验证旧版数据库兼容性，可把由已关闭的旧版测试实例生成的数据库路径写入 `PERSONAL_TODO_LEGACY_DATABASE`，再执行 `npm run test:packaged`。脚本只会复制到独立临时目录后测试，不会写入源文件。可同时用 `PERSONAL_TODO_EXPECT_LEGACY_TASK` 指定一条应保留的旧任务标题。不要使用运行中的正式数据库作为测试种子。

## 升级兼容要求

以下标识关系到覆盖升级、旧数据读取和备份兼容，不能随品牌名变化：

| 标识 | 固定值 |
| --- | --- |
| npm 包名 | `personal-todo-desktop` |
| Electron 应用 ID | `io.local.personaltodo` |
| NSIS GUID | `bc225f2b-57f7-557b-8295-8a6764df8b31` |
| 本地数据目录名 | `personal-todo` |
| 备份 application ID | `io.local.personaltodo` |

不要在未确认迁移策略时更改数据库 schema、备份格式或恢复阶段标记。

## 发布

1. 更新版本与相关文档，执行类型检查、测试和构建。
2. 打包并检查解包版；在干净 Windows 10/11 x64 环境中验收安装、启动、覆盖升级、备份恢复和卸载。
3. 计算安装包的 SHA-256，将结果写入 `SHA256SUMS.txt`。
4. 创建对应 `v<版本>` Git 标签，将安装包与校验文件上传到 GitHub Releases，并说明已完成的验证和已知限制。

`release/` 中出现文件仅表示产生了打包输出，不等同于完成干净 Windows 安装机或跨电脑恢复验收。
