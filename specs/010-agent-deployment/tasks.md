# Agent deployment tasks

Status: Baseline implementation delivered; hardening and Linux acceptance remain · 2026-10-18

本规格的 enrollment/activate 基线、脚本接入和节点 control/data 凭据已实现并有运行时测试；签名发行、凭据轮换/重新 enrollment、配置租约、容器方案及真实 Linux 双架构验收仍未完成。勾选项只表示当前代码已具备对应基线，不代表生产安全验收全部通过。

## Design deliverables

- [x] T001 梳理现有 bundled Node 双架构发行、systemd 安装、持久队列、控制配置、下载和容器边界。
- [x] T002 编写用户场景、要求和验收范围：[spec.md](spec.md)。
- [x] T003 编写独立部署、权限/目录、网络、升级事务和容器决策：[plan.md](plan.md)。
- [x] T004 区分已实现 CLI/API/凭据与后续契约：[contracts.md](contracts.md)。
- [x] T005 提供基于当前实现的运维指南：[agent-deployment.md](../../docs/agent-deployment.md)。

## P1 Installation and identity

- [x] T006 加固网页安装命令、下载鉴权与 stdin/FD 传递，避免 enrollment token 进入 shell history、curl argv、sudo/audit 和诊断输出；验证已有配置升级兼容。现有 legacy `--key-stdin` 兼容下载路径仍保留，完整迁移见 T035。
- [x] T007 定义并实现单次短期引导凭据及节点绑定控制/数据凭据，冻结兑换、同 nonce 去重和管理员撤销事务；保持旧上报 Key 兼容路径可解释。凭据轮换与重新 enrollment 仍见 T008/T032/T035，丢失首次 bootstrap 响应后的安装器恢复待补充。
- [ ] T008 分离控制与数据权限、按节点轮换/撤销，明确离线配置撤权和凭据失效策略，防止任意 agent_id 复用同一控制权限。
- [ ] T009 实现可信发行元数据/签名、信任根与轮换、固定版本和离线验证；补充包+清单同源替换和过期/降级测试。
- [ ] T010 复核专用用户、配置目录可写性、日志 ACL、PrivateTmp、数据目录与 unit 限制，提供最小权限检查和诊断。

## P1 Health and upgrade

- [ ] T011 实现分层健康/诊断：存活、控制新鲜度、缓存配置、已应用 revision、采集器和队列/交付；避免把无业务流量判为失败。
- [ ] T012 为远程任务定义缓存租约/撤回语义与必要发布序列；验证离线撤权、重放旧配置、非法配置和断电写入。
- [ ] T013 冻结跨版本 queue/schema/identity/cursor 兼容策略、一致快照和恢复契约；不可逆迁移不可套用仅文件回退。
- [ ] T014 实现带观察窗的升级健康门槛，在兼容/快照条件成立时回退；覆盖普通失败、恢复失败、掉电/SIGKILL 中断恢复。
- [ ] T015 设计发行保留/清理、失败留证和人工恢复流程；之后再实现单节点 canary 与分批 rollout，不能影响已 ACK 数据。
- [ ] T016 增加可控诊断导出、容量/隔离告警和离线缓存说明，验证秘密脱敏及事件持久性边界。

## P1 Linux acceptance

- [ ] T017 在真实 Linux amd64、arm64，glibc≥2.28 上安装和开机启动 bundled Node 发行包；不依赖目标全局 Node/npm，不以 shell shim 代替。
- [ ] T018 验证非 root 服务、文件 ACL/轮转/截断、PrivateTmp、业务启停独立、身份不变和默认卸载保留。
- [ ] T019 验证中心断网/重启、DNS/TLS、401/403 与 Key 轮换、长期离线、满队列/磁盘不足/隔离及恢复，不产生成功 ACK 后数据静默丢失。
- [ ] T020 在非空队列、receipt、日志游标和缓存任务下做版本升级/失败恢复，验证实际数据和身份；测试支持的旧格式路径与不兼容时明确拒绝。
- [ ] T021 记录双架构实机命令、版本、数据断言和日志证据，补齐迁移验收缺口后再声明生产验证完成。

## P2 Container relay and logs

- [ ] T022 新增并发布独立 Agent 镜像和 digest；非 root、只读根目录、独立持久状态及受限 secret 配置，明确与中心镜像差异。
- [ ] T023 提供转发/明确日志挂载部署示例和 networking 决策；验证 app→Agent 的 token、监听、DNS/gateway/host 网络及防火墙。
- [ ] T024 验证容器启停/升级的持久身份与队列，避免绑定业务容器删除；不默认要求 privileged 或 Docker socket。
- [ ] T025 为容器宿主采集单独定义路径前缀/namespace/权限能力并做主机数据对照；未通过前仅承诺容器视图或转发能力。

## Future execution boundary

- [ ] T026 在另一个规格中设计可选独立执行器：默认关闭、独立凭据、短时能力、审批、沙箱、取消与审计；禁止复用采集 Key/标签作为执行授权。

依赖：T006–T010 为安全接入基础；T011/T013 先于 T014/T015；T017–T021 为主机可发布门槛；T022–T025 在主机方案之后独立验收；T026 不属于采集部署实现。

## Script enrollment and per-node credentials (design follow-up)

- [x] T027 明确用户从“节点助手”生成一次性安装会话、脚本通过 stdin/FD 传递秘密、状态轮询和失败回滚流程。
- [x] T028 冻结 enrollment、pending activation、active/revoked/re-enrolling 状态及 `agent_id` 绑定、nonce 幂等和不回显秘密的原则；当前公钥字段仅作元数据，未实现持有证明。
- [x] T029 设计控制/数据/local token 分离、中心摘要存储、自动/管理员轮换、grace 窗口、单节点撤销和重新 enrollment 语义。
- [x] T030 列出 enrollment、activate、abort、rotate、revoke、re-enroll API 及请求/响应边界；enrollment、activate、按节点 revoke 已实现，abort/rotate/re-enroll 仍为后续契约。
- [x] T031 实现脚本部署 UI/下载安全、短期 enrollment token 和 pending 激活事务；已覆盖 token 不进安装命令、API 同 nonce 去重和不同 nonce 重放拒绝的运行时测试。丢失首次 bootstrap 响应后的安装器恢复、泄露审计及丢包/断电测试仍需补齐。
- [ ] T032 实现每节点 control/data credential 签发、摘要存储、绑定验证、轮换/撤销/重新 enrollment API；补充原子落盘、断电和 grace 窗口测试。
- [ ] T033 为节点安装、激活、撤销、轮换和离线恢复增加审计/权限 UI；验证诊断和日志无秘密泄露。
- [ ] T034 冻结并实现配置租约和离线撤销边界，确认撤销后缓存任务的最长执行时间，再进行生产安全验收。
- [ ] T035 分阶段迁移现有 `config.key` 控制路由：先接入节点绑定 control/data credential，再限制 legacy Key 权限并禁止任意 `agent_id`，最后完成旧节点 re-enroll 和撤销旧 Key。
