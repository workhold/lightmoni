# 设计

真实只读证据：两个已卸载应用的当前实例为 removed，但旧实例为 retired=1/state=stopped/desired_state=removed；旧实例已有 current_machine_binding、container_count=0 的恢复审计。删除检查把它们当作真实停止容器。

未来已认证的空容器恢复直接记为 removed。兼容已有历史记录时，仅接受完成的恢复记录及成功的原始回执，绑定实例、旧/新 Agent 和机器，确认回执 absent=true/container_count=0；不存在当前执行、原 Agent 再上线、或机器绑定变化时仍须重新核对。删除继续使用现有事务、执行围栏及引用检查，不更改线上数据来绕过保护。

界面沿用 Ant Design 图标与现有主题。共享 IconAction 统一名称、Tooltip 和 32px 点击范围。卡片监控入口放在主要操作组；更多菜单使用省略号，菜单项继续用文字解释。新建保留工具提示，确认表单和引导说明保留文字。

不改既有布局体系，不新增主题或动效。使用隔离 HTTP fixture 检查路由、键盘、提示、菜单和确认；使用真实 Chrome 检查最终线上结果。
