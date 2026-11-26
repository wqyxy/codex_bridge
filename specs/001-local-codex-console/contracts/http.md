# HTTP 契约

页面和 API 同源。匿名请求可加载页面、读取登录状态和提交登录凭据。其余 API 需要设备 Cookie。写操作需要匹配页面来源和 JSON 请求体。

- GET /api/session、POST /api/login 与 POST /api/logout 管理浏览器登录。登录提交用户名、密码和可选设备名称。
- POST /api/password 接收已登录浏览器提交的 currentPassword 和 newPassword。当前密码错误返回 HTTP 403。保存后该浏览器保持登录，其他设备会收到撤销事件。
- 支持原生回执时，会话摘要、历史响应和 read 事件包含 readState。POST /api/read 接收 threadId 和 revision。回执版本冲突时保留服务端当前状态。
- GET /api/projects 读取按桌面布局排列的本机项目，并返回包含置顶对话和项目的有序 pinned 列表。GET /api/threads 接受可选的 project 过滤条件，GET /api/thread 读取指定会话的分页历史。GET /api/live 返回当前实时快照。
- GET /api/events 推送快照变更范围。初次连接及重新连接时先通知客户端读取当前快照。
- POST /api/thread、/api/send、/api/stop、/api/respond 分别创建会话、开始或追加输入、停止和响应请求。
- GET /api/meta 与 GET /api/account 读取模型、模式和账户投影。GET /api/meta?refresh=1 立即从当前 App Server 读取模型目录。POST /api/reconnect 在安全边界重连。
- POST 请求包含客户端操作 ID 的写入支持去重。错误返回可用于界面展示的原因。
- 另一个 App Server 持有会话时，发送返回 HTTP 409 和 THREAD_BUSY，浏览器保留当前草稿。共享后台上的发送使用请求中的原 threadId。追加到活动轮次时，响应包含该轮次的 turnId 和 steered: true。
