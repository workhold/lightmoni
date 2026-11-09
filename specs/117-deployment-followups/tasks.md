# Tasks: 部署问题清单闭环

## Phase 1: Setup

- [x] T001 通过MCP全文读取并在specs/117-deployment-followups/spec.md记录全部待办。
- [x] T002 在独立工作树同步origin/main，完成plan.md、research.md、data-model.md、contracts和quickstart。
- [x] T003 安装锁定依赖并检查.gitignore/.dockerignore，不修改用户原工作区。

## Phase 2: Foundation

- [x] T004 核对已有功能与权限边界，在specs/117-deployment-followups/research.md记录实施决策。

## Phase 3: US1 遥测与主机监控

- [x] T005 [P] [US1] 在sdk各后端入口补hostname默认与覆盖，规范runtime/src/server/catalog.ts指标命名契约并回归。
- [x] T006 [US1] 在runtime/src/agent/agent.ts及collect.ts补容量并在web/src/app/MachinesPage.tsx展示。
- [x] T007 [US1] 在runtime/src/domains/dashboards.ts和web/src/app新增主机/系统监控入口，保留用户自定义大盘与删除意图。
- [x] T008 [US1] 复测web/src/features/logs及dashboards现有性能/Grafana检查，记录实际问题与修正。

## Phase 4: US2 容器与镜像读取

- [x] T009 [P] [US2] 在runtime/src/shared/host-docker.ts、ops/host-docker.ts、privileged-executor/host-docker.ts补有界批量删除/停止容器清理。
- [x] T010 [US2] 在web/src/app/HostContainersDialog.tsx及HostContainerManagement.tsx补多选、审阅、逐项结果与缓存刷新。
- [x] T011 [US2] 在runtime/src/operations/registry-images.ts补清单有界并发去重，检查保留关系与顺序。

## Phase 5: US3 文件与高亮

- [x] T012 [P] [US3] 在runtime/src/server/machine-files.ts补排他创建、目录、rename、remove、chmod及版本回读和审计。
- [x] T013 [US3] 在web/src/app/HostFilesDialog.tsx补对应操作、确认、失败保留输入。
- [x] T014 [US3] 在web/src/shared新增本地代码编辑器，替换HostFilesDialog及app/ops/ResourceFields.tsx的配置文本区。

## Phase 6: US4 商店与外部编排

- [x] T015 [P] [US4] 在runtime/src/ops/catalog及web/src/app/ops/CatalogDrawer.tsx补真实资料链接与只读配置预览。
- [x] T016 [US4] 在web/src/app及runtime/src/operations/containers.ts补外部Compose发现、审阅、接管入口及支持限制。

## Phase 7: US5 备份与迁移

- [x] T017 [P] [US5] 修复runtime/src/server/operation-schedules.ts及managed-executor-jobs.ts计划来源授权，覆盖派发/领取/开始吊销。
- [x] T018 [US5] 在scripts及runtime备份路径实现完整应用多挂载/配置归档、校验、下载与S3定时云备份。
- [x] T019 [US5] 在scripts及docs实现Moni整体离线导出/导入/校验与恢复步骤，保留原部署，拒绝非空目标。

## Phase 8: Integration

- [x] T020 在specs/117-deployment-followups/evidence记录相关运行时/SDK/浏览器/可丢弃资源验收，逐条映射问题表。
- [x] T021 更新docs/system-design.md与Doca对应原生章节，保留无关块，回读并核对节点连线。
- [x] T022 同步origin/main、相关检查与diff检查，提交GitHub功能PR并记录链接，不合并或部署。

## Dependencies and parallel execution

T001—T004先完成；US1、US2、US3可并行，但同文件修改串行。US4依赖US2的主机容器上下文；US5独立复用现有操作授权。T020—T022最后集成。示例：遥测/SDK、文件/SFTP、容器/商店分别推进；调度和备份由主代理集成。每故事独立核对实际结果；已有能力通过验收而非重新实现。

交付：[GitHub PR #160](https://github.com/workhold/lightmoni/pull/160)，目标main；未合并或部署。
