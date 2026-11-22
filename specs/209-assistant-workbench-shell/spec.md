# SDD 209：AI 助手 Workbench Shell

## 背景

AI 助手已具备持久会话、分类、工具调用、大盘草稿、代码任务和 Agent 维护卡，但界面仍以单列聊天为主。用户难以同时查看上下文、工具证据和产物，也缺少稳定的任务头部、状态摘要与产物索引。

## 目标

1. 建立三栏 Workbench Shell：左侧会话，中间线程，右侧 Inspector。
2. Inspector 提供 `Context / Artifacts / Activity` 三个固定分区，可折叠且窄屏降级为抽屉。
3. 会话顶部显示模型、连接状态、运行状态、会话分类和上下文 chips。
4. 自动从最近 turns 提取只读产物索引：查询草稿、大盘草稿、代码任务、Agent 计划、SSH/主机证据。
5. 点击产物可在 Inspector 中查看摘要；大盘草稿和 SQL 可复用现有操作，不新增执行权限。
6. 移动端与 compact 模式保留现有消息流和 composer，Inspector 通过按钮打开。

## 非目标

- 不新增模型工具、后台任务协议、MCP 工具或任意执行权限。
- 不改变现有 SSE、审批、代码 apply、Agent 维护协议。
- 不承诺完整 diff viewer、任务 fork、跨会话重放或自动分类。
- 不用模型文本替代持久回执。

## 验收

1. 管理员桌面宽屏可见三栏 Workbench；中间线程最大宽度稳定，右侧 Inspector 可折叠。
2. Inspector Context 展示表、服务、时间、页面、代码工作区和截断状态。
3. Inspector Artifacts 能列出最近 turns 中的 SQL、Dashboard、Code task、Agent plan 和主机检查产物，点击后显示摘要与安全动作。
4. Inspector Activity 展示每个 turn 的状态、工具数量、用量和错误摘要。
5. compact / <=1000px 时 Inspector 默认隐藏，通过头部按钮打开 Drawer；会话与消息流仍可用。
6. 中英文文案、dark/light、横向溢出和浏览器基础交互通过。
