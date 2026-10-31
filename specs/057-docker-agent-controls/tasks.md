# 任务

## 规格与基础
- [x] T001 在 specs/057-docker-agent-controls/{spec.md,plan.md,contracts/README.md,tasks.md} 固化范围、设计与契约。
- [x] T002 在 runtime/src/agent/docker.ts 与 runtime/src/shared/application-observation.ts 实现清单、诊断和动作约束。
## US1
- [x] T003 [US1] 在 runtime/src/agent/application-observer.ts、agent.ts 分离快速清单和周期遥测并保留错误与旧数据。
## US2
- [x] T004 [US2] 在 runtime/src/agent/jobs.ts、server/agent-jobs.ts 集成 Docker 任务和已验证回执。
- [x] T005 [US2] 在 runtime/src/ops/docker.ts、observability.ts、index.ts 实现管理员 API、幂等及清单合并。
- [x] T006 [US2] 在 web/src/app/ops/HostInventory.tsx 实现即时采集和任务轮询。
## US3
- [x] T007 [US3] 在 runtime/src/agent/docker.ts 与 web/src/app/ops/HostInventory.tsx 实现确认后启动/停止/重启和操作后验证。
## 验收与交付
- [x] T008 在 runtime/test/docker-controls.test.ts 覆盖认证、主机绑定、幂等、过期、诊断及执行回执；完成类型检查和相关回归。
- [x] T009 在 docs/system-design.md 和 Doca 同步设计、回读文本及原生图，记录 specs/057-docker-agent-controls/validation.md。
- [ ] T010 更新 specs/057-docker-agent-controls/validation.md，记录 UI/真实 Docker 验收及限制，提交功能分支和面向 main 的 GitHub PR。

依赖：T001→T002→T003/T004→T005→T006/T007→T008→T009→T010。单 Agent 顺序实施。
