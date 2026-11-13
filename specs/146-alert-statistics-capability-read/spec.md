# 146 · 告警响应统计与 Slice 2 覆盖审计

状态：已实现，待 PR 审核。继承 SDD 046/047/134～145 和全平台能力开放 Goal，本切片补齐告警响应统计读取，并记录 Slice 2 覆盖/排除边界。当前 stacked 基线包含 SDD 138～145；PR #192～#199 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 将原 responseStatistics 的时间/分组/优先级筛选、去重、接手率和时长统计算法迁到 AlertReadService；原 HTTP 路由仅做参数与响应适配。
2. 新增 `alerts.statistics.read` 和 `lightmoni_alert_response_statistics_get`，内部新增 get_alert_response_statistics。
3. 统计为安装级高敏读取；有限主机不能调用，成员保留内部/Web 读取，外部 PAT/OAuth 仍管理员专用。
4. 保留原 from/to 默认窗口、20000 条上限、truncated、零通知成员和原定义文本，不修改真实告警或值班记录。
5. 记录 Slice 2 覆盖矩阵，区分已统一读取与后续独立提案、远程探针、长代码任务、恢复/卸载和秘密管理，不用工具数量冒充全部平台目标完成。
6. 不开放接手、确认、分配、重试、配置写入或任何执行。

## 验收

1. 原 response-statistics HTTP 回归和新能力统计结果一致，时间/筛选/截断语义不变。
2. 新 Scope、有限主机、成员与内部适配器有测试；官方 MCP 客户端可调用统计。
3. 覆盖矩阵明确剩余 Goal，不宣称 Slice 3/4/5 或全部目标完成。
4. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
