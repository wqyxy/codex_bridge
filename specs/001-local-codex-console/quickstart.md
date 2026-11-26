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
- 如果另一个 App Server 持有会话，网页保留草稿。可在原客户端释放会话后重试，或改用 `--desktop` 查看已保存的桌面历史。
- 在侧栏点击项目名即可展开或折叠该项目的会话。项目里的「更多会话」用于加载该项目的较早记录。刷新后会恢复此浏览器上的折叠状态。
- 侧栏的「置顶」显示 Windows Codex 桌面端的本机置顶对话和项目。「项目」沿用该侧栏的排列。桌面端调整后，网页可在侧栏手动刷新，也会定期同步。
- 模型、推理强度和速度来自当前 App Server。侧栏「刷新」可以立即重新读取目录。
- 自动检查运行 `node --test`。实机验收见 [功能规范](spec.md) 和 [验证记录](verification.md)。

## Windows 桌面独立启动

从 Windows 开始菜单启动 ChatGPT Desktop。Bridge 用上面的命令独立运行。曾部署 `CodexBridge-Shared-Startup` 的主机，按 [Issue #2 恢复指南](../002-desktop-startup-recovery/quickstart.md) 停用旧任务并恢复 Windows 启动设置。需要只读查看桌面历史时，可加 `--desktop`。

主机可显式使用 `--app-server-url ws://127.0.0.1:<端口>` 连接独立管理的回环 App Server。此参数用于已存在的 App Server 服务。 [连接限制与 SSH 验收](../002-desktop-startup-recovery/quickstart.md#评估-ssh-备选)
