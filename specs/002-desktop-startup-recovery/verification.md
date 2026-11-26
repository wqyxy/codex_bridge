# 验证记录 · Issue #2

**日期** 2026-11-26（北京时间）  
**版本** Windows 桌面包 `OpenAI.Codex 26.1120.5083.0`，随附 Codex CLI `0.171.0-alpha.13.2`，Node.js `24.18.0`

## 旧部署和故障证据

- 旧启动日志在 21:51:07 记录共享 App Server 就绪（PID `83612`），21:51:09 记录 Bridge 已连接（PID `31268`），21:51:10 记录桌面已连接同一后台。计划任务最后一次返回 `0`。
- 23:06 当前状态采样中，`CodexBridge-Shared-Startup` 已禁用，用户级和机器级 `CODEX_APP_SERVER_WS_URL` 均为空，8765、8766 均无监听。`ChatGPT.exe` 主进程 PID 为 `76984`、父进程 PID 为 `13840`，其下有 `codex.exe` PID `68652`。Cockpit Tools PID 为 `59668`、父进程 PID 为 `73200`。桌面启动项 `App` 当前状态为 `1`（用户曾禁用），变更前状态缺少独立记录。当前系统设置保持原样。
- 旧共享部署使桌面启动依赖 8766。该地址无人监听时，连接会被拒绝。现存日志只有成功启动记录，缺少 Cockpit Tools 切换前后的采样，无法确认是什么导致共享后台退出或未恢复。

## 桌面接续与 SSH

- 在桌面端运行时，当前版本没有 `\\.\pipe\codex-ipc` 监听，连接探测超时。检查已安装包时，找到管道名称和 WebSocket 启动覆盖，但没有发现 `thread-owner-discovery` 或 `thread-follower-start-turn`。当前版本无法用参考实现的方法确认会话归属或发送消息。 [参考实现说明](https://github.com/taolin7406/syncodex-public/blob/main/docs/architecture.md) · [上游 Windows 报告](https://github.com/openai/codex/issues/62712)
- 已通过本机配置的 SSH 主机建立连接，登录 shell 的 `PATH` 中没有 `codex`，缺少启动官方远程项目的条件。官方桌面会自行启动和管理远程 App Server，现有 `--app-server-url` 只验证了对独立管理的回环 WebSocket 的连接逻辑。两端连接同一 SSH 项目后端、同 ID 往返仍待实测。 [官方 SSH 文档](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host) · [App Server 传输说明](https://learn.chatgpt.com/docs/app-server)
- 随附 CLI 提供 `codex queue --thread`。其帮助明确说明 `--resume` 只尝试在本地 daemon 或所选远端恢复会话，恢复失败时仍可能成功入队。入队成功无法证明当前 Windows 桌面持有并执行该会话。 [CLI 命令参考](https://learn.chatgpt.com/docs/cli/reference)
- 首选桌面 IPC 路径因此只开放已保存历史。普通网页登录仍可用。桌面模式下不展示未经核对的当前模型和额度，也不创建接续授权。

## 本次通过的检查

- `node --test` 20 项通过，覆盖旧环境变量隔离、显式共享地址、桌面只读的服务端边界、网页登录和发送不确定时的去重。`node --check` 与 `git diff --check` 通过。
- Windows 上用隔离的 Codex 配置、测试网页凭据和空闲回环端口启动新版 Bridge。测试进程继承旧 8766 地址时仍能使用随附 CLI 登录和读取会话列表。仅终止 Bridge 测试进程后，测试网页停止监听，原有 ChatGPT 进程仍在运行。旧脚本接受原参数并输出迁移提示。
- Chrome 使用临时配置和模拟后端验收。只读模式禁用发送，草稿在刷新后恢复且按会话隔离。模拟发送结果未知后，刷新保留锁定。手动解除锁定只恢复发送按钮，服务器共收到一次发送。

## 待验收

- 原部署下的 Cockpit Tools 故障前后证据。Windows 冷启动、官方手动启动及登录、A → B → A 实测。
- 手机对原会话 ID 的发送与回复、账户切换后的授权失效和重新确认。接续通过后，再验收进度、补充指令和审批同步。
