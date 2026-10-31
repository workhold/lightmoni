# SDD 049 Web 验收

验收时间：2026-10-30。生产 Web 构建配合浏览器内 API fixtures，共 **13 组检查通过**，`pageerror=[]`、意外请求 `[]`。未访问生产平台或 vchive，未执行真实脚本。

## 检查与结果

- `npm run typecheck --prefix web`：通过。
- `npm run build --prefix web`：通过。保留已有依赖的 `use client` 与大分块提示，不影响构建。
- `node web/src/app/verify-default-tasks.mjs`：13 组通过。
- `git diff --check`：通过。

任务目录包含三条平台默认任务与既有用户任务；空拨测目标和日志目录显示“待配置”。模板页签、创建卡片、类型下拉、模板接口请求均已移除，旧模板 URL 回落任务定义。新建直接进入空白脚本编辑器。

平台默认任务没有删除、复制或脚本执行记录按钮，可停用、重新启用并修改原生参数。既有原生用户任务仍可编辑、删除，不提供复制；用户脚本仍可复制、确认删除，保留执行历史。每次写入都检查不含已移除的 `template_id`，且类型与来源符合 fixture 契约。

继续覆盖 SDD 048 的 UTF-8 文件导入、扩展名/大小/NUL 检查、覆盖确认、导入后编辑、手动/单次/间隔/日历计划、时区与未来时间预览、错误与陈旧预览清理、目标预览、v2 能力筛选、参数/目录无损保存、折叠高级参数保留、执行策略、提交前审阅和重复提交防护。主机原生任务参数覆盖仍可保存。英文 390px 检查来源、待配置状态、直接脚本入口及无页面横向溢出。

## 证据

- [机器可读结果](evidence/ui-report.json)
- [中文统一目录](evidence/default-tasks-directory-zh-1440.png)
- [中文脚本创建](evidence/default-tasks-zh-1440.png)
- [英文窄屏脚本创建](evidence/default-tasks-en-390.png)

以上截图已人工查看，暗色界面下内容与按钮可读。原 SDD 048 报告和证据未覆盖；旧 `verify-task-authoring.mjs` 入口委托当前 049 验收，避免继续断言已删除的模板设计。

## 验收边界

本报告证明浏览器交互与 Web 请求形状。默认任务数据库初始化/升级事务、重启持久化、服务端删除/来源/类型拒绝、Agent 自动匹配与实际执行由后端测试验证；fixture 重载不等同于数据库重启。未以浏览器 mock 结果替代这些证明。


## 原任务中心验收入口适配

`node web/src/app/verify-task-center.mjs` 另有17组全部通过，`pageerror=[]`、意外请求`[]`，见 [结果](evidence/task-center-report.json)。保留主机标签引用冲突、单机覆盖/恢复继承、派发版本冲突与重复确认、结果轮询/刷新、unknown人工确认结束、重试、AI提案审批及member只读（无SSH API或写请求）的原有覆盖。旧模板创建用例替换为默认不可删除/复制与直接脚本创建；原SDD043历史截图未改。当前脚本证据位于 evidence/task-center/。
