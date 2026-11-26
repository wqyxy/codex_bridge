# 本机启动

Windows 主机需要 Node.js 24 和已登录的 Codex CLI。从仓库目录启动。

```powershell
node src/server.mjs
```

用浏览器打开 [本机控制台](http://127.0.0.1:8765)，输入主机第一次启动时显示的用户名和密码。要从同一可信局域网访问，将下列示例地址换成主机实际的私有 IPv4。

```powershell
node src/server.mjs --lan 192.168.1.10 --cwd 'D:\agents\codex_bridge'
```

可重复传入 `--cwd` 配置新会话目录，或用 `--port` 指定端口。Windows 默认优先使用桌面版随附的 Codex CLI。用 `--codex` 可以指定其他 CLI 的完整路径。

- 在主机终端输入 `devices` 列出已登录设备，`revoke <编号>` 撤销设备。用户可在「账户与用量」面板退出网页。
- 用户名默认为 `admin`。登录后在「账户与用量」选择「修改网页密码」。新密码至少 12 个字符，保存后其他设备需要重新登录。忘记密码时停止 Node 服务，使用原启动参数加 `--reset-login` 重新启动以生成新密码。
- 在网页的「账户与用量」面板点击「重连 Codex」。重连会等待网页任务结束，网页登录继续有效。重启整个 Node 服务后使用原凭据重新登录。
- 如果另一个 App Server 持有会话，网页保留草稿。可在原客户端释放会话后重试，或使用下方的共享连接方式。
- 在侧栏点击项目名即可展开或折叠该项目的会话。项目里的「更多会话」用于加载该项目的较早记录。刷新后会恢复此浏览器上的折叠状态。
- 侧栏的「置顶」显示 Windows Codex 桌面端的本机置顶对话和项目。「项目」沿用该侧栏的排列。桌面端调整后，网页可在侧栏手动刷新，也会定期同步。
- 模型、推理强度和速度来自当前 App Server。侧栏「刷新」可以立即重新读取目录。
- 自动检查运行 `node --test`。实机验收见 [功能规范](spec.md) 和 [验证记录](verification.md)。

## Windows 登录后自动启动

当前主机在用户登录 Windows 后通过任务计划程序中的 `CodexBridge-Shared-Startup` 启动 [共享脚本](../../scripts/start-shared.ps1)。脚本使用该用户的 Codex 数据和网页凭据，等待回环 App Server 就绪后打开桌面端。Bridge 在局域网地址可用时启动。手机仍访问 [局域网页](http://10.0.0.10:8765/)。重启后使用已有用户名和密码重新登录。

用户环境变量 `CODEX_APP_SERVER_WS_URL` 默认为 `ws://127.0.0.1:8766`，桌面端和手动启动的 Bridge 可直接读取它。Windows 自带的 ChatGPT 启动开关已关闭，由共享任务统一启动。启动日志位于 `%LOCALAPPDATA%\CodexBridge\startup-8765-8766\status.log`。需临时恢复独立模式时，先禁用共享启动任务、清除用户级的共享环境变量，再重新启动桌面端和 Bridge。

## 手动启动共享 App Server

共享模式使用一个运行在 Windows 主机上的 App Server。只有 Bridge 的 HTTP 端口开放给手机。当前桌面构建读取启动时的 `CODEX_APP_SERVER_WS_URL`。WebSocket 是 App Server 的实验性传输。 [App Server WebSocket 文档](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/app-server/README.md#protocol)

1. 等待桌面端与网页的任务结束，完整退出 Codex 桌面端并停止旧 Bridge。在一个 PowerShell 中启动同版本桌面包里的 App Server。

   ```powershell
   $desktop = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
   & (Join-Path $desktop.InstallLocation 'app\resources\codex.exe') app-server --listen ws://127.0.0.1:8766
   ```

2. 在另一个 PowerShell 中用同一个地址启动 Bridge，沿用原来的局域网地址和其他设置。

   ```powershell
   node src/server.mjs --lan 192.168.1.10 --cwd 'D:\agents\codex_bridge' --app-server-url ws://127.0.0.1:8766
   ```

3. 从新的 PowerShell 启动桌面应用，给该次启动设置共享地址。

   ```powershell
   $desktop = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
   $env:CODEX_APP_SERVER_WS_URL = 'ws://127.0.0.1:8766'
   Start-Process -FilePath (Join-Path $desktop.InstallLocation 'app\ChatGPT.exe')
   ```

4. 在两端打开同一个已有会话，网页发送一条测试消息，然后在桌面端检查消息、回复和桌面工具。网页「重连 Codex」只重连到共享后台。若桌面工具或续聊出现问题，退出桌面端，结束测试启动的 App Server 和 Bridge，再用常规方式打开桌面端，并用原参数启动 Bridge。
