# Agent deployment contracts

Status: Baseline enrollment contract implemented; rotation and release trust remain design · 2026-10-18

本文将当前可调用契约和未来设计分开。enrollment/activate、节点 control/data 凭据和按节点 revoke 已有中心 API；轮换、重新 enrollment、签名发行、镜像和远程执行仍属于后续能力。

## Existing release and installation contract

| 接口/产物 | 当前行为与边界 |
| --- | --- |
| `npm run release:agent` / `deploy/agent/release.sh` | 构建 Linux amd64/arm64 Agent 包；需先有编译好的 runtime/SDK |
| `lightmoni-agent_<version>_linux_<arch>.tar.gz` | launcher、systemd unit、bundled Node 24.15.0、应用和生产依赖；glibc ≥ 2.28，无全局 npm 依赖 |
| `SHA256SUMS` | tar 包完整性清单，不是签名或可信发行元数据 |
| `install.sh --release-dir DIR --version VERSION` | 从预置目录取固定版本 tar 和 SHA256SUMS |
| `install.sh --release-url URL --version VERSION --key-stdin` | legacy bearer Key 下载；兼容路径仍存在，生产迁移使用 enrollment token |
| `install.sh --release-url URL --version VERSION --enrollment-token-stdin` | enrollment token 下载并兑换 pending 节点；token 通过 stdin/受限文件传递，脚本不把 token 放入 argv |
| `--config FILE` / `--endpoint URL --key-stdin` | 首装提供配置或中心地址与 Key；已有配置优先从已安装文件暂存，再应用指定变更 |
| `--group-id ID` | 兼容参数，初次登记时作为初始任务标签；后续任务归属由中心保存的标签决定 |
| `uninstall.sh` | 默认停止/禁用并删除安装程序，保留配置和数据；`--purge` 才删除配置、身份及缓存数据 |

