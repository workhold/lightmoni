# Tasks: 集群与应用统一部署

## Phase 1 Specification and design
- [x] T001 规格、需求质量检查、research/data-model/contracts及实现计划。
- [x] T002 Doca轻量告警系统知识库保存完整方案并回读。

## Phase 2 Core implementation
- [x] T003 runtime/src/ops/types.ts,store.ts：cluster类型、稳定成员唯一、serviceName不可变/全局唯一及应用展示名可重复。
- [x] T004 runtime/src/ops/workloads.ts：统一manual/managed应用、多端口预留/发现/故障处理、OpenResty单例与网站同组bindings。
- [x] T005 runtime/src/ops/catalog.ts,index.ts：商店模板与安装、机器目录、集群筛选及端点API。
- [x] T006 runtime/test/platform-*.test.ts：核心边界/失败/HTTP与租约回归。
- [x] T007 [P] web/src/app/OperationsPage.tsx,ops/*,App.tsx,navigation.ts：集群/应用/网站、商店、独立证书/域名与快捷创建，复用现有视觉。
- [x] T008 [P] examples/cluster-demo/*：自定义Web源码/Dockerfile、真实MySQL与网站演示脚本及可复现运行说明。

## Phase 3 Integration and delivery
- [x] T009 真实Linux Agent/Docker/HTTP部署并演示数据库读写、多端口/TLS、Web重建数据保留，记录证据。
- [x] T010 UI实际入口/保存刷新/失败/窄屏/200%及动效取证，主Agent连续三轮验证并独立视觉评审。
- [x] T011 docs/system-design.md及Doca基线同步，原生图/文字保存后回读记录。
- [ ] T012 相关回归、类型与构建、diff检查、同步origin/main、GitHub功能分支PR，不合并。

T001–T002先于功能代码；T003–T006与T007按共享契约并行，T008独立；T009依赖集成完成。Spec Kit要求并行任务按文件独立分工；Oil UI要求隔离视觉评审。

## 2026-10-30用户确认的跨集群修订（先于继续代码）
- [x] T013 更新spec/data-model/contracts/plan/research，锁定全局应用与公共网站配置。
- [x] T014 更新Doca方案并回读正文与原生图。
- [x] T015 应用deployments持久化、cluster实例/发布/发现隔离，OpenResty托管固定端口与DNS聚合。
- [x] T016 应用安装逐集群实例大小表单、全局列表及网站公共配置/逐集群上游、不可绑定不存在服务。
- [x] T017 更新Demo与新契约、实际链路回归、跨集群和DNS聚合/调度验收。

## 完成证据

Runtime/AI/SDK回归、真实Docker与数据库故障链路、最终UI连续三轮、独立视觉评审及Doca双端回读见 [validation.md](validation.md)。T004最终实现位于cluster-workloads.ts，workloads.ts只保留旧模型历史路径。T010补齐网站重新编辑读回及退役实例过滤；截图等待有限过渡结束。
