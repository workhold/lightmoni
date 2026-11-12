# HTTP 与状态契约

## 主机读取

- `GET /api/v1/machines`、`GET /api/v1/machines/:id`：原响应兼容；`agent_status` 只按持久心跳计算，可附 `agent_observed_at` 供页面展示。普通 GET 不 SSH。
- 主机列表、Agent 列表、标签列表分开接收。主机请求成功即可停止主列表加载；辅助请求失败保留各自已有数据。一个来源的旧响应不得覆盖该来源的更新响应。

## 文件会话

- `POST /api/v1/machines/:id/file-session`，JSON `{ "credential_id": "<id>" }`：管理员 cookie、同源校验；取得既有终端租约并建立 SSH/SFTP。返回 `200`、`Cache-Control: no-store` 与 `{machine_id, credential_id, session_id, idle_timeout_ms:20000, expires_at}`。会话 ID 为随机 128 位以上，仅内存保存。相同登录会话、主机和凭据可复用已有句柄并增加面板引用数，最多 8 个；不同凭据返回 `409 file_session_busy`，不关闭已有会话。
- 现有 `GET files|file|file-version|file-metadata`、`PUT file`、`POST file-upload|file-actions` 可带 `X-LightMoni-File-Session: <session_id>`。中心要求同一管理员登录 cookie、主机与凭据 ID；每次操作重查权限和租约，串行使用同一 SFTP。无此头走原逐请求 SSH 路径。会话不存在/过期在远端操作前返回 `409 file_session_expired`；凭据/主机目标变化返回 `409 file_credential_changed` 并关闭会话。请求中连接断开后的写入维持原 `unknown` 审计及核对提示。
- `DELETE /api/v1/machines/:id/file-session`，请求头传会话 ID，成功或已关闭均返回 `204`、`no-store`。只可释放同一登录会话的句柄引用；窗口关闭、切换账户时调用。最后一个引用关闭时拒绝新操作，在途操作完成后释放连接；服务器闲置/绝对超时和关闭时也释放终端租约。
- 文件审计仍逐操作记录 `machine_file_events`，不写会话 ID、SSH 密钥和正文。会话创建/关闭不当作文件变更。

## 静态文件

- `GET|HEAD /`、`/index.html` 及 SPA 回退：`200`, `Cache-Control: no-store`, `text/html`。
- 带构建哈希的 `/assets/<name>-<hash>.<ext>`：`200`, `public, max-age=31536000, immutable`。
- 未版本化、实际存在的其他静态文件：`200`, `public, max-age=3600`。
- 缺失 `/assets/...`：`404`, `Cache-Control: no-store`，不会回退 HTML。
