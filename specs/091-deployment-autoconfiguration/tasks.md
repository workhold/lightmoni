# Tasks: 自动部署与统一入口

## Phase 1: Setup
- [x] T001 建立功能分支与规格，`specs/091-deployment-autoconfiguration/spec.md`。
- [x] T002 完成研究、设计、契约与验收计划，`specs/091-deployment-autoconfiguration/plan.md`、`contracts/README.md`。

## Phase 2: US1 发布互斥
独立验收：受管顺序排队可执行，未核对未知与普通提权仍阻塞。
- [x] T003 [US1] 修复受管入队互斥，`runtime/src/server/agent-jobs.ts`、`privileged-execution-guard.ts`。
- [x] T004 [US1] 增加真实签名/互斥回归，`runtime/test/managed-executor-jobs.test.ts`。

## Phase 3: US2 自动入口与 CNAME
独立验收：不手填入口名、网站无IP模式、DNS错误可定位。
- [x] T005 [US2] 自动稳定入口域名、仅CNAME与默认线路修复，`runtime/src/ops/cluster-workloads.ts`、`cloud.ts`。
- [x] T006 [US2] 入口/网站表单与真实DNS状态，`web/src/app/ops/ClusterFields.tsx`、`WebsiteFields.tsx`、`WebsiteEntriesDrawer.tsx`、`website-state.ts`。
- [x] T007 [US2] 入口与DNS契约回归，`runtime/test/platform-clusters.test.ts`、`platform-website-routing.test.ts`。

## Phase 4: US3 快速安装
独立验收：只填域名和必要业务参数可完成安装；重试不重复资源。
- [x] T008 [US3] 服务端选址、域名区域匹配、持久安装编排与重试，`runtime/src/ops/quick-install.ts`、`index.ts`、`catalog.ts`。
- [x] T009 [US3] 域名主表单、高级覆盖与阶段，`web/src/app/ops/CatalogInstallFields.tsx`、`CatalogDrawer.tsx`、`ApplicationInstallDrawer.tsx`。
- [x] T010 [US3] 快速安装契约/失败重试与UI证据，`runtime/test/platform-clusters.test.ts`、`specs/091-deployment-autoconfiguration/evidence/`。

## Phase 5: US4 单端口仓库
独立验收：一个宿主端口，仅一个可写仓库、一份数据和5000端口。
- [x] T011 [US4] 统一单一仓库与5000端口，`runtime/src/ops/registry-runtime.ts`、`private-registry.ts`。
- [x] T012 [US4] 仓库表单与单实例回归，`web/src/app/PrivateRegistryPage.tsx`、`runtime/test/platform-clusters.test.ts`、`platform-registry-auth.test.ts`。

## Phase 6: US5 SDK部署环境
独立验收：载荷正确、环境回退与显式覆盖、公开响应无秘密。
- [x] T013 [US5] 部署SDK Key引用与逐实例环境注入，`runtime/src/ops/application-telemetry.ts`、`cluster-workloads.ts`。
- [x] T014 [US5] 八种后端SDK环境默认、测试和文档，`sdk/`、`sdk/README.md`。

## Phase 7: Cross-cutting
- [x] T015 相关类型检查、回归及实际UI验收，`specs/091-deployment-autoconfiguration/validation.md`。
- [x] T016 同步 `docs/system-design.md` 与Doca并回读原生文本/图块，记录 `specs/091-deployment-autoconfiguration/evidence/doca-readback.json`。
- [x] T017 同步远端main，审阅最终差异与秘密边界，功能分支提交并创建GitHub PR，记录 `specs/091-deployment-autoconfiguration/validation.md`。

- [x] T018 用户追加：固定 main 源码打包双架构、成品验证、GitHub/Docker 发版、生产备份更新和实际功能复测，记录 `validation.md` 与安全证据。

## Dependencies / Implementation Strategy
T001→T002→US1→US2→US3；US4与US5使用独立文件可交错，但不并行编辑共享文件；最终检查和架构同步全部完成后交付。研究按speckit-plan委派只读代理；代码由主执行者完成。优先验证发布最小增量，再逐场景验证，先通过功能 PR 合入后按追加授权发版部署。

- [x] T019 [US2] 修复线上旧默认权重日志触发多余SLB接口的兼容问题；真实供应商回读后同步所有权权重元数据，补充回归和复测。

- [x] T020 接续现场验收：保留未知执行历史，凭主机 journal、systemd 执行单元和容器现场记录核对；从合并 #83/#91 的 main 统一发行，验证现有应用、DBX DNS、域名快装与 SDK 实际上报，并提交可复核证据。

- [x] T021 处理现场单主机入口的重复原地重建：通过既有受管停止、配置保存、启动流程切换为固定主机模式；重新验证入口、网站、DNS与连续状态，保留切换前未通过的稳定性样本。
