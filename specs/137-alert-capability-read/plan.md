# 实施计划

## 1. 告警读取服务

- 新建 AlertReadService，迁移 alert-tools 的读取筛选、分页、publicAlertValue 和 32 KiB 有界投影。
- AlertCapabilities 继续负责真实目录和领域读取；AlertProposalService 继续负责 owner-bound 提案读取。
- publicAlertValue 移到领域读取模块并由原文件兼容导出，保持大整数十进制字符串语义。

## 2. 描述符与共享提案服务

- 保留 alerts_list 兼容目录；新增 rules_list/rules_get/silences_list/silences_get/groups_list/proposals_get。
- rules_get/proposals_get 要求 alerts.detail.read，其余要求 alerts.read；全部 allHosts=true。
- 应用装配共享同一个 AlertProposalService 给 Dispatcher 和 Assistant，避免不同读取/审批实例。
- 描述符角色允许 admin/member 的内部既有读取；外部 scopesForUser 不变。

## 3. 内部助手适配

- Dispatcher 增加六个旧名称适配器，按原外层结构返回。
- registerAssistant 在共享 Dispatcher 存在时过滤六个旧读取实现，仅保留原 propose_alert_change。
- 无 capabilities 的既有单元 fixture 继续使用 alertTools，行为不变。

## 4. 验证与交付

- 添加读取、筛选、分页、详情 Scope、owner、成员和 MCP 客户端测试。
- 复跑告警提案/应用、核心、描述符、遥测、MCP 和授权回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP、接入指南和工具矩阵，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #186/#187/#188，不合并。
