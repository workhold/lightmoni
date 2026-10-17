# Mastra + Pi 代码任务界面证据

2026-10-18：通过真实网页和受控 API fixture 验证历史状态刷新、审批确认、工作区选择、成员权限及移动布局。桌面截图 `desktop.png`，390px 截图 `mobile.png`；均不包含真实凭据或用户源码。

复跑脚本：`scripts/verify-pi-code-ui.mjs`。先独立启动 Vite 18887，再从仓库根执行脚本；需要 Playwright 和 Chrome。脚本全部拦截 API，无模型请求或真实源码修改。

真实 Pi SDK 多轮、文件审批和协议测试见 `runtime/test/code-task.test.ts`；完整结果见 `specs/008-mastra-pi-agent-code-tasks/validation.md`。
