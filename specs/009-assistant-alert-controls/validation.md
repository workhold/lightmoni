# 验收记录

日期：2026-10-18；分支：`feat/assistant-alert-controls`。基于用户已合并的 PR #8，远端主干 `88b2108`。现有 `specs/006-execution-nodes/validation.md` 的未提交修改保留，不纳入本次交付。

## 验证范围

共享告警业务能力先提供规则/静默读取、规则修改和静默创建/更新/提前结束，再由 AI 助手注册读取及提案工具。提案不改变业务配置，用户在卡片回读、审阅并确认后才通过独立接口应用。

| 检查 | 结果 |
| --- | --- |
| `npm test` / runtime | 172 tests，169 pass，0 fail，3 skip |
| `npm test` / ai-runtime | 71 pass，0 fail |
| `npm test` / TypeScript SDK | 15 pass，0 fail |
| `npm run typecheck` | runtime、Mastra worker、web 通过 |
| `npm run build` | SDK、runtime、Mastra worker、web 通过 |
| 浏览器主流程与完成回执 | 12 组主流程及回执定向检查通过 |
| `git diff --check` 和文档本地链接 | 通过 |

合计 255 项测试通过，3 项已有外部环境测试跳过（真实 ClickHouse / Linux 双架构发布包）；本次未启用相应环境。最后的历史静默计时修复后重跑全仓测试，并再次完成 runtime typecheck/build。前端确认对话框截图增加动画完成、标题/按钮可见及实际可操作性校验；UI fixture 重跑后再次完成 web typecheck/build。生产构建只有现有 `use client`/chunk 提示。

## 业务与助手断言

- 规则创建/保存及原有临时静默 HTTP 委托共享业务层，保留 revision、来源表 AST 校验、状态重置、响应取消及通知队列副作用。
- 未来与周期静默提前结束后不会再次生效；实际结束时间为确认事务时刻，避免追溯改变确认前的静默期。
- 静默创建/更新必须有当前范围权限；用户离组或管理员降级后不能延长、改筛选或改原因，仍可结束自己创建的窗口。准备、重校验、提交均复核。
- 无 revision 的旧静默使用指纹版本检测直接更新；PUT 缺少版本被拒绝，显式匹配的整数 revision 和 version 可用。
- 提案加密持久化；SQLite 关闭重开可回读、应用和幂等重试。提案所有者与实际会话由主服务绑定，伪造 context 不授予权限。
- 权限变化、过期、旧版本、取消和非法输入不能修改业务。并发或重复确认只提交一次；审计持久化失败回滚规则、状态、副作用与提案状态，之后可重试。
- 创建时预留完整执行结果空间，避免接受无法保存完成回执的大提案。超出 JavaScript 安全整数范围的阈值和 SQL 参数在工具、预览、HTTP 回执中保持十进制字符串，业务对象仍保留精确原值。
- 模型只有 read/draft 工具，没有 apply、任意 API 或数据库写入工具。应用接口拒绝额外输入，登录和同源检查生效。他人提案返回 404。
- 每轮回读持久提案并向 system 注入最近 20 条可信状态；已压缩历史中的待确认摘要不能覆盖实际完成状态，更早 ID 可用只读工具核验。

`runtime/test/assistant-alerts.test.ts` 的真实默认 Mastra worker 经本地 SSE 供应商 fixture 执行 get rule → propose nested patch → final，3 次 HTTP 模型请求均计入用量；确认前规则不变，独立 HTTP 确认后回读阈值与启停结果。该测试验证实际工具循环和协议接线，不代表真实供应商的诊断质量。

## 浏览器

[验收证据与复跑命令](../../docs/evidence/assistant-alert-controls/README.md)。覆盖完整前后 SQL、时间、影响、GET 核验失败/过期/缺字段禁止确认、Modal 取消零 POST、连续点击仅一次 POST、409 后重新核验、历史 completed 无再次确认、390px 无横向溢出、成员权限、告警上下文及确认后的即时刷新。另验证提前结束静默的实际回执与完整生效配置。API 全由 fixture 拦截，零浏览器错误、零意外 API。

## Agent 部署设计

[SDD 010](../010-agent-deployment/spec.md) 与 [运维指南](../../docs/agent-deployment.md) 完成现状核对、独立 systemd 生命周期、非 root 权限、持久身份/队列、网络、安装、升级恢复与容器边界设计。实现和 Linux 双架构实机验收任务均保持未完成；本次没有安装、升级或部署 Agent。
