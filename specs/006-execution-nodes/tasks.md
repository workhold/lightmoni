# Tasks

## Setup and foundation

- [x] T001 建立specs/006-execution-nodes/spec.md、plan.md、contracts.md及规格质量检查。
- [x] T002 建立internal/server任务标签、任务及关联存储和幂等迁移。

## US1 名称与接入

- [x] T003 [P] [US1] 同步web/src/app/App.tsx、CorePages.tsx、DataPage.tsx、AgentInstall.tsx、SDKSetup.tsx及空态术语。
- [x] T004 [P] [US1] 更新README.md、docs/ui-design.md及接入文档术语。

## US2 任务标签分发

- [x] T005 [US2] 实现internal/server任务编译、CRUD、节点多标签分配与权限校验。
- [x] T006 [P] [US2] 重整web/src/app/AgentsPage.tsx、AgentTaskEditor.tsx、agent-model.ts为节点/任务/标签三页签。
- [x] T007 [US2] 实现internal/server集成与冲突、撤除、去重、权限测试。

## US3 已有部署

- [x] T008 [US3] 验证internal/server旧组迁移、重复启动不复活、注册/重连及旧轮询兼容。

## Validation

- [x] T009 [P] 新增web/src/app执行节点隔离浏览器验收并检查1440/390px布局。
- [x] T010 运行类型检查、针对性race、生产构建与8080重启，将证据记录specs/006-execution-nodes/validation.md。
- [x] T011 按部署定位修正规格、README及接入示例：Agent 独立运行，生命周期独立于业务，更新同一 PR 描述。

## Dependencies and strategy

T001→T002→T005→T007/T008；T003/T004可并行；T006等待API冻结，可与后端实现并行；T009依赖页面与API；T010最后串行构建。先确保迁移与兼容，再实现真实多标签下发和前端。
