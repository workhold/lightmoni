# 实现计划

## 架构

```text
用户 → Mastra Assistant（对话、监控工具、编排）
          └─ code_task（管理员、用户选定的工作区）
               └─ 中心端 CodeTaskService → Pi Agent SDK 多轮执行
                    ├─ read / edit / write
                    ├─ 受范围约束的 find / ls / 字面内容搜索
                    └─ 服务端白名单检查命令（默认关闭）
```

Mastra 保持主入口；Pi 不替换 Mastra，也不进入 LightMoni Agent 执行节点。`runtime/src/assistant/code.ts` 隔离 Pi 适配，固定 SDK 1.3.0。`Agent` 管理内存工具循环，`ModelRuntime.registerProvider` 复用模型管理中的协议、模型、地址和密钥，无 Pi CLI、持久 Pi 会话或用户全局 auth 文件。

## 执行与权限

- `LIGHTMONI_CODE_WORKSPACE` 显式配置专用源码根目录才注册工具；仅管理员使用 HTTP 接口和模型工具。
- 网页选择相对工作区，服务端强制使用 `context.code_workspace`，模型不能切换到其他工作区；API 可直接指定根目录下的相对路径。
- 任务仅复制允许范围内的 UTF-8 文本；忽略依赖、产物、符号链接、`.env` 等常见凭据路径。默认全工作区，可通过 `allowed_paths` 收窄。
- 临时副本提供文件修改隔离，不是 OS 安全沙箱。命令默认关闭。运维人员通过 `LIGHTMONI_CODE_CHECK_COMMANDS` JSON 数组开放完整命令；请求只能取其子集。命令无 shell 解析，不继承服务凭据，HOME 为临时工作区内目录。
- 不复制 node_modules，不自动联网安装依赖。首期检查面向 `node --check app.js` 等无需额外依赖的命令；有复杂依赖或不可信执行需求时需另行容器化执行器。

## 生命周期与预算

默认 8 次模型请求，最多 12 次；最长 120 秒。调用前校验保守输入预算，每次输出遵循模型配置。最多同时 2 个代码任务，同一用户最多 1 个。取消、超时、服务退出会终止 Pi 和检查进程组；退出也等待应用操作完成，预检期间不接受新任务。

文本文件最多 2 MiB，工作区副本最多 64 MiB / 10000 项，变更前后文本合计最多 8 MiB，完整 diff 最多 256 KiB。超限或不支持的输出直接失败，不生成无法完整审阅的截断预览。工具回执只向 Mastra 返回 ID、状态和有界摘要；网页经鉴权 GET 获取完整 diff，避开原 128 KiB 工具管道限制。

## 持久化与应用

任务保存在助手 Store，中心使用 master key 加密源码预览与待应用内容；成功持久化后才公开可审批状态。重启将遗留 running 记录标为失败，待审批记录可继续读取。预览 30 分钟后不再允许应用；过期记录仍加密保存在本地数据库，自动归档清理留作后续维护能力。

应用前校验归属、期限、真实路径、符号链接及每个原文件内容哈希；相互包含的工作区应用互斥。同目录暂存完成再 rename，保留执行权限、避免硬链接外溢和写入失败截断原文件；多文件应用遇错尽力回滚。跨文件应用不是文件系统事务，应用过程中发生进程崩溃仍需人工核对。后续对话重新加载最新任务状态，避免模型继续引用旧审批状态。

## 协议与用量

Chat Completions / Responses / Anthropic Messages / Gemini 使用各自 Pi 适配器；Anthropic 消除 SDK 自带 `/v1/messages` 与已配置 `/v1` 的重复。OpenAI 和 Anthropic 使用受控 fetch 拒绝重定向，并在进入供应商 SDK 前校验 SSE，避免非法帧原文被打印；Pi Gemini 适配器暂不支持注入 fetch，沿用其原生传输。

每次 Pi 请求通过同一模型计费账本记录 `source=code-task`。只使用原始供应商计数，未报告计数保持未知；失败、取消和步骤上限不制造额外请求记录。费率沿用任务开始时的连接单价快照。

## 交付与验证

规格 → 契约和数据模型 → 受限执行器与 Mastra 工具 → API 和审批 UI → 真 Pi SDK 本地协议 fixture / 临时工作区 / 浏览器交互 → 全仓相关 typecheck、test、build → 独立 PR 到 main，不自动合并。
