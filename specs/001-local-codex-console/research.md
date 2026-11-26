# 协议与参考项目调研

以安装的 Codex CLI 0.153.2 生成的 TypeScript 协议和 [对应 App Server 文档](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/app-server/README.md) 为准。

- 历史通过 thread/list 和 thread/turns/list 分页。分页历史的写入所有权由 App Server 保证，读取无需加载。Windows 验证发现，旧版记录在外部进程运行期间仍可能显示为已中断。桥接在旧历史续聊前检查记录文件的共享状态。
- 新轮次携带模型、推理和协作模式设置。活动轮次使用带 expectedTurnId 的 turn/steer。采用 App Server 返回的预设和目录；权限与沙箱配置留给主机。
- 待处理交互以 serverRequest/resolved、轮次完成或子进程退出为结束信号。桥接服务在发送响应之前同步取得该请求的一次提交权。
- 套餐、额度和用量来自独立只读 RPC。Auth 文件只读修改时间。重连启动新子进程，保留设备授权。

## 参考版本与取舍

指定参考项目为 lezi-fun/codex-webui，核对版本为 `3d78b50be50089b1108af76b6ac114dbb30eb7c7`。实现先对照官方协议和本机 CLI。在恢复 GitHub 直连并发现 Issue 新增的参考项目章节后，完成了源码核对。验证结果见 [verification.md](verification.md)。

- 参考服务通过子进程标准输入输出连接 Codex，维护带超时的请求，并在子进程退出后更新连接状态。Codex Bridge 使用 Node 原生子进程与 HTTP API，采用 SSE 和按需快照恢复。 [参考服务源码](https://github.com/lezi-fun/codex-webui/blob/3d78b50be50089b1108af76b6ac114dbb30eb7c7/server.ts)
- 参考项目结合协议历史与本机记录读取，并将会话占用错误转换为明确提示。本项目通过官方历史接口和桥接进程收到的事件构造状态，分页历史沿用 Codex 写入锁，旧版 Windows 历史检查共享状态。 [参考会话状态](https://github.com/lezi-fun/codex-webui/blob/3d78b50be50089b1108af76b6ac114dbb30eb7c7/live-session-service.js) · [参考错误处理](https://github.com/lezi-fun/codex-webui/blob/3d78b50be50089b1108af76b6ac114dbb30eb7c7/public/bridge-errors.js)
- 参考项目采用签名 Cookie、密码认证和同源校验。初版通过主机终端发放一次性配对码，随后按用户反馈改为主机生成的用户名和密码。每台设备持有可单独撤销的 Cookie。 [参考访问控制](https://github.com/lezi-fun/codex-webui/blob/3d78b50be50089b1108af76b6ac114dbb30eb7c7/server-security.js)
- 本项目独立编写代码，依赖 Node 标准库和 Codex CLI。参考项目用于核对功能与异常处理思路。
