# HTTP 与 WebSocket 契约

- `POST /api/v1/machines/:id/terminal-sessions`：管理员；`{credential_id?:string,cols?:number,rows?:number}`，拒绝其他参数。返回 `{id,status:"pending",websocket_path,connect_expires_at,idle_seconds,max_seconds}`，不返回秘密。等待连接 60 秒；每人最多 3 个未结束会话，全局最多 20 个。
- `GET .../terminal-sessions/:sessionId/ws`：WebSocket upgrade；必须携带同源 Origin、原登录 cookie，匹配创建者和主机，会话只能使用一次；普通 GET 不建立 SSH。
- `DELETE .../terminal-sessions/:sessionId`：当前创建者显式关闭自己的会话。
- 客户端 JSON：`{type:"input",data:string}`（最多 16 KiB）、`{type:"resize",cols:2..500,rows:2..200}`、`{type:"ack",bytes:正整数}`。禁止其他字段/类型与二进制输入。
- 服务端 JSON：`{type:"status",status:"connecting"|"connected"|"closed",reason?:固定码}`；`{type:"error",code:固定码}`。SSH 输出为二进制帧，保留 UTF-8/ANSI。
- 连接/认证最长 20 秒；输出未确认窗口 256 KiB 后暂停，超过硬限制关闭；WebSocket 和输入流有缓冲上限。10 分钟无输入或 30 分钟会话上限后断开。
- 撤销凭据立即断开；登录/角色/凭据过期至多 5 秒内断开，输入前也会复核。终端不加入 AI 工具目录。
