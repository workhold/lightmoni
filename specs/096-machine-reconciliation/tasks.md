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
- [x] T013 同步远端 main、运行 typecheck 和相关完整测试，记录验收证据并提交 GitHub PR

依赖：T001→T002→T003/T004→T005/T006→T007/T008/T009→T010/T011→T012→T013。可并行项：核心测试与路由、证书和 Agent 的独立文件；本次按依赖逐步实施。US1 可独立验收清单；US2 验收实际恢复；US3 用新类型合同测试验收。

交付：[GitHub PR #102](https://github.com/workhold/lightmoni/pull/102)，目标 main；已合并到 main（c332d2accf7950095de215a324f14eecbdc48a2d）；未部署生产。相关检查与扩展全量检查限制见 evidence/acceptance.md。

## Phase 6: 授权合并与发行
- [x] T014 合并功能 PR #102，固定主干源码及隔离构建上下文
- [x] T015 构建 arm64/amd64，验证成品和编译后对账集成，记录无凭据证据
- [x] T016 发布 Docker 固定双架构标签、逐平台摘要回拉比对，保持稳定 latest
- [x] T017 发布同源码 GitHub prerelease 与验证JSON/校验文件（Agent完整包已随Docker发布；独立GitHub附件上传另行补齐）
- [ ] T018 更新 Compose 固定标签和验收证据，经发行 PR 合入 main，清理临时验收资源

## Phase 7: 用户追加生产部署与功能修复
- [x] T019 在 1Panel 发布受测固定镜像，回读中心运行状态和源码身份
- [ ] T020 逐项记录应用部署/升级/停止/启动/卸载、主机/执行器、网站/证书、日志/指标/SDK/大盘与任务操作实际结果
- [ ] T021 对复现问题补充规格与必要回归，完成代码修复和所需架构同步，经 PR 合入后重新发布
- [ ] T022 在线复测修复，记录通过、未完成与具体阻塞；按实际验收决定稳定晋升