安装器仅支持 root、Linux、systemd、amd64/arm64 与所需系统命令。暂存 Node/config 检查在替换 live 文件前完成；成功标准目前为 `systemctl is-active`。失败恢复针对先前配置/launcher/unit/current 和服务状态，不覆盖已写 data dir、掉电或 SIGKILL。详见 [事务边界](plan.md#upgrade-and-recovery-boundary)。

## Existing CLI and local HTTP contract

| 调用 | 语义 |
| --- | --- |
| `lightmoni-agent version` | 打印版本信息 |
| `configure --config FILE [--endpoint URL] [--group-id ID] [--key-stdin] [--require-data-dir DIR]` | 校验并原子写配置；Key 从 stdin 读取；不打开 spool 或创建身份 |
| `check --config FILE [--require-data-dir DIR]` | 本地配置校验；不探测网络、中心身份、日志可读性或真实服务 readiness |
| `run --config FILE` | 启动 Agent，SIGINT/SIGTERM 触发受限等待的优雅关闭；不保证退出前 drain 全部离线队列 |
| `status --config FILE` | 通过本地 HTTP 读取 `/status`，使用配置中的 `local_token` |
| `quarantine --config FILE --action list` | 查看隔离数据；此类操作打开 queue，运维按停服务维护方式使用 |
| `quarantine --config FILE --action retry --id ID` | 人工重试隔离批次 |
| `quarantine --config FILE --action discard --id ID --confirm-data-loss` | 显式确认后丢弃隔离数据；不可恢复 |
| `GET /healthz` | 无鉴权，调用队列统计后返回存活响应；不证明中心可达或配置/采集健康 |
| `GET /status` | 本地状态；设置 `local_token` 时需要 bearer |
| `POST /v1/logs`、`/v1/metrics`、`/v1/traces` | 本地 OTLP HTTP 接收；按本地 token 和大小/队列约束校验；无 gRPC 4317 |

`listen` 默认 `127.0.0.1:4318`。非 loopback 必须设置 `local_token`；loopback 可不设置但不能隔离本机用户。当前 Agent 本地服务是 HTTP，未实现本地 TLS。

本地状态包含身份、版本/platform/arch、配置 revision、queue stats、`last_error`、`last_success_at`、collector 状态、SDK 统计及运行事件。`last_success_at` 重启后重新开始记录；Agent 内存事件最多 64 条，未送达中心的事件不是持久审计日志。

## Existing center control and distribution contract

| 路径 | 当前认证及用途 |
| --- | --- |
| `GET /api/v1/agent-install` | 已登录浏览器取安装元数据、有效 endpoint、可用包和下载地址 |
| `GET /downloads/agent/:file` | 活跃上报 Key bearer；下载包、清单、安装/卸载脚本 |
| `POST /api/v1/agents/register` | 活跃上报 Key bearer；注册本地身份和状态 |
| `POST /api/v1/agents/:id/heartbeat` | 同上；更新心跳、已应用 revision、运行诊断 |
| `GET /api/v1/agents/:id/config` | 同上；取得中心合成采集任务配置 |
| `POST /api/v1/agent-enrollments` | 管理员创建短期一次性 enrollment，会话响应只显示完整 token 一次 |
| `GET /api/v1/agent-enrollments` | 管理员查看 enrollment 脱敏状态和绑定节点 |
| `POST /api/v1/agents/enroll` | 安装脚本以 token + install nonce 兑换 pending agent/bootstrap credential |
| `POST /api/v1/agents/:id/activate` | pending Agent 以 bootstrap credential 和健康检查激活，签发 control/data credential |
| `POST /api/v1/agents/:id/credentials/revoke` | 管理员按节点或 audience 撤销 credential |

节点/任务/标签变更由中心已有管理员接口处理；Agent 主动轮询，不是 WebSocket 或中心 push 命令通道。默认 control interval 为 30 秒、单次请求超时 15 秒。配置校验和 `remote-config.json` 原子写入成功后才更新已应用 revision；当前相等 revision 只表示配置装入，不代表每个采集任务或上报已成功。

中心维护的标签决定任务合成；首次初始标签不在后续心跳中覆盖管理员保存的归属。合成冲突按现有模型事务拒绝。缓存无租约、过期或单调发布序列；断网节点可继续旧任务，撤回只能在再次取得配置时生效。

## Credential boundaries

| 凭据/标识 | 当前边界 | 后续设计 |
| --- | --- | --- |
| 管理员会话 | 管理中心任务、标签、Key 等 | 不放入 Agent 配置或安装包 |
| `config.key` | legacy 长期上报 Key，兼用于旧节点下载/控制/上报；有表写入范围，但无强制 agent_id 绑定 | 完成 legacy 收敛；控制凭据绑定节点，上报权限按表范围分离并可轮换 |
| `local_token` | 本地 SDK OTLP、状态和配置代理 | 保持独立；跨 namespace 显式配置与网络限制 |
| `agent_id` / `host_id` | Agent 本地生成持久 UUID | 身份记录不单独构成可信节点证明 |
| `enrollment_token` | 管理员创建的短期一次性 token；中心只存摘要，兑换时绑定 install nonce、版本和架构 | 更完整撤销/审计和签名发行边界 |
| `bootstrap_credential` | pending activation 专用短期凭据；仅用于健康门控 activate | 失败 abort、过期清理和更细 audience/scope |
| `control_credential` | 已激活节点独立控制凭据，用于心跳/配置；中心存摘要并按 agent_id/audience 校验 | 自动/管理员轮换、grace 窗口和配置租约 |
| `data_credential` | 已激活节点独立数据凭据，用于遥测；与 control audience 分离 | 按表范围细化、轮换和重新 enrollment |
| 执行凭据 | 当前不存在 | 独立可选执行器，短时能力授权，不能由采集 Key 派生 |

`runtime_key_id` 记录 Key 归因，不等于节点绑定授权。同一活跃上报 Key 不能被文档描述成已具备每节点撤销、enrollment 或 mTLS。TLS 使用可信 CA，禁止以关闭验证规避配置错误。

## Durable state and failure contract

`/var/lib/lightmoni-agent` 持久保存 `identity.json`、`queue.sqlite`（运行时可能含 WAL）、`remote-config.json` 及相关状态。queue 的 receipt、冻结 payload 和日志 cursor 在同一事务提交后才成功 ACK；重复 ID 内容冲突被拒绝。身份/队列/游标不应跨不同主机克隆。

| 情况 | 当前约定 |
| --- | --- |
| 首次无有效任务配置且中心离线 | 采集、拨测、文件日志等待 tasks ready；本地 OTLP/转发循环独立 |
| 已有有效缓存且中心离线 | 继续缓存任务；中心撤权无离线即时生效保证 |
| 队列满/磁盘不足/SQLite 写失败 | 不成功 ACK；接收返回 503/backpressure，客户端负责重试 |
| 网络失败、401/403、429、502/503/504 | 保留队列并按退避/Retry-After 重试；401/403 至少延迟 30 秒，不清空队列 |
| 超龄、不可重试响应、OTLP partial success | 进入隔离区，不静默删除；隔离仍占容量 |
| 默认卸载 | 保留配置、身份和所有待补传数据 |
| 显式 purge / quarantine discard | 有意数据删除；需要运维确认其影响 |

默认容量为单批 4 MiB、队列 256 MiB、10,000 批、100,000 receipts、最低空闲 32 MiB，最大重放年龄 24 小时、receipt 48 小时。receipt 窗口和冻结重放支持幂等，但不是任意时长、跨所有中心写入阶段的 exactly-once 承诺。

## Lifecycle contract (implemented baseline; hardening remains)

以下区分已实现基线与后续硬化；未实现的状态/操作不能当作当前 API 能力：

1. 引导流程：可信安装包→本地配置验证→使用受限单次凭据请求绑定→中心原子消费并签发节点控制凭据→节点安全落盘→控制配置确认。超时重试必须避免重复兑换或丢失撤销能力；具体协议需另行冻结。
2. 诊断模型：分别报告进程存活、中心控制新鲜度、缓存/预期/已应用配置、每个采集器与队列/投递状态。可显示 waiting、ready、degraded 等视图，但不把它们误当现有响应字段。现有网页 online 仅依 `max(90 秒, 3 × control_interval)` 心跳新鲜度判断。
3. 升级流程：可信版本元数据验证→状态兼容预检/必要一致快照→暂存与切换→可解释健康观察→确认或在兼容条件下恢复。没有当前远程升级 task 或 rollout API 可调用。
4. 容器分发：独立 Agent 镜像、固定 digest、非 root、可写持久卷和受限日志/network 配置；宿主采集需独立能力契约。当前没有可作为已发布产物引用的 Agent 镜像。
5. 智能执行：独立 executor、默认关闭、明确目标/能力/TTL/审批/取消/审计和隔离。采集任务 schema 继续拒绝 shell/脚本扩展，除非有新的独立规格和授权模型。

## Scripted enrollment and node credentials (implemented baseline; hardening remains)

以下契约描述已实现的 enrollment/activate 基线及后续扩展。旧节点仍可走 `config.key` 兼容路径；轮换、abort、重新 enrollment 和完整审计尚未发布。

### Installer invocation

推荐 UI 生成不含秘密参数的命令（示例）：

```sh
curl --fail --proto '=https' --tlsv1.2 -o /tmp/lightmoni-agent-install.sh \
  https://monitor.example.com/downloads/agent/install.sh
chmod 700 /tmp/lightmoni-agent-install.sh
sudo sh -c 'exec /tmp/lightmoni-agent-install.sh \
  --endpoint https://monitor.example.com \
  --version 0.1.0 --arch auto --enrollment-token-stdin \
  < /run/secrets/lightmoni-agent-enrollment-token'
rm -f /tmp/lightmoni-agent-install.sh
```

交互式模式在 root shell 中隐藏读取 token；自动化模式通过 0600 文件或受限 FD。脚本不得接受 token URL、普通 argv 或默认环境变量；不得在日志、`ps`、shell history、systemd journal、审计或错误文本中输出 token。生产安装应先下载、校验固定脚本/发行包，再执行，而不是直接 `curl | sh`。

### Enrollment records and states

| 记录/状态 | 必填字段与规则 |
| --- | --- |
| `enrollment_session` | `id`、中心/租户、创建者、允许 arch/version、初始标签、scope、`token_digest`、`expires_at`、`used_at`、状态；token 只能消费一次，重复请求需匹配原 `install_nonce` |
| `pending_agent` | `agent_id`、`install_nonce`、主机公钥/指纹、版本/架构、bootstrap credential 摘要、`pending_expires_at`；仅允许 activate/abort |
| `agent_credential` | `credential_id`、`agent_id`、audience、scope、摘要、created/last_used/expires/revoked/grace 时间、撤销原因；中心不存明文 secret |
| `agent` | `id`、状态、最近心跳、控制/数据 credential 状态、期望标签和配置 revision；状态变更写审计 |

状态迁移：`issued → redeeming → pending_activation → active`；失败分支为 `expired`、`revoked` 或 `failed`。`active` 节点再经过 `degraded`、`revoked`、`re-enrolling`，不得直接由客户端改回 `active`。

### Request/response shapes

```ts
// POST /api/v1/agent-enrollments (admin)
type CreateEnrollment = {
  endpoint_origin: string;
  allowed_arch: ("amd64" | "arm64")[];
  version: string;
  initial_label_id?: string;
  scopes: ("agent.control" | "agent.data")[];
  expires_in_seconds?: number; // server clamps to a short maximum
};
type EnrollmentCreated = {
  enrollment_id: string;
  token_display_once: string;
  token_expires_at: string;
  install_command_hint: string; // never includes token
};

// POST /api/v1/agents/enroll (installer; TLS)
type EnrollRequest = {
  enrollment_token: string; // stdin only at CLI boundary
  install_nonce: string;
  agent_public_key: string;
  version: string;
  arch: "amd64" | "arm64";
  host_metadata?: { hostname?: string; os?: string };
};
type EnrollPending = {
  enrollment_id: string;
  agent_id: string;
  bootstrap_credential: string; // returned once, pending-only scope
  pending_expires_at: string;
};

// POST /api/v1/agents/:id/activate (pending Agent)
type ActivateRequest = { install_nonce: string; health: { service: "ready"; config_checked: true } };
type Activated = {
  agent_id: string;
  control_credential: string; // returned once
  data_credential: string; // returned once
  credential_expires_at: string;
};
```

The server authenticates all post-enrollment requests by bearer credential plus audience/scope and `agent_id` binding; a body field alone is never authorization. Enrollment uses the `install_nonce` for pending replay protection; repeating the same nonce while pending returns the same pending record, while a different nonce is rejected. Activate currently consumes the bootstrap once and does not yet expose a lost-response status/retry operation; rotation idempotency is future work. After activation no endpoint returns a second copy of full secrets.

### Credential operations

| Operation | Expected result |
| --- | --- |
| Agent automatic rotation | Old control credential authenticates a unique `rotation_nonce`; new secret is written to a 0600 temporary file, fsync/atomic rename, then confirm. Old credential remains valid only during bounded grace (suggested ≤10 min). |
| Admin rotation | Admin starts a rotation session from the node page; UI receives IDs/timestamps only. Agent completes exchange; old secret is invalid after confirm/grace. |
| Node revoke | Admin transaction marks all or selected audience credentials revoked, writes reason/actor audit, and rejects new control/data requests. Identity and queue remain for diagnostics/re-enrollment. |
| Re-enroll | Admin issues a new one-time enrollment for the same node after verifying host; old credentials remain revoked and old enrollment cannot be replayed. |
| Install rollback | Before `active`, abort/expiry revokes bootstrap and removes temporary files. Existing node upgrade never enrolls again and never deletes identity/queue. |

The service must expose only redacted credential metadata (`credential_id`, prefix/last4 if needed, status, expiry, last used), and must never put token material in audit payloads or diagnostic exports. Revocation does not promise immediate offline task termination; until a configuration lease exists, the UI reports that the node will stop control/data access after reconnect while cached tasks may continue locally.

#### Compatibility migration for the current `config.key`

The existing key is a temporary compatibility path because it currently authenticates download, register, heartbeat, configuration, relay and upstream OTLP requests. An implementation must not add a new token field while continuing to authorize control routes from that key. Migrate in this order: (1) accept and audit node-bound `control_credential` on register/heartbeat/config/status, (2) accept node-scoped `data_credential` only on telemetry routes, (3) keep `config.key` behind an explicit legacy flag and warning for already-installed nodes, with no arbitrary `agent_id` enrollment, (4) revoke the legacy key after all nodes are re-enrolled. Package distribution should use a pre-positioned signed artifact or a separately scoped release credential; an enrollment token must not silently become package-download or administrator authorization.

## Sources

[安装器](../../deploy/agent/install.sh) · [CLI](../../runtime/src/agent/main.ts) · [本地配置](../../runtime/src/agent/config.ts) · [Agent](../../runtime/src/agent/agent.ts) · [队列](../../runtime/src/agent/queue.ts) · [节点 API](../../runtime/src/server/nodes.ts) · [节点模型](../../runtime/src/server/nodes-model.ts) · [包下载](../../runtime/src/server/install.ts) · [部署指南](../../docs/agent-deployment.md)
