# Implementation Plan: 网站与运维控制平台

Branch: codex/033-operations-control-plane. Date: 2026-10-29. Spec: [spec.md](spec.md).

## Summary
将网站与运维改为一个全局控制平台。DNS、证书和应用不绑定节点；部署、实例、网关与证书目标绑定节点或云目标。复用现有 Node/TypeScript 中心、SQLite 加密、React/Ant Design、Agent pull jobs/control lease 和监控。用户已明确不要求旧模型兼容。

## Technical Context
Language: TypeScript / Node >=22.19. Storage: SQLite 管理状态、加密配置与执行，持久文件目录放版本化制品。Frontend: React 19 + Ant Design。Linux Docker Engine / Compose plugin；OpenResty 通过固定镜像 host 部署。DNS/云请求通过官方 HTTPS API 签名；ACME 使用固定版本成熟库并复用两 DNS 适配器。

## Constitution Check
Host 鉴权与秘密边界保留；用户明确授权管理员配置证书脚本，新增受控平台执行类型，绝不让 AI 批准。配置保存不执行；人工执行检查 revision 与确认，持续任务由管理员启用策略授权。真实结果、unknown、脱敏和有界输出必须保留。架构需仓库/Doca 双端写入回读。

## Project Structure
- runtime/src/ops/types.ts, store.ts, index.ts: 全局资源、加密执行/去重、API、Agent 私有 payload、模块装配。
- runtime/src/ops/cloud.ts, certificates.ts: DNS 双平台、ACME、自签/上传、三云 CDN、证书目标与续期。
- runtime/src/ops/workloads.ts: 应用、机器池、实例/端口/资源预留、服务调度、网站网关编译与分发。
- runtime/src/operations/platform.ts: Agent Docker、配置文件、网关、证书目录和脚本执行。
- web/src/app/OperationsPage.tsx 及 ops 子组件: 五能力、共享凭据/机器池、表单和逐目标结果。

## Shared Internal Contract
Resource kinds: credential, dns_zone, acme_account, certificate, certificate_target, application, service, node_pool, gateway_group, website.
Resource: id/kind/name/revision/spec/status/created_at/updated_at/created_by；spec 加密，publicSpec 只返回可编辑非秘密数据及 has_* 元数据。
PlatformStore: register(kind,definition), get(id,kind?), list(kind?), public(resource), create(kind,name,spec,actor), update(id,revision,name,spec,actor), patchStatus(id,status), remove(id,revision), queue(resource,agentID,action,config,actor,idempotencyKey?), run(resource,action,actor,work,idempotencyKey?,input?), actions(resourceID?), subscribe(listener)。run 固化加密 resource_snapshot 与动态 input。
Definition: validate(spec,previous?) 和可选 publicSpec(spec)。DomainController: actions(resource), perform(resource,action,input,actor), tick?(), close?()。控制器可另向 router 注册精确领域端点。
Agent config task: node.inspect / workload.apply / workload.inspect / workload.stop / workload.remove / workload.logs / gateway.apply / gateway.inspect / gateway.stop / certificate.install / certificate.inspect / hook.run / hook.inspect。payload 统一 version=1、operation_id，resource.kind=platform、resource.agent_id、resource.config；operation 为 apply/inspect/stop/remove/logs/install/run，input={}。config 顶层 task 决定 typed schema。queue 的 config 是完整固化载荷，普通 job 仅含 ID。结果 data 带 task 与实际观察，不回传文件正文、PEM 或脚本输出。
API: /api/v1/ops/resources CRUD、resources/:id/actions、runs、overview；写动作 body 带 revision、confirmed=true、input。保存 enabled/auto_renew 及策略意味着管理员持续授权，保存记录 authorized_by；每次自动执行重查管理员权限。

## Design Decisions
网站扩展使用共享 runtime/src/operations/nginx.ts 验证与编译普通站点配置，中心保存结构化 nginx/locations，Agent再次验证后生成完整版本包。每路径可直接后端或引用托管服务，服务端点在组包时解析；无健康端点只影响对应路径。自定义片段只在server/location上下文，词法扫描拒绝逃逸/include/动态代码等越界指令，仍由nginx -t最终验证。中心preview仅返回占位证书路径和公共配置，不含PEM/密钥/运行环境。现有Agent租约、完整包检查/切换/验证/恢复保持不变。
中心每轮有界 reconciliation，持久队列和唯一键去重；多副本资源/端口在 SQLite transaction 预留，节点仍须现场检查。使用机器可达 IP+发布端口作发现；节点陈旧排除调度和发现，但 unknown 不释放资源、不静默迁移本地数据。网关默认覆盖组内全部节点，按各节点完整版本包执行 nginx -t/切换/reload/实际验证。DNS 只管理具有平台记录 ID 和归属的记录。云证书以上传/部署/回读多阶段确认；脚本按目标+证书版本去重，未知不自动重放。

## Delivery and Validation
领域协议/调度/执行器测试→SQLite/HTTP/Agent lease 集成→Docker 隔离实测→页面真实入口/刷新/失败/窄屏→仓库/Doca 文本和原生图回读→同步 origin/main、GitHub PR。真实云与 ACME 公网验证依赖运行时凭据，不能以夹具代替；报告未验范围。

## Parallel Work
按 speckit-plan 研究完成后并行独立文件：云与证书控制器；工作负载/Agent 执行器；界面。主任务负责共享模型、API/租约集成、跨域收敛、文档与最终验证。共享文件变更由主任务协调。
