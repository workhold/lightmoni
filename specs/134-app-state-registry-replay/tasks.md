# 任务

- [x] T001 [US1] 在 `web/src/app/ops/model.ts` 区分待核实与待处理状态
- [x] T002 [US1] 在 `web/src/app/ops/InstalledApplications.tsx` 展示待核实状态和合理动作
- [x] T003 [US2] 在 `web/src/app/ops/RegistryImagesPanel.tsx` 为提权围栏错误提供主机执行记录入口
- [x] T004 [US3] 在 `runtime/src/agent/config.ts` 定义独立保留窗口与发送间隔默认值及校验
- [x] T005 [US3] 在 `runtime/src/agent/queue.ts` 批量清理过期待发送数据并保持 receipt 语义
- [x] T006 [US3] 在 `runtime/src/agent/agent.ts` 限制成功补传速率并记录过期计数
- [x] T007 [US3] 在 `runtime/src/agent/application-observer.ts` 限制 Docker 日志补采起点
- [x] T008 在 `runtime/test/agent.test.ts` 和相关 Web 检查中验证保留、速率和状态投影
- [x] T009 在 `docs/system-design.md`、Doca 同章节及 `specs/134-app-state-registry-replay/validation.md` 完成架构同步和回读
- [x] T010 同步远端主干、运行相关检查并提交功能分支 PR，记录兼容性与验证结果
- [x] T011 [US4] 修正应用页自动刷新与慢首屏请求的冲突，保持手动刷新与筛选语义
- [x] T012 [US4] 复用总览接口的资源读取结果，保留列表上限与总数
- [x] T013 [US4] 以超过轮询间隔的慢接口回归验证首屏加载

## 依赖

T001–T003 与 T004–T007 可独立设计；T008 在对应实现后执行；T009 在设计与实现稳定后执行；T010 最后执行。
