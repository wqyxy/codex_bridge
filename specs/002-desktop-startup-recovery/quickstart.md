# 恢复 Windows 桌面独立启动

在原部署的 Windows 用户下执行。若仍能复现问题，先采样再迁移。脚本只读取状态，输出时间、进程名、PID、父进程、监听、计划任务及筛选后的项目日志。把 `before` 和 `after` 两次输出留在主机，分享前按需去掉局域网地址。

```powershell
.\scripts\inspect-desktop-startup.ps1 -Phase before
# 在 Cockpit Tools 中切换到测试账户，记录报错或启动结果。
.\scripts\inspect-desktop-startup.ps1 -Phase after
```

1. 打开 Windows 任务计划程序，核对根目录下 `CodexBridge-Shared-Startup` 的操作确实指向本仓库的 `scripts\start-shared.ps1`，记下它的 `--credentials` 或 `-Credentials` 文件路径和局域网、端口参数。若任务已禁用，可直接继续。更新后的旧脚本只输出迁移提示。
2. 等待正在运行的轮次结束。禁用已经核对过的 Bridge 任务。若原任务启动的 Bridge 仍在运行，按原来的管理方式停止它。用 PID、父进程和端口核对后，只处理旧 Bridge 自己启动的后台。

   ```powershell
   Disable-ScheduledTask -TaskPath '\' -TaskName 'CodexBridge-Shared-Startup'
   ```

3. 按变更前的记录恢复用户级 `CODEX_APP_SERVER_WS_URL`。对默认部署，若确认此前未设置且当前仍等于项目写入的值，可执行下面命令。若此前有其他值，恢复记录里的值。若当前值已经为空或来自其他程序，则保留当前设置。机器级变量无需修改。

   ```powershell
   if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User') -ceq 'ws://127.0.0.1:8766') {
     [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
   }
   ```

4. 在 Windows「设置 → 应用 → 启动」把 ChatGPT 设回变更前的状态。若部署前启用，就重新启用。正常退出 ChatGPT，注销后重新登录 Windows 以刷新启动入口继承的环境，再从 Windows 开始菜单启动 ChatGPT。会话数据、Codex 登录凭据和 Bridge 网页凭据继续使用已有文件。
5. 用已有目录、私有 IPv4、端口和网页凭据启动 Bridge。下面是独立运行的示例。把示例值换成主机记录的值。

   ```powershell
   node src/server.mjs --lan 192.168.1.10 --port 8765 --cwd 'D:\agents\codex_bridge' --credentials '<已有凭据文件>'
   ```

## 查看桌面会话历史

在上述 Bridge 命令末尾加 `--desktop`。网页登录后可查看已有会话的保存记录，草稿在当前浏览器标签页按会话保存，刷新或切换会话后可以取回。页面提示当前桌面会话归属无法确认，并停用发送、停止和审批。输入仍可复制到桌面端。账户与模型面板不会用独立 App Server 的信息代替桌面账户。

在普通模式下，若已提交的发送没有拿到确认，页面会保留草稿并锁定发送。检查原会话后可手动解除锁定，再决定是否重新发送。

## 实机验收

在测试账户和测试会话上依次完成以下操作，并记录桌面版本与采样时间。

1. 在 Bridge 完全停止时从 Windows 开始菜单打开桌面端并使用官方登录入口。再分别启动 Bridge、正常停止 Bridge、只结束 Bridge 进程，核对桌面端仍能输入和读到回复。重启 Windows 后重复检查。
2. 用 Cockpit Tools 完成 A → B → A 切换。切换前后各采样一次，核对端口、计划任务、进程和在用账户。
3. 当前版本的桌面 IPC 如果恢复，使用桌面明确打开的测试会话检查桌面归属与当前账户。手机发送一条可辨识的消息，核对两端显示同一个会话 ID、输入和回复。再检查关闭会话、连接中断、重连、账户切换、运行中补充指令和审批。

## 评估 SSH 备选

官方桌面端通过 SSH 启动和管理远程 Codex。验证时需在已配置且获授权的 SSH 测试主机上确认桌面实际使用的 App Server 是否向第二个客户端开放，并确认 Bridge 与桌面连接同一个实例。Bridge 的显式 `--app-server-url` 可以连接主机回环上的实验性 WebSocket 端点，包括通过 SSH 转发的远端回环端点。先用同一会话 ID 做消息和回复往返，再验收账户及审批。另启一个远程 App Server 不满足这项验收。 [SSH 项目文档](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host) · [App Server 传输文档](https://learn.chatgpt.com/docs/app-server)
