# HTTP 与状态契约

## 主机读取

- `GET /api/v1/machines`、`GET /api/v1/machines/:id`：原响应兼容；`agent_status` 只按持久心跳计算，可附 `agent_observed_at` 供页面展示。普通 GET 不 SSH。
- 主机列表、Agent 列表、标签列表分开接收。主机请求成功即可停止主列表加载；辅助请求失败保留各自已有数据。一个来源的旧响应不得覆盖该来源的更新响应。

## 文件会话

- `POST /api/v1/machines/:id/file-session`，JSON `{ "credential_id": "<id>", "initial_path"?: "/absolute/path" }`：管理员 cookie、同源校验；取得既有终端租约并建立 SSH/SFTP。省略 `initial_path` 时保持原 `200`、`Cache-Control: no-store` 与 `{machine_id, credential_id, session_id, idle_timeout_ms:20000, expires_at}` 响应。提供时在该连接内读取目录，并额外返回 `initial_directory`，其字段与 `GET /api/v1/machines/:id/files?path=...` 的响应完全一致；路径校验、目录上限、错误码及逐操作审计遵循既有只读目录契约。初始目录读取失败时返回对应错误，不返回会话 ID，撤销本次新建/共享引用，最后一个引用关闭时释放 SSH/SFTP 与终端租约；不能误关其他面板持有的共享会话。会话 ID 为随机 128 位以上，仅内存保存。相同登录会话、主机和凭据可复用已有句柄并增加面板引用数，最多 8 个；不同凭据返回 `409 file_session_busy`，不关闭已有会话。
- 文件面板优先从已加载的 `GET /api/v1/machines` 响应 `machine.accounts[].credentials` 选择可复用凭据，只有该元数据不存在时才 GET 主机详情。无论来源如何，服务端建连始终重新校验登录、凭据状态、账户和主机绑定。此优化不改变列表/详情响应结构。
- 现有 `GET files|file|file-version|file-metadata`、`PUT file`、`POST file-upload|file-actions` 可带 `X-LightMoni-File-Session: <session_id>`。中心要求同一管理员登录 cookie、主机与凭据 ID；每次操作重查权限和租约，串行使用同一 SFTP。无此头走原逐请求 SSH 路径。会话不存在/过期在远端操作前返回 `409 file_session_expired`；凭据/主机目标变化返回 `409 file_credential_changed` 并关闭会话。请求中连接断开后的写入维持原 `unknown` 审计及核对提示。
- `DELETE /api/v1/machines/:id/file-session`，请求头传会话 ID，成功或已关闭均返回 `204`、`no-store`。只可释放同一登录会话的句柄引用；窗口关闭、切换账户时调用。最后一个引用关闭时拒绝新操作，在途操作完成后释放连接；服务器闲置/绝对超时和关闭时也释放终端租约。
- 文件审计仍逐操作记录 `machine_file_events`，不写会话 ID、SSH 密钥和正文。会话创建/关闭不当作文件变更。
- 普通文件读取每次最多 8 个在途 SFTP READ，每段最多 32 KiB，按文件偏移精确重组并补齐短读；提前 EOF 或打开前后 `fstat`/大小不一致返回 `file_changed`。仍按现有内容 SHA256 与 stat 组合生成版本，沿用 1 MiB 文本/8 MiB 上传限制、操作超时与取消。失败须收束在途读取并关闭句柄；不改变写入的版本核对、原子发布、写后核验和结果未知语义。

## 静态文件

- `GET|HEAD /`、`/index.html` 及 SPA 回退：`200`, `Cache-Control: no-store`, `text/html`。
- 带构建哈希的 `/assets/<name>-<hash>.<ext>`：`200`, `public, max-age=31536000, immutable`。
- 未版本化、实际存在的其他静态文件：`200`, `public, max-age=3600`。
- 缺失 `/assets/...`：`404`, `Cache-Control: no-store`，不会回退 HTML。
