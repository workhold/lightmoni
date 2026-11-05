# Tasks

## Phase 1: Setup
- [x] T001 保存 SDD 规格、研究、设计、数据和契约到 specs/096-machine-reconciliation/

## Phase 2: Foundation
- [x] T002 实现共享规范化摘要 runtime/src/shared/desired-state.ts 和持久注册调度 runtime/src/reconciliation/registry.ts
- [x] T003 在 runtime/test/reconciliation.test.ts 验证原子快照、恢复、代次、依赖、删除、退避和加密

## Phase 3: US1 单机清单
- [x] T004 [US1] 在 runtime/src/reconciliation/index.ts 提供管理员清单/触发接口并接入 runtime/src/server/app.ts
- [x] T005 [US1] runtime/src/ops/cluster-workloads.ts 注册具体部署配置期望含域名/端口/静态文件
- [x] T006 [US1] runtime/src/reconciliation/certificate-files.ts 注册按机器的目录证书文件期望，并接入 runtime/src/ops/certificates.ts

## Phase 4: US2 自动恢复
- [x] T007 [US2] runtime/src/ops/cluster-workloads.ts 与 runtime/src/operations/platform.ts 加实际配置核验及部署漂移修复
- [x] T008 [US2] runtime/src/operations/platform.ts 与 runtime/src/ops/certificates.ts 支持证书周期核验、已知失败恢复和受管损坏安全修复
- [x] T009 [US2] runtime/src/reconciliation/agent-config.ts、runtime/src/server/nodes.ts、runtime/src/agent/agent.ts 支持内存/磁盘实际摘要和同版本修复
- [x] T010 [US2] 在 runtime/test/reconciliation.test.ts 与现有 Agent/平台测试加入真实集成覆盖

## Phase 5: US3 扩展与交付
- [x] T011 [US3] contracts/README.md 记录新 provider 注册示例和范围、未知类型/依赖行为
- [x] T012 同步 docs/system-design.md 和 Doca 原生章节/图并回读，记录 specs/096-machine-reconciliation/evidence/
- [ ] T013 同步远端 main、运行 typecheck 和相关完整测试，记录验收证据并提交 GitHub PR

依赖：T001→T002→T003/T004→T005/T006→T007/T008/T009→T010/T011→T012→T013。可并行项：核心测试与路由、证书和 Agent 的独立文件；本次按依赖逐步实施。US1 可独立验收清单；US2 验收实际恢复；US3 用新类型合同测试验收。
