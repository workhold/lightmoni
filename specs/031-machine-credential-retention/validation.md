# 验收记录

日期：2026-10-28

交付：[GitHub PR #12](https://github.com/workhold/lightmoni/pull/12)，目标 `main`；创建前已同步远端主干，等待审核合入。

## 后端与真实 SSH 协议

- `runtime/test/managed-machines.test.ts`：28/28 通过。覆盖临时/托管/一次性 TTL、明确确认与权限、当前密文清空、首清除原因和事件幂等、无页面读取时的 30 秒清理、模块关闭、过期边界、旧 schema 两次重启迁移、密码摘要清理、Agent 激活按主机清理并保留托管、未激活保留临时凭据、清理不误取消运行中部署。
- `runtime/test/machine-terminal.test.ts`：12/12 通过，包含真实本机 sshd 私钥 PTY 与随机密码的隔离 ssh2 服务。过期凭据的密文确实清空；后续连接须添加新凭据，不能通过延长原日期恢复。测试清理关闭主机模块后再关闭数据库。
- runtime 全量：410 项，393 通过、17 项按环境条件跳过、0 失败。跳过项不计为已验证。
- runtime TypeScript 检查及构建、`git diff --check` 通过。

## 浏览器验收

- 新增 `web/src/app/verify-machine-credential-retention.mjs`：中英文共 18/18 通过，覆盖托管确认、切换清空秘密与期限、密码固定一次性、手动脚本无秘密、临时默认、历史策略和清除原因、密码-only 能力、操作后刷新、真实定时刷新、指纹/连接方式禁用说明。页面错误和意外请求均为 0；报告见 [credential-retention-ui-report.json](credential-retention-ui-report.json)。
- 既有 SSH 预检/删除/部署计划界面 18/18，真实 loopback 私钥终端 9/9，真实 loopback 密码终端 4/4 通过；终端释放后重新读取凭据和能力，不能复用消耗的密码。
- Web TypeScript 检查和生产构建通过。中英文托管表单、详情和列表截图保存在本地 `artifacts/screenshots/specs/031-machine-credential-retention/`；人工核对表单和详情布局、标签和警告展示正常，截图不含真实凭据。

## 架构同步

- 仓库更新 `docs/system-design.md` 第 13 节和 17.1 凭据矩阵。
- 通过 Doca Streamable HTTP MCP 读取并更新[系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，保留原生图和无关内容；保存后在最新版本逐一回读 6 段文字与 SSH 凭据表格，核对与仓库设计一致。
- 回读证据见 [doca-sync.json](doca-sync.json)，不含 token 或秘密。5 个原生图的 outline 未变化，本次没有修改图块。

## 兼容与边界

- 新 API 默认私钥从长期托管改为最多 1 小时临时保存；需要更长有效期必须明确选择 managed 并确认。既有有效托管私钥保持原期限，标记历史来源。
- 到期/撤销/消耗清空的是当前 SQLite 记录密文；不承诺擦除 WAL、空闲页、备份、已进入有界执行的进程副本或远端 authorized_keys。
- 本轮为隔离测试，没有修改线上主机/凭据、安装远端 Agent 或发布镜像。Agent 安装成功与失败联动使用受控模拟，不能视为新增生产安装验收。
