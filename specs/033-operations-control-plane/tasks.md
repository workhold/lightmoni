# Tasks: 网站与运维控制平台

## Phase 1 Setup
- [x] T001 完成规格、计划、数据模型、契约、调研与需求质量检查 specs/033-operations-control-plane/。
- [x] T002 runtime/src/ops/types.ts/store.ts/index.ts 统一加密资源、执行/去重、权限、API 与 Agent 私有载荷集成。

## Phase 2 Application foundation / US1
- [x] T003 [US1] runtime/src/ops/workloads.ts 应用、配置文件与目标机器管理、部署历史及资源视图。
- [x] T004 [US1] runtime/src/operations/platform.ts Agent Docker/Compose/挂载执行与现场状态/负载/日志。

## Phase 3 DNS and certificates / US2 US3 US4
- [x] T005 [US2] runtime/src/ops/cloud.ts 阿里/DNSPod 真实签名、分页 CRUD、管理范围与记录所有权。
- [x] T006 [US3] runtime/src/ops/certificates.ts ACME DNS-01 账号/挑战/清理、上传/自签、版本和续期。
- [x] T007 [US4] runtime/src/ops/cloud.ts 三云 CDN 证书上传、部署与回读、云映射与失败状态。
- [x] T008 [US4] runtime/src/operations/platform.ts 证书原子目录分发和更新脚本，固定授权、版本去重、超时与 unknown。

## Phase 4 Hosted services and websites / US5 US6
- [x] T009 [US5] runtime/src/ops/workloads.ts 机器组、资源/端口预留、期望副本、健康发现和发布/停止。
- [x] T010 [US6] runtime/src/ops/workloads.ts OpenResty 系统应用、完整网关配置、静态/反代/服务联动、证书和受管 DNS。
- [x] T011 [US6] runtime/src/operations/platform.ts host OpenResty 分发、检查、切换、访问/TLS 验证和恢复。

## Phase 5 UI / US7
- [x] T012 [US7] web/src/app/OperationsPage.tsx 及子组件五能力表单、凭据/机器池、动作确认、版本、逐目标结果、中英文主题/响应式。
- [x] T013 [US7] runtime/src/ops/index.ts 持续授权检查、周期收敛、状态刷新和有界动作记录；AI 保持仅读/提案。

## Phase 6 Validation and delivery
- [x] T014 runtime/test/platform-*.test.ts 领域协议、SQLite/HTTP/租约、并发资源和失败边界；修复实质问题。
- [x] T015 specs/033-operations-control-plane/validation.md Docker 实际执行、页面真实交互与视觉证据，明确外部服务未验范围。
- [x] T016 docs/system-design.md 与 Doca 同步文字/原生图，最新版本回读并记录结果。
- [x] T017 定向/相关回归、类型与构建、diff 检查，同步 origin/main 并通过 GitHub 功能分支 [PR #15](https://github.com/workhold/lightmoni/pull/15) 交付，未经授权不合并。

## Dependencies
T001→T002；T003/T004 与 T005/T006/T007 可独立并行；T008 共用 Agent 执行器；T009 依赖应用，T010/T011 依赖证书/服务/网关；T012 按固定 API 并行；最终 T014–T017。

## Parallel examples and implementation strategy
云/证书、工作负载/Agent、Web 独立文件并行，由主任务负责共享模型、端点和跨域集成。先使应用和证书独立可用，再接托管与网站；保留真实逐目标验收，无实现占位能力计入完成。
