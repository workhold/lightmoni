# 实施计划

## 1. Dashboards 领域接口

- 将现有自定义列表、系统列表、详情和版本路由逻辑抽为公开方法。
- 原 load 路由转为共享 get；原版本路由转为共享 versions。
- DashboardReadService 提供搜索、分页、摘要和 60 KiB 详情边界。

## 2. 描述符与权限

- dashboards.list 使用 dashboards.read，返回摘要，不含 SQL。
- dashboards.get 使用 dashboards.detail.read，返回完整原生大盘。
- dashboards.versions 使用 dashboards.read，返回真实版本元数据。
- 全部 allHosts=true，admin/member 内部读取；外部 Scope 仍管理员专用。

## 3. 内部助手与 MCP

- Dispatcher 新增 list_dashboards/get_dashboard/get_dashboard_versions。
- 应用注入 DashboardReadService，既有 draft_dashboard 保持原实现。
- MCP 接入页增加两个 Scope 的中英文标签。

## 4. 验证与交付

- 添加真实目录/详情/版本、权限、大小、成员和官方 MCP 客户端测试。
- 复跑 domains、核心、描述符和其他已迁移领域回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #192～#195，不合并。
