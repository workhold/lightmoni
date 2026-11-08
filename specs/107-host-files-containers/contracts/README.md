# HTTP 契约

全部文件路由要求活动管理员 cookie 会话，拒绝 Authorization 请求头。路径 query `path` 为绝对 POSIX 路径；`credential_id` 可选，未传使用主机默认账户凭据。响应 `Cache-Control: no-store`。

- `GET /api/v1/machines/:id/files?path=/` → `{machine_id,path,entries:[{name,type,size,mode,modified_at}],truncated}`。
- `GET .../file?path=/a` → `{machine_id,path,content,version,size}`，文本上限1MiB。
- `GET .../file-version?path=/a` → `{machine_id,path,version}`；不存在时 version=null，普通文件上限8MiB。
- `PUT .../file?path=/a` JSON `{content,expected_version,confirmed:true}` → `{machine_id,path,version,size}`。
- `POST .../file-upload?path=/a&expected_version=<version|new>&confirmed=true` 原始 octet-stream ≤8MiB → 同写入回执；浏览器先明确确认目标和覆盖。

version 为内容与权限/属主/mtime/size摘要。目标已变化返回409；非法路径/正文400，权限403，路径不存在404，类型不支持或并发409，超限413，远端错误502/504，错误不含原始 SSH/SFTP 输出。所有文件写入必须预先取得明确版本或new，不能无条件覆盖。

容器继续使用既有 `GET /api/v1/ops/inventory?machine_id=`、`POST /api/v1/ops/machines/:id/docker-jobs`（operation=inventory）及原作业读取接口，不新增协议。
