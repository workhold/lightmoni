# 验收记录

日期：2026-10-18。分支：`feat/mastra-pi-code-tasks`，基于最新 `origin/main`（包含已合入的 #7）。供应商均使用本地受控协议 fixture，不消耗真实模型费用。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | runtime、Mastra worker、web 全部通过 |
| `npm run build` | SDK、runtime、Mastra worker、web 生产构建通过 |
| `npm test` / runtime | 154 tests，151 pass，0 fail，3 skip |
| `npm test` / ai-runtime | 71 pass，0 fail |
| `npm test` / TypeScript SDK | 15 pass，0 fail |
| `git diff --check` | 通过 |
| 浏览器代码任务交互 | 7 组通过，pageerror=0、意外 API=0 |

runtime 的 3 项跳过为已有真实 ClickHouse 和 Linux 双架构发布包环境用例，本次未启用相应外部环境。生产构建保留现有 `use client` 指令和大 chunk 提示，无编译失败。

## 真 Pi SDK / 临时工作区

`runtime/test/code-task.test.ts` 共 40 项（含子用例），直接执行真实 Pi Agent、coding tools 和原生 provider adapter。

- 六次真实 HTTP 请求完成：read → edit 产生坏语法 → node --check 失败 → edit 修复 → node --check 成功 → 完成回答。工具结果进入下一轮模型上下文，检查记录按 toolCallId 关联。
- 原工作区在审批前字节不变。SQLite 关闭重开后可查询、审批、幂等重试；其他用户不可读取/应用，过期和内容冲突不允许应用。
- 硬链接外部文件不被修改，执行权限保留；持久化失败不暴露可审批内存状态，应用记录失败回滚源码且允许重试。
- 相同及父子工作区并发应用互斥。符号链接替换、越界路径、凭据文件、未授权命令和 shell 元字符被拒绝；二进制输出不会误变为文件删除。
- 活跃取消、请求取消、1 秒超时、关闭预检竞态、最终整理阶段取消状态一致。模型 401、非法 SSE、输出截断和步骤超限均失败并丢弃未批准修改。
- 第 3 次模型调用在 2 步上限下不会发送 HTTP；对应的用量终态也不重复计数。
- Chat `/tenant/v1/chat/completions`、Responses `/tenant/v1/responses`、Anthropic `/tenant/v1/messages`、Gemini `/tenant/v1beta/models/fixture:streamGenerateContent` 的路径、认证和请求体经真实适配器验证。
- 四协议逐请求 usage 计入回调；未报告 usage 保持未知；Anthropic 缓存输入和增量输出累计正确。未知工具名称包含配置 key 时不会进入外部结果。

`runtime/test/assistant.test.ts` 另验证未配置工作区时 503、管理员边界、模型无法切换用户工作区、非法限制输入、摘要收据低于 128 KiB，以及审批后后续对话重新读取 completed 状态（保持紧凑回执，不重新注入大 diff）。

## 浏览器

可复跑：先执行 `npm --prefix web run dev -- --host 127.0.0.1 --port 18887 --strictPort`，再从仓库根目录运行 `node scripts/verify-pi-code-ui.mjs`。需要本机安装 Playwright 支持的 Chrome；所有 API 都由脚本 fixture 拦截，不接触真实模型或源码。可通过 `LIGHTMONI_TEST_BASE_URL`、`LIGHTMONI_TEST_OUTPUT` 覆盖地址及证据目录。

验证历史已完成任务不显示审批、GET 失败时禁止应用、步骤/检查/diff 独立展示、Modal 确认前零 POST/确认后仅一次、相对工作区发送、390px 页面无横向溢出、成员隐藏代码入口且零代码 API。截图见 `docs/evidence/pi-code-tasks/`。

## 交付边界

功能默认关闭，需运维显式配置专用工作区；仅管理员使用。检查命令默认关闭，不安装依赖，隔离副本不提供 OS 沙箱或网络隔离。多文件应用不是跨文件崩溃事务，过期加密记录暂不自动清理。本次没有调用真实付费供应商、修改生产源码或执行远端部署。代码通过独立 PR 审阅，不自动合并。
