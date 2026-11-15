# 任务：应用总览加载与状态核对

## 规格先行

- [x] T001 写入 `spec.md`，固定慢首屏、状态证据、核对入口与不自动解围的验收边界。
- [x] T002 写入 `plan.md` 和 `contracts.md`，固定请求调度、总览响应兼容与 `unverified` 筛选契约。

## 加载与总览

- [x] T003 [US1] 在 `web/src/app/OperationsPage.tsx` 让自动轮询和窗口焦点跳过在途总览读取；手动刷新、范围变化和卸载正确取消旧请求，保留错误/加载处理。
- [x] T004 [US1] 在 `runtime/src/ops/index.ts` 使 `/ops/overview` 单次读取资源集合，复用过滤结果生成列表和 `total`，保持接口形状、排序、鉴权及 1000 条上限。
- [x] T005 [US1] 增加慢于轮询周期的真实页面/受控 API 回归及 Runtime 总览定向测试，覆盖自动轮询、焦点、显式替换、失败、单次资源读取和列表总数一致性。

## 状态与核对

- [x] T006 [US2] 在 `web/src/app/ops/model.ts` 仅按启用已发布集群投影状态；实例 `unknown` 或 `unresolved_run_id`、明确失败优先于保护态，运行中核对目标实例数、`ready_instances` 与已发布修订；覆盖 1/2 就绪、0 副本与 2→1 缩容、禁用/退休/移除实例边界，不把新配置说成已发布。
- [x] T007 [US2] 在 `InstalledApplications`、`OperationsPage` 与安装记录抽屉中统一状态和核对入口；所有需核对卡片只读打开原记录，不派发 `inspect`，历史列表缺失当前 `unresolved_run_id` 时按既有 ID 端点补读，优先未核对的当前 unknown 而非已核对的旧 unknown，手选记录不被轮询抢占；限制卡片部署/停止/卸载/升级/删除及抽屉写操作。
- [x] T008 [US2] 增加投影、筛选计数与核对动作回归：保护态、失败并存、1/2、0 和 2→1、禁用集群遗留实例、已退休及未退休已移除实例、新配置/旧发布版、实例未知、运行健康但日志作业 unknown、超过 100 条历史的定向补读；确认无新 `inspect`，已核对旧 unknown 不抢占默认记录。
- [x] T012 [US2] 在 Runtime 从未核对的当前 unknown 运行记录派生实例公开 `unresolved_run_id`；用户 `deploy|stop|remove|reconcile` 在修改部署意图或实例期望状态前拒绝未核对结果，服务自动恢复保持原机制。加入字段、人工核对清除及拒绝前后状态不变的回归。

## 验收与交付

- [x] T009 运行相关 Runtime/Web 类型检查、定向测试、Web 构建和差异检查，在 `validation.md` 记录结果、兼容影响与线上现场边界，不把本地夹具等同生产现场。
- [x] T010 同步 `docs/system-design.md` 第 162 章与 Doca 在线基线；保存后以最新版本回读目标文字、原生图节点和连线，在 `validation.md` 与 PR 记录证据。
- [x] T011 同步最新 `origin/main`、解决冲突，检查仅本 SDD 与实现范围；经 GitHub 功能分支创建面向 `main` 的 PR，写明最终行为、兼容影响、验证和架构判断。不直接推送或合并 `main`。

T003 与 T004 可并行；T006 与 T012 的摘要契约在 T007 前完成；T005/T008 在对应实现后执行；T010 完成后再交付 T011。
