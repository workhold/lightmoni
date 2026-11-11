# Tasks: Agent 首装残留与恢复闭环

## Phase 1: Setup
- [x] T001 从最新 main 建隔离分支，记录 SDD、根因和架构评估于 specs/122-agent-install-recovery/plan.md。

## Phase 2: Foundation
- [x] T002 校验现有忽略规则、依赖与 fixture 能力，路径 .gitignore、runtime/test/helpers/maintenance-shell.ts。

## Phase 3: US1 预检阻止残留 (P1)
Independent test: 两个目录的空目录/文件/悬空链接均阻止 fresh，未下载或交换身份。
- [x] T003 [US1] 扩展残留矩阵于 runtime/test/machine-ssh.test.ts 与 runtime/test/install-release.test.ts。
- [x] T004 [US1] 补齐共享足迹和 standalone fresh 路径于 runtime/src/shared/agent-maintenance-shell.ts 与 deploy/agent/install.sh。

## Phase 4: US2 安全显式清理 (P1)
Independent test: 安全残留清除且业务数据不变；不安全路径、证据变化拒绝。
- [x] T005 [US2] 添加真实 shell 清理、隐藏文件、链接/权限/类型与快照变化回归于 runtime/test/machine-agent-lifecycle.test.ts、runtime/test/agent-uninstall-script.test.ts。
- [x] T006 [US2] 实现固定覆盖目录的共享安全校验/有界摘要/清理并同步 deploy/agent/uninstall.sh，源 runtime/src/shared/agent-maintenance-shell.ts。
- [x] T007 [US2] 接入观测、计划摘要和清理于 runtime/src/server/machine-agent-lifecycle.ts。

## Phase 5: US3 诊断与恢复 (P2)
Independent test: 错误码明确且无原始日志；核对失败读回后可继续，读回失败或切换目标安全隔离。
- [x] T008 [US3] 对齐现有 agents heartbeat fixture，并添加诊断及恢复交互回归于 runtime/test/managed-machines.test.ts、runtime/test/machine-installation-recovery-races.test.ts、runtime/test/machine-installation-recovery.test.ts 与 scripts/test-agent-install-recovery-ui.mjs。
- [x] T009 [US3] 扩展固定错误原因及中文解释于 runtime/src/server/machine-ssh.ts、runtime/src/server/managed-machines.ts。
- [x] T010 [US3] 为恢复请求失败增加同一原记录读回于 web/src/app/MachinesPage.tsx。

## Phase 6: Verification and delivery
- [x] T011 运行相关回归、类型检查、构建并记录 specs/122-agent-install-recovery/evidence/validation.md。
- [x] T012 同步远端 main、复核 diff 并通过 GitHub 功能分支提交 PR，验证记录写入 specs/122-agent-install-recovery/evidence/validation.md。

## Dependencies and parallel opportunities

T001 → T002 → US1 → US2 → US3 → T011 → T012。US1 是最小预防闭环，完整交付包含三个故事。不同测试文件可独立准备；共享 shell 的改动顺序执行，避免保护块漂移。本次使用单代理，无需新技术研究或并行代理。

## Strategy

先准备能复现的回归，再实现足迹、清理、诊断与页面读回，最后在同一 PR 提交证据。测试任务完成后标记，不把质量检查表当作实现进度表。

## Phase 7: Authorized release and deployment — 2026-11-11

- [x] T013 更新发版规格/计划并通过 GitHub PR #166 合入 main，固定构建 SHA。
- [x] T014 构建并验证 linux/amd64 与 linux/arm64 镜像、两平台 Agent 与 SDK 下载校验和，发布固定标签。
- [x] T015 生产备份与回滚准备，更新中心镜像，核对配置/卷和健康。
- [x] T016 回读线上安装/卸载内容及恢复页面，记录脱敏验收证据并通过 GitHub PR 归档。
