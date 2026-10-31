# 验收

日期：2026-10-31。基于 GitHub `origin/main`（`334df47`），本地分支 `codex/053-certificate-async-issuance`。

## 行为与证据

- 真实 HTTP Router/Auth/SQLite：ACME 注册被 gate 挂起时，新建返回 201，资源为 issuing、run 为 running；日志已可读。重复手动申请返回同一执行。失败后手动申请返回新的 202 后台执行；编辑不重新申请，成员不能读取日志，非法游标被拒绝。
- 真实证书控制器及本地 CA/DNS 夹具：账号、CSR/订单、DNS 写入与回读、传播次数、挑战、签署、下载、清理、材料保存依次记录。自签、上传、续期、目录/云/脚本分发和网站首次 HTTPS 的原有集成检查通过。
- 失效 ACME 订单保留 CA 拒绝原因并标记 invalid。注入 ACME DNS problem（NXDOMAIN、problem type、HTTP 400）与后续 DNS 清理拒绝：主要原因仍指向 challenge_verify，清理失败单列；不再丢失成只有通用错误码。凭据、EAB、TXT/token、私钥、URL 查询以及伪装成 code/request ID 的秘密均不进入公开回执或日志。
- 初次意图在中心重启后运行一次，auto_renew=false 不阻止首轮申请；已开始的执行重启标 unknown，不重放。即使回执超出最近 100 条列表，证书状态仍能恢复为 unknown 并保留旧材料。内部调用等待同一个后台执行完成，不重复申请。
- 系统日志：SQLite 步骤和 outbox 同事务回滚，白名单阶段/域名/错误元数据投递后可关联 run_id；重复投递不重复记录。实时抽屉不依赖 ClickHouse。
- 浏览器采用真实 loopback Router/SQLite，只有 ACME/DNS 对端为夹具：新建立即关闭、申请中状态、图标日志、实时失败、手动申请、切换历史、中英文/390px 窄屏与旧记录解释共 7 项通过，无 pageerror。截图已实际回看；移动抽屉限制到视口宽度。报告见 [evidence/ui-report.json](evidence/ui-report.json)，复现：`node web/src/app/ops/verify-certificate-async-ui.mjs`。

## 检查

- `npm --prefix runtime run typecheck` 与 `npm --prefix runtime run build`：通过。
- `npm --prefix web run build`：通过（包含 TypeScript build；仅已有第三方 use-client 指令警告）。
- 在 runtime 目录执行 `node --import tsx --test --test-concurrency=1 test/platform-api.test.ts test/platform-store.test.ts test/platform-cloud-certificates.test.ts test/application-observability.test.ts`：57 项通过，0 失败。
- 全量 `npm --prefix runtime test`：775 项，754 通过、21 项按环境条件跳过，0 失败。机器可读汇总见 [evidence/checks.json](evidence/checks.json)。
- `git diff --check`：通过；提交前再次 fetch 主干，无待合并主干提交。

## 架构与边界

架构影响适用。仓库 33.2–33.5、44.5、第 53 章与 Doca 同步；Doca 已保存并用最新版本回读全部目标文本和原生图（12 节点/12 连线），原有第 33 章图完整结构保持一致，其他图块未编辑。详情见 [doca-sync.md](doca-sync.md) 和 [doca-readback.json](doca-readback.json)。

测试未操作用户的生产域名、实际 CA 订单或 DNS。截图中的旧执行只保存 acme_issuance_failed，无法从旧回执恢复实际原因；本次修复后续执行的诊断保留，不声称已经确认或解决该生产域名的 CA/DNS 配置原因。需要更新中心和 Web 才生效；不要求更新 Agent。
