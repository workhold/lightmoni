# SDK 接入契约

- `GET /api/v1/sdk-exempt-tables`：登录可读，返回 `{name,description,active,created_at}[]`，无通配符、默认空。
- `POST /api/v1/sdk-exempt-tables`：管理员，`{name,description?:string,active?:boolean}`，201 返回条目；非法 400，同名 409。
- `PUT /api/v1/sdk-exempt-tables/:name`：管理员，只更新 `{description?:string,active?:boolean}`；404 不存在。逻辑表名不可重命名，避免隐式转移权限。
- `DELETE /api/v1/sdk-exempt-tables/:name`：管理员，移除授权并返回 `{ok:true}`；404 不存在，不删除遥测数据。
- `POST /api/v1/keys` 不变；样例内创建传 `{name,allowed_tables:[当前表],allow_all_tables:false}`，新明文只返回一次。列表与编辑不返回密钥。
- `/api/v1/sdk-install` 展示 Go、Node.js（id 沿用 typescript）、Rust、Python 四项；历史 SDK 文件下载继续兼容。
- `/v1/logs|metrics|traces`：Authorization 存在必须通过原密钥认证；头完全缺失时，只能写启用豁免逻辑表，不能写系统表。无豁免时仍为 401，越权为 403；表名非法 400。所有信号共用校验，不依赖页面状态。
- 无密钥写入 `key_id=''`；不路由到系统 SDK 表；批次 ID 使用独立匿名命名空间；每次重试先重新鉴权，删除/停用后已确认批次也不可重放。
- `/v1/sdk-config` 无密钥时仅公开启用豁免表对应的日志策略；无豁免为 401；有密钥保持原有范围过滤。
- `/data` 默认 sdk，`?tab=keys` 和 `?tab=exempt` 为其他两个 Tab；旧 agent → `/agents/install`，tables → `/admin?tab=tables`，templates → `/dashboards`。
