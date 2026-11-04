# Plan: 应用安装部署位置去重

1. `CatalogInstallFields.tsx` 默认补全先收集已选集群，只有唯一集群未被占用时才补全空白行，继续保留唯一在线机器补全。
2. 按可用集群数量约束新增部署行；`Form.List` 在自选模式验证集群唯一性，自动模式忽略未提交的位置草稿。
3. 高级部署字段与添加按钮使用同一个 Form.List 的 fields/add 和稳定 field.key；通过 React portal 保留高级面板里的既有视觉位置，避免列表外字段重新注册已移除数组索引。
4. `CatalogDrawer.tsx` 为后端 `duplicate_application_deployment` 提供中英文操作指引。
5. 真实 HTTP/SQLite 测试确认重复请求原子拒绝，合法多集群部署保留；独立 Playwright 脚本覆盖 Gitea 默认安装、刷新、增删与错误恢复。

兼容：无 API/数据迁移；保留后端唯一约束、未知结果栅栏和安装请求幂等标识。架构同步不适用，理由见规格。独立工作树基于已同步的 `origin/main`，不修改原工作区其他任务文件。
